import {
  getSupportedThinkingLevels,
  StringEnum,
  type Usage,
} from "@earendil-works/pi-ai";
import { minimatch } from "minimatch";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  delegateConfigLoader,
  PROFILE_NAMES,
  type DelegateProfileConfig,
  type ProfileName,
  type ResolvedDelegateConfig,
} from "./config.ts";
import {
  createRpcWorker,
  sumUsage,
  type RpcEvent,
  type RpcWorker,
} from "./rpc-worker.ts";
import {
  createRpcUiDialogQueue,
  type RpcUiDialogQueue,
} from "./ui-dialog-queue.ts";

type TaskRequest = {
  task: string;
  profile?: ProfileName;
  modelSet?: string;
};

type ModelSetSource = "task" | "parent-model" | "default" | "none";

type RoutedTask = {
  task: string;
  profile: ProfileName;
  modelSet?: string;
  modelSetSource: ModelSetSource;
  model?: string | null;
  thinkingLevel?: DelegateProfileConfig["thinkingLevel"];
};

type WorkerState = {
  id: string;
  task: string;
  profile: ProfileName;
  modelSet?: string;
  model?: string | null;
  thinkingLevel?: DelegateProfileConfig["thinkingLevel"];
  status: string;
  latestMessage: string;
  output: string;
  worker: RpcWorker;
  abortController: AbortController;
  cancelRequested: boolean;
};

type WorkerUiState = "starting" | "working" | "synthesizing" | "done" | "cancelled" | "error";

const WORKER_STATE_STYLES = {
  starting: { icon: "", fg: "muted" },
  working: { icon: "", fg: "accent" },
  synthesizing: { icon: "", fg: "warning" },
  done: { icon: "", fg: "success" },
  cancelled: { icon: "", fg: "warning" },
  error: { icon: "", fg: "error" },
} as const;

type DelegatedResult = {
  id: string;
  task: string;
  profile: ProfileName;
  modelSet?: string;
  modelSetSource: ModelSetSource;
  model?: string | null;
  thinkingLevel?: DelegateProfileConfig["thinkingLevel"];
  ok: boolean;
  cancelled: boolean;
  output: string;
  rawOutput: string;
  summaryOutput: string;
  durationMs: number;
  usage: Usage;
};

const DEFAULT_TOOLS = ["read", "write", "edit", "bash"];
const DEFAULT_MAX_WORKERS = 5;

function getWorkerTools(): string[] {
  const raw = process.env.PI_DELEGATE_TOOLS?.trim();
  if (!raw) return DEFAULT_TOOLS;
  const tools = raw
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : DEFAULT_TOOLS;
}

function getMaxWorkers(): number {
  const raw = Number(process.env.PI_DELEGATE_MAX_WORKERS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_MAX_WORKERS;
}

export function normalizeWorkerId(text: string): string | undefined {
  const match = text.trim().match(/^(?:w)?([1-9]\d*)$/i);
  return match ? `w${match[1]}` : undefined;
}

export function requestWorkerCancellation(state: {
  abortController: AbortController;
  cancelRequested: boolean;
}): boolean {
  if (state.cancelRequested) return false;
  state.cancelRequested = true;
  state.abortController.abort();
  return true;
}

export function selectAutomaticModelSet(
  model: { provider: string; id: string } | undefined,
  config: ResolvedDelegateConfig,
): { modelSet?: string; source: Exclude<ModelSetSource, "task"> } {
  if (model) {
    const modelId = `${model.provider}/${model.id}`;
    for (const route of config.parentModelRoutes) {
      if (route.models.some((pattern) => minimatch(modelId, pattern))) {
        return { modelSet: route.modelSet, source: "parent-model" };
      }
    }
  }
  return config.defaultModelSet === undefined
    ? { source: "none" }
    : { modelSet: config.defaultModelSet, source: "default" };
}

export function formatModelSetNotification(
  previous: string | undefined,
  next: string | undefined,
  initialized: boolean,
): string | undefined {
  const nextLabel = next ?? "baseline";
  if (!initialized) {
    return next === undefined ? undefined : `Delegate model set: ${nextLabel}`;
  }
  if (previous === next) return undefined;
  return `Delegate model set changed: ${previous ?? "baseline"} → ${nextLabel}`;
}

export function routeTasks(
  ctx: ExtensionContext,
  tasks: TaskRequest[],
  config: ResolvedDelegateConfig,
): RoutedTask[] {
  return tasks.map((request) => {
    const profile = request.profile ?? config.defaultProfile;
    const automatic = selectAutomaticModelSet(ctx.model, config);
    const override = request.modelSet?.trim() || undefined;
    const modelSet = override ?? automatic.modelSet;
    const modelSetSource: ModelSetSource = override === undefined
      ? automatic.source
      : "task";
    if (modelSet !== undefined && !Object.hasOwn(config.modelSets, modelSet)) {
      const available = Object.keys(config.modelSets);
      throw new Error(
        `delegate-workers task model set not found: ${modelSet}; available: ${available.join(", ") || "none"}`,
      );
    }

    const profileConfig = {
      ...config.profiles[profile],
      ...config.modelSets[modelSet ?? ""]?.profiles?.[profile],
    };
    const routed: RoutedTask = {
      task: request.task,
      profile,
      ...(modelSet === undefined ? {} : { modelSet }),
      modelSetSource,
      ...profileConfig,
    };

    if (typeof routed.model === "string") {
      const separator = routed.model.indexOf("/");
      const provider = routed.model.slice(0, separator);
      const modelId = routed.model.slice(separator + 1);
      const model = ctx.modelRegistry.find(provider, modelId);
      if (!model) {
        throw new Error(
          `delegate-workers profile ${profile}: model not found: ${routed.model}`,
        );
      }
      if (typeof routed.thinkingLevel === "string") {
        const supported = getSupportedThinkingLevels(model);
        if (!supported.includes(routed.thinkingLevel)) {
          throw new Error(
            `delegate-workers profile ${profile}: ${routed.model} does not support thinking level ${routed.thinkingLevel}; supported: ${supported.join(", ")}`,
          );
        }
      }
    }

    return routed;
  });
}

function buildWorkerPrompt(task: string, sharedContext?: string): string {
  return [
    "You are a focused delegated worker inside a codebase.",
    "",
    "Rules:",
    "- stay tightly scoped to the assigned task",
    "- use only the available tools",
    "- cite concrete file paths when possible",
    "- briefly state what you are currently working on before each new investigation step; these progress messages are shown live to the parent",
    "- gather the evidence you need, then stop; a separate synthesis pass will follow",
    ...(sharedContext ? ["", "Shared context:", sharedContext] : []),
    "",
    "Assigned task:",
    task,
  ].join("\n");
}

function buildSummaryPrompt(task: string): string {
  return [
    "Compress your findings for the parent agent.",
    `Task: ${task}`,
    "",
    "Return a compact report using exactly these sections:",
    "Summary:",
    "- 1-2 bullets with the main conclusion",
    "Evidence:",
    "- 2-4 bullets with concrete file paths, symbols, or facts",
    "Next steps:",
    "- 0-2 bullets only if genuinely useful",
    "",
    "Be terse and high-signal. No preamble.",
  ].join("\n");
}

function truncateFallback(text: string, maxChars = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n[truncated before returning to parent agent]`;
}

function configuredValue(value: string | null | undefined): string {
  if (typeof value === "string") return value;
  return value === null ? "pi-default" : "worker-startup";
}

function formatResults(results: DelegatedResult[]): string {
  return results
    .map((result) => {
      const header = `## ${result.id} — ${result.task}`;
      const status = result.cancelled ? "cancelled" : result.ok ? "ok" : "error";
      const body = result.output.trim() || "(no output)";
      return [
        header,
        "",
        `status: ${status}`,
        `profile: ${result.profile}`,
        `model_set: ${result.modelSet ?? "baseline"}`,
        `model_set_source: ${result.modelSetSource}`,
        `model: ${configuredValue(result.model)}`,
        `thinking: ${configuredValue(result.thinkingLevel)}`,
        `duration_ms: ${result.durationMs}`,
        "",
        body,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function getWorkerUiState(status: string): WorkerUiState {
  if (status === "synthesizing") return "synthesizing";
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (status === "error") return "error";
  if (status === "starting") return "starting";
  return "working";
}

function compactActivity(text: string, maxChars = 140): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

export function describeWorkerTool(event: RpcEvent): string {
  const args = event.args ?? {};
  const value = (key: string) => typeof args[key] === "string" ? compactActivity(args[key]) : "";
  switch (event.toolName) {
    case "read": return `Reading ${value("path") || "a file"}`;
    case "write": return `Writing ${value("path") || "a file"}`;
    case "edit": return `Editing ${value("path") || "a file"}`;
    case "bash": return `Running ${value("command") || "a command"}`;
    case "grep": return `Searching for ${value("pattern") || "matches"}`;
    case "find": return `Finding ${value("pattern") || "files"}`;
    default: return `Using ${event.toolName || "a tool"}`;
  }
}

export function formatWorkerDisplayLines(
  label: string,
  task: string,
  latestMessage: string,
): [string, string] {
  return [
    `${label} Goal: ${compactActivity(task)}`,
    `  Now: ${compactActivity(latestMessage)}`,
  ];
}

function refreshUi(ctx: ExtensionContext, workers: Map<string, WorkerState>) {
  if (workers.size === 0) {
    ctx.ui.setWidget("delegate-workers", undefined);
    return;
  }

  const widgetLines = [...workers.values()].flatMap((worker) => {
    const uiState = getWorkerUiState(worker.status);
    const style = WORKER_STATE_STYLES[uiState];
    const label = ctx.ui.theme.fg(style.fg, `${style.icon} ${worker.id} [${worker.profile}]`);
    return formatWorkerDisplayLines(label, worker.task, worker.latestMessage);
  });
  ctx.ui.setWidget("delegate-workers", widgetLines, { placement: "aboveEditor" });
}

async function runTask(
  ctx: ExtensionContext,
  workers: Map<string, WorkerState>,
  task: RoutedTask,
  id: string,
  options: {
    signal?: AbortSignal;
    sharedContext?: string;
    uiDialogQueue: RpcUiDialogQueue;
    reportInputStatus: (active: boolean, label?: string) => void;
  },
): Promise<DelegatedResult> {
  const abortController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal;
  const worker = createRpcWorker({
    cwd: ctx.cwd,
    tools: getWorkerTools(),
    model: task.model,
    thinkingLevel: task.thinkingLevel,
    ui: ctx.ui,
    uiPrefix: id,
    uiDialogQueue: options.uiDialogQueue,
    reportInputStatus: options.reportInputStatus,
  });
  const state: WorkerState = {
    id,
    task: task.task,
    profile: task.profile,
    modelSet: task.modelSet,
    model: task.model,
    thinkingLevel: task.thinkingLevel,
    status: "starting",
    latestMessage: `Starting: ${task.task}`,
    output: "",
    worker,
    abortController,
    cancelRequested: false,
  };

  workers.set(id, state);
  refreshUi(ctx, workers);
  const startedAt = Date.now();

  const onEvent = (event: RpcEvent) => {
    if (event.type === "message_start" && event.message?.role === "assistant") {
      state.latestMessage = "Thinking about the next step";
      refreshUi(ctx, workers);
      return;
    }

    if (event.type === "agent_start") {
      state.status = "running";
      state.latestMessage = `Investigating: ${task.task}`;
      refreshUi(ctx, workers);
      return;
    }

    if (event.type === "tool_execution_start") {
      state.status = `tool:${event.toolName}`;
      state.latestMessage = describeWorkerTool(event);
      refreshUi(ctx, workers);
      return;
    }

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      state.output += event.assistantMessageEvent.delta;
      if (state.latestMessage === "Thinking about the next step") state.latestMessage = "";
      state.latestMessage += event.assistantMessageEvent.delta;
      refreshUi(ctx, workers);
      return;
    }

    if (event.type === "agent_end") {
      state.status = "done";
      refreshUi(ctx, workers);
    }
  };

  const resultBase = {
    id,
    task: task.task,
    profile: task.profile,
    modelSet: task.modelSet,
    modelSetSource: task.modelSetSource,
    model: task.model,
    thinkingLevel: task.thinkingLevel,
  };

  try {
    const investigation = await worker.prompt(
      buildWorkerPrompt(task.task, options.sharedContext),
      {
        onEvent,
        signal,
      },
    );

    state.status = "synthesizing";
    state.latestMessage = "Synthesizing findings";
    state.output = "";
    refreshUi(ctx, workers);

    let summaryText = truncateFallback(investigation.text);
    try {
      const summary = await worker.prompt(buildSummaryPrompt(task.task), {
        signal,
        onEvent: (event: RpcEvent) => {
          if (event.type === "message_start" && event.message?.role === "assistant") {
            state.latestMessage = "Synthesizing findings";
            refreshUi(ctx, workers);
            return;
          }

          if (event.type === "agent_start") {
            state.status = "synthesizing";
            state.latestMessage = "Synthesizing findings";
            refreshUi(ctx, workers);
            return;
          }

          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta"
          ) {
            state.output += event.assistantMessageEvent.delta;
            if (state.latestMessage === "Synthesizing findings") state.latestMessage = "";
            state.latestMessage += event.assistantMessageEvent.delta;
            refreshUi(ctx, workers);
            return;
          }

          if (event.type === "agent_end") {
            state.status = "done";
            refreshUi(ctx, workers);
          }
        },
      });

      summaryText = summary.text.trim() || summaryText;
    } catch (error) {
      if (signal.aborted) throw error;
      state.output = summaryText;
    }

    state.output = summaryText;
    state.latestMessage = "Done";
    state.status = "done";
    refreshUi(ctx, workers);

    return {
      ...resultBase,
      ok: true,
      cancelled: false,
      output: summaryText,
      rawOutput: investigation.text,
      summaryOutput: summaryText,
      durationMs: Date.now() - startedAt,
      usage: worker.getUsage(),
    };
  } catch (error) {
    const cancelled = state.cancelRequested;
    const message = cancelled
      ? `Worker ${id} was cancelled.`
      : error instanceof Error ? error.message : String(error);
    state.status = cancelled ? "cancelled" : "error";
    state.latestMessage = cancelled ? "Cancelled" : `Error: ${message}`;
    refreshUi(ctx, workers);

    return {
      ...resultBase,
      ok: false,
      cancelled,
      output: message,
      rawOutput: message,
      summaryOutput: message,
      durationMs: Date.now() - startedAt,
      usage: worker.getUsage(),
    };
  } finally {
    worker.dispose();
    workers.delete(id);
    refreshUi(ctx, workers);
  }
}

export default function delegateWorkersExtension(pi: ExtensionAPI) {
  const workers = new Map<string, WorkerState>();
  const uiDialogQueue = createRpcUiDialogQueue();
  let nextWorkerId = 1;
  let inferredModelSetInitialized = false;
  let inferredModelSet: string | undefined;

  const makeWorkerId = () => `w${nextWorkerId++}`;
  const reportInputStatus = (active: boolean, label?: string) => {
    pi.events.emit("herdr:blocked", { active, label });
  };
  const notifyModelSet = (
    ctx: ExtensionContext,
    config: ResolvedDelegateConfig,
    model: { provider: string; id: string } | undefined,
  ) => {
    const next = selectAutomaticModelSet(model, config).modelSet;
    const message = formatModelSetNotification(
      inferredModelSet,
      next,
      inferredModelSetInitialized,
    );
    inferredModelSetInitialized = true;
    inferredModelSet = next;
    if (message && ctx.hasUI) {
      setTimeout(() => ctx.ui.notify(message, "info"), 0);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshUi(ctx, workers);
    delegateConfigLoader.invalidate();
    try {
      const loaded = await delegateConfigLoader.load(ctx);
      notifyModelSet(ctx, loaded.config, ctx.model);
      if (loaded.warnings.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `delegate-workers config warnings:\n${loaded.warnings.join("\n")}`,
          "warning",
        );
      }
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    }
  });

  pi.on("model_select", async (event, ctx) => {
    try {
      const loaded = await delegateConfigLoader.load(ctx);
      notifyModelSet(ctx, loaded.config, event.model);
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    }
  });

  pi.on("session_shutdown", async () => {
    for (const worker of workers.values()) {
      worker.worker.dispose();
    }
    workers.clear();
  });

  pi.registerCommand("cancel-worker", {
    description: "Cancel one running delegate worker by ID",
    getArgumentCompletions: (prefix) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      const items = [...workers.keys()]
        .filter((id) =>
          id.toLowerCase().startsWith(normalizedPrefix) ||
          id.slice(1).startsWith(normalizedPrefix)
        )
        .map((id) => ({ value: id.slice(1), label: id }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const id = normalizeWorkerId(args);
      if (!id) {
        ctx.ui.notify("Usage: /cancel-worker <worker-id>", "warning");
        return;
      }

      const state = workers.get(id);
      if (!state || state.cancelRequested) {
        const active = [...workers.keys()];
        const suffix = active.length > 0
          ? ` Active workers: ${active.join(", ")}.`
          : " No workers are currently running.";
        ctx.ui.notify(`Worker ${id} is not running.${suffix}`, "warning");
        return;
      }

      requestWorkerCancellation(state);
      state.status = "cancelled";
      state.latestMessage = "Cancelling";
      refreshUi(ctx, workers);
      ctx.ui.notify(`Cancelling worker ${id}...`, "info");
    },
  });

  const taskSchema = Type.Object({
    task: Type.String({ description: "Focused task for one delegated worker" }),
    profile: Type.Optional(
      StringEnum(PROFILE_NAMES, {
        description:
          "fast for lookups and summaries; balanced for routine multi-file work; deep for architecture, security, migrations, or ambiguous root causes",
      }),
    ),
    modelSet: Type.Optional(
      Type.String({
        description:
          "Optional configured model set override. Leave out to infer from the current parent model; empty values also use automatic routing.",
      }),
    ),
  });

  pi.registerTool({
    name: "delegate_tasks",
    label: "Delegate Tasks",
    description:
      "Run multiple focused tasks in parallel using agent-selected configured worker profiles",
    promptSnippet:
      "Run independent tasks in parallel and select fast, balanced, or deep worker profiles based on complexity.",
    promptGuidelines: [
      "Use delegate_tasks for independent subtasks that can run in parallel.",
      "For delegate_tasks, select profile fast for lookups, searches, summaries, and isolated checks; balanced for multi-file tracing, routine changes, and test diagnosis; deep for architecture, security, migrations, and ambiguous root causes.",
      "For delegate_tasks, leave modelSet out of each task unless the user requests a configured routing override or an independent model family. The tool selects the model set from the active parent model automatically.",
      "Workers use pi's normal tool set by default (read, write, edit, bash), and can be reconfigured via PI_DELEGATE_TOOLS.",
      "Only delegate tasks that fit the currently configured worker tool allowlist; use PI_DELEGATE_TOOLS=read,grep,find,ls for read-only workers.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(taskSchema, {
        minItems: 1,
        maxItems: getMaxWorkers(),
      }),
      sharedContext: Type.Optional(
        Type.String({
          description: "Extra context to prepend to each worker task",
        }),
      ),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object" || Array.isArray(args)) return args as any;
      const input = args as { tasks?: unknown };
      if (!Array.isArray(input.tasks)) return args as any;
      return {
        ...input,
        tasks: input.tasks.map((task) =>
          typeof task === "string" ? { task } : task,
        ),
      } as any;
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const maxWorkers = getMaxWorkers();
      if (params.tasks.length > maxWorkers) {
        throw new Error(`Too many tasks. Max is ${maxWorkers}.`);
      }

      const loaded = await delegateConfigLoader.load(ctx);
      const tasks = routeTasks(ctx, params.tasks, loaded.config);
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Launching ${tasks.length} delegate worker(s)...`,
          },
        ],
        details: {},
      });

      const results = await Promise.all(
        tasks.map((task) =>
          runTask(ctx, workers, task, makeWorkerId(), {
            signal,
            sharedContext: params.sharedContext,
            uiDialogQueue,
            reportInputStatus,
          }),
        ),
      );

      const combined = formatResults(results);
      const failed = results.filter((result) => !result.ok).length;
      const cancelled = results.filter((result) => result.cancelled).length;
      const usage = sumUsage(results.map((result) => result.usage));

      return {
        content: [{ type: "text", text: combined }],
        usage,
        details: {
          taskCount: results.length,
          failedTasks: failed,
          cancelledTasks: cancelled,
          routes: results.map((result) => ({
            id: result.id,
            profile: result.profile,
            modelSet: result.modelSet,
            modelSetSource: result.modelSetSource,
            model: result.model,
            thinkingLevel: result.thinkingLevel,
            usage: result.usage,
          })),
        },
      };
    },
  });
}
