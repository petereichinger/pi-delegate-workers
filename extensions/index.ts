import {
  getSupportedThinkingLevels,
  StringEnum,
} from "@earendil-works/pi-ai";
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
  type RpcEvent,
  type RpcWorker,
} from "./rpc-worker.ts";
import {
  DelegationSession,
  type DelegationBatchSnapshot,
  type DelegationTaskState,
  type DelegationWaitMode,
} from "./delegation-session.ts";
import {
  createRpcUiDialogQueue,
  type RpcUiDialogQueue,
} from "./ui-dialog-queue.ts";

type TaskRequest = {
  task: string;
  profile?: ProfileName;
};

type RoutedTask = {
  task: string;
  profile: ProfileName;
  model?: string | null;
  thinkingLevel?: DelegateProfileConfig["thinkingLevel"];
};

type ScheduledTask = RoutedTask & {
  sharedContext?: string;
};

type WorkerState = {
  id: string;
  task: string;
  profile: ProfileName;
  model?: string | null;
  thinkingLevel?: DelegateProfileConfig["thinkingLevel"];
  status: string;
  latestMessage: string;
  output: string;
  worker?: RpcWorker;
};

type WorkerUiState = "queued" | "starting" | "working" | "synthesizing" | "done" | "cancelled" | "error";

const WORKER_STATE_STYLES = {
  queued: { icon: "", fg: "muted" },
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
  model?: string | null;
  thinkingLevel?: DelegateProfileConfig["thinkingLevel"];
  ok: boolean;
  cancelled: boolean;
  output: string;
  rawOutput: string;
  summaryOutput: string;
  durationMs: number;
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

export function parseCommandTasks(text: string): TaskRequest[] {
  return text
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^\[(fast|balanced|deep)\]\s*(.*)$/s);
      return match
        ? { task: match[2]!.trim(), profile: match[1] as ProfileName }
        : { task: part };
    })
    .filter((task) => task.task.length > 0);
}

export function routeTasks(
  ctx: ExtensionContext,
  tasks: TaskRequest[],
  config: ResolvedDelegateConfig,
): RoutedTask[] {
  return tasks.map((request) => {
    const profile = request.profile ?? config.defaultProfile;
    const profileConfig = config.profiles[profile];
    const routed: RoutedTask = {
      task: request.task,
      profile,
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
        `model: ${configuredValue(result.model)}`,
        `thinking: ${configuredValue(result.thinkingLevel)}`,
        `duration_ms: ${result.durationMs}`,
        "",
        body,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function formatBatchStatus(
  batch: DelegationBatchSnapshot<ScheduledTask, DelegatedResult>,
): string {
  return [
    `batch: ${batch.id}`,
    `queued: ${batch.queued}`,
    `running: ${batch.running}`,
    `completed: ${batch.completed}`,
    `failed: ${batch.failed}`,
    `cancelled: ${batch.cancelled}`,
    `results_ready: ${batch.undelivered}`,
    `terminal: ${batch.terminal}`,
  ].join("\n");
}

function createTerminalResult(
  task: ScheduledTask,
  id: string,
  output: string,
  cancelled: boolean,
): DelegatedResult {
  return {
    id,
    task: task.task,
    profile: task.profile,
    model: task.model,
    thinkingLevel: task.thinkingLevel,
    ok: false,
    cancelled,
    output,
    rawOutput: output,
    summaryOutput: output,
    durationMs: 0,
  };
}

function getWorkerUiState(status: string): WorkerUiState {
  if (status === "queued") return "queued";
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
    signal: AbortSignal;
    sharedContext?: string;
    uiDialogQueue: RpcUiDialogQueue;
    reportInputStatus: (active: boolean, label?: string) => void;
  },
): Promise<DelegatedResult> {
  const signal = options.signal;
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
    model: task.model,
    thinkingLevel: task.thinkingLevel,
    status: "starting",
    latestMessage: `Starting: ${task.task}`,
    output: "",
    worker,
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
      state.latestMessage = "Finishing worker run";
      refreshUi(ctx, workers);
      return;
    }

    if (event.type === "agent_settled") {
      state.status = "done";
      refreshUi(ctx, workers);
    }
  };

  const resultBase = {
    id,
    task: task.task,
    profile: task.profile,
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
            state.latestMessage = "Finishing synthesis";
            refreshUi(ctx, workers);
            return;
          }

          if (event.type === "agent_settled") {
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
    };
  } catch (error) {
    const cancelled = signal.aborted;
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
  let sessionContext: ExtensionContext | undefined;
  let sessionShuttingDown = false;
  const pendingResultReminders = new Set<string>();
  const announcedResultReminders = new Set<string>();

  const reportInputStatus = (active: boolean, label?: string) => {
    pi.events.emit("herdr:blocked", { active, label });
  };

  const delegation = new DelegationSession<ScheduledTask, DelegatedResult>({
    maxWorkers: getMaxWorkers(),
    runTask: async (task, id, signal) => {
      if (!sessionContext) throw new Error("Delegate session is not active");
      return runTask(sessionContext, workers, task, id, {
        signal,
        sharedContext: task.sharedContext,
        uiDialogQueue,
        reportInputStatus,
      });
    },
    classifyResult: (result) => result.cancelled
      ? "cancelled"
      : result.ok ? "completed" : "failed",
    createCancelledResult: (task, id) =>
      createTerminalResult(task, id, `Worker ${id} was cancelled.`, true),
    createFailedResult: (task, id, error) =>
      createTerminalResult(
        task,
        id,
        error instanceof Error ? error.message : String(error),
        false,
      ),
    onStateChange: (task) => {
      if (task.state === "queued") {
        workers.set(task.id, {
          id: task.id,
          task: task.task.task,
          profile: task.task.profile,
          model: task.task.model,
          thinkingLevel: task.task.thinkingLevel,
          status: "queued",
          latestMessage: "Queued — waiting for a worker slot",
          output: "",
        });
      } else if (task.state === "running") {
        const state = workers.get(task.id);
        if (state) {
          state.status = "starting";
          state.latestMessage = "Starting worker";
        }
      } else {
        workers.delete(task.id);
        pendingResultReminders.add(task.batchId);
        queueMicrotask(() => flushResultReminder(task.batchId));
        if (sessionContext?.hasUI && !sessionShuttingDown) {
          const level = task.state === "completed" ? "info" : "warning";
          sessionContext.ui.notify(
            `Delegate ${task.id} ${task.state} in ${task.batchId}; use delegate_results to collect it.`,
            level,
          );
        }
      }
      if (sessionContext) refreshUi(sessionContext, workers);
    },
  });

  function flushResultReminder(batchId: string): void {
    const ctx = sessionContext;
    if (!ctx || sessionShuttingDown || announcedResultReminders.has(batchId)) return;

    const batch = delegation.getBatch(batchId);
    if (!batch.terminal || batch.undelivered === 0) {
      pendingResultReminders.delete(batchId);
      return;
    }
    if (!ctx.isIdle()) return;

    pendingResultReminders.delete(batchId);
    announcedResultReminders.add(batchId);
    pi.sendMessage({
      customType: "delegate-results-ready",
      content: [
        `Delegation batch ${batch.id} finished with ${batch.undelivered} uncollected result(s).`,
        `Call delegate_results for ${batch.id} with waitFor available and incorporate the results before replying to the user.`,
      ].join("\n"),
      display: true,
    }, {
      deliverAs: "followUp",
      triggerTurn: true,
    });
  }

  const scheduleTasks = async (
    ctx: ExtensionContext,
    requestedTasks: TaskRequest[],
    sharedContext?: string,
  ): Promise<ScheduledTask[]> => {
    const loaded = await delegateConfigLoader.load(ctx);
    return routeTasks(ctx, requestedTasks, loaded.config).map((task) => ({
      ...task,
      sharedContext,
    }));
  };

  const activeWorkerIds = () => delegation.listBatches()
    .flatMap((batch) => batch.tasks)
    .filter((task) => task.state === "queued" || task.state === "running")
    .map((task) => task.id);

  pi.on("session_start", async (_event, ctx) => {
    sessionShuttingDown = false;
    sessionContext = ctx;
    refreshUi(ctx, workers);
    delegateConfigLoader.invalidate();
    try {
      const loaded = await delegateConfigLoader.load(ctx);
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

  pi.on("agent_settled", async () => {
    for (const batchId of [...pendingResultReminders]) flushResultReminder(batchId);
  });

  pi.on("session_shutdown", async () => {
    sessionShuttingDown = true;
    pendingResultReminders.clear();
    announcedResultReminders.clear();
    delegation.shutdown();
    for (const worker of workers.values()) worker.worker?.dispose();
    workers.clear();
    sessionContext = undefined;
  });

  pi.registerCommand("cancel-worker", {
    description: "Cancel one queued or running delegate worker by ID",
    getArgumentCompletions: (prefix) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      const items = activeWorkerIds()
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
      if (!delegation.cancelWorker(id)) {
        const active = activeWorkerIds();
        const suffix = active.length > 0
          ? ` Active workers: ${active.join(", ")}.`
          : " No workers are currently running.";
        ctx.ui.notify(`Worker ${id} is not running.${suffix}`, "warning");
        return;
      }
      ctx.ui.notify(`Cancelling worker ${id}...`, "info");
    },
  });

  pi.registerCommand("delegate", {
    description: "Start a background delegation batch",
    handler: async (args, ctx) => {
      const requestedTasks = parseCommandTasks(args);
      const maxWorkers = getMaxWorkers();
      if (requestedTasks.length === 0) {
        ctx.ui.notify("Usage: /delegate [fast] task A | [deep] task B", "warning");
        return;
      }
      if (requestedTasks.length > maxWorkers) {
        ctx.ui.notify(`Too many tasks. Max is ${maxWorkers}.`, "warning");
        return;
      }

      const tasks = await scheduleTasks(ctx, requestedTasks);
      const batch = delegation.createBatch(tasks);
      const payload = [{
        type: "text" as const,
        text: [
          `Delegation batch ${batch.id} started in the background.`,
          formatBatchStatus(batch),
          "Continue useful work, collect available results, add follow-up tasks, or wait when appropriate.",
        ].join("\n\n"),
      }];
      if (ctx.isIdle()) pi.sendUserMessage(payload);
      else pi.sendUserMessage(payload, { deliverAs: "followUp" });
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
  });

  pi.registerTool({
    name: "delegate_tasks",
    label: "Delegate Tasks",
    description:
      "Start focused delegated tasks in the background and return batch and worker IDs immediately",
    promptSnippet:
      "Start independent background tasks with fast, balanced, or deep worker profiles.",
    promptGuidelines: [
      "delegate_tasks returns immediately; use delegate_results to collect completed work or wait when appropriate.",
      "Continue useful independent work while delegates run, and use delegate_add_tasks for follow-up investigations based on early results.",
      "Before answering the user, collect every result from delegation batches started for that request; use waitFor all when unfinished results matter to the answer.",
      "If delegate_results reports wait_interrupted with unfinished work, call delegate_results again instead of treating the empty result as completion.",
      "Use waitFor available to avoid blocking, next when no other work is useful, and all only when final synthesis requires every result.",
      "Select fast for lookups and summaries; balanced for routine multi-file work; deep for architecture, security, migrations, or ambiguous root causes.",
      "Workers share the current working directory; prefer read-only delegation when the parent or other workers may edit overlapping files.",
      "Workers use pi's normal tool set by default and can be reconfigured with PI_DELEGATE_TOOLS.",
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const tasks = await scheduleTasks(ctx, params.tasks, params.sharedContext);
      const batch = delegation.createBatch(tasks);
      return {
        content: [{ type: "text", text: [
          `Started ${batch.id} with ${batch.tasks.length} delegated task(s).`,
          formatBatchStatus(batch),
          "Use delegate_results to collect results or delegate_add_tasks to add follow-up work.",
        ].join("\n\n") }],
        details: {
          batchId: batch.id,
          tasks: batch.tasks.map((task) => ({
            id: task.id,
            state: task.state,
            profile: task.task.profile,
            model: task.task.model,
            thinkingLevel: task.task.thinkingLevel,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "delegate_add_tasks",
    label: "Add Delegate Tasks",
    description:
      "Add follow-up tasks to an existing delegation batch while its other workers continue",
    parameters: Type.Object({
      batchId: Type.String({ description: "Delegation batch ID, for example b3" }),
      tasks: Type.Array(taskSchema, {
        minItems: 1,
        maxItems: getMaxWorkers(),
      }),
      sharedContext: Type.Optional(Type.String({
        description: "Extra context for only the newly added tasks",
      })),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object" || Array.isArray(args)) return args as any;
      const input = args as { tasks?: unknown };
      if (!Array.isArray(input.tasks)) return args as any;
      return {
        ...input,
        tasks: input.tasks.map((task) => typeof task === "string" ? { task } : task),
      } as any;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const tasks = await scheduleTasks(ctx, params.tasks, params.sharedContext);
      announcedResultReminders.delete(params.batchId);
      pendingResultReminders.delete(params.batchId);
      const batch = delegation.addTasks(params.batchId, tasks);
      return {
        content: [{ type: "text", text: [
          `Added ${tasks.length} task(s) to ${batch.id}.`,
          formatBatchStatus(batch),
        ].join("\n\n") }],
        details: {
          batchId: batch.id,
          addedTaskIds: batch.tasks.slice(-tasks.length).map((task) => task.id),
        },
      };
    },
  });

  pi.registerTool({
    name: "delegate_results",
    label: "Delegate Results",
    description:
      "Collect new results from a delegation batch, optionally waiting for the next result or all tasks",
    parameters: Type.Object({
      batchId: Type.String({ description: "Delegation batch ID, for example b3" }),
      waitFor: Type.Optional(StringEnum(["available", "next", "all"] as const, {
        description:
          "available returns immediately; next waits for one new result; all waits for the terminal batch",
      })),
      timeoutMs: Type.Optional(Type.Number({
        minimum: 0,
        maximum: 300000,
        description: "Maximum wait for next/all in milliseconds",
      })),
    }),
    async execute(_toolCallId, params, signal) {
      const waitFor = (params.waitFor ?? "available") as DelegationWaitMode;
      const collected = await delegation.getResults(params.batchId, waitFor, {
        timeoutMs: params.timeoutMs,
        signal,
      });
      if (collected.batch.undelivered === 0) {
        pendingResultReminders.delete(params.batchId);
      }
      const resultText = collected.results.length > 0
        ? formatResults(collected.results)
        : "(no new results)";
      const nextAction = collected.interrupted && !collected.batch.terminal
        ? "Wait was interrupted while delegates are unfinished. Call delegate_results again to collect them before replying."
        : collected.timedOut && !collected.batch.terminal
          ? "Wait timed out while delegates are unfinished. Continue useful work or call delegate_results again."
          : undefined;
      return {
        content: [{ type: "text", text: [
          formatBatchStatus(collected.batch),
          `wait_timed_out: ${collected.timedOut}`,
          `wait_interrupted: ${collected.interrupted}`,
          ...(nextAction ? [`next_action: ${nextAction}`] : []),
          "New results:",
          resultText,
        ].join("\n\n") }],
        details: {
          batchId: collected.batch.id,
          resultCount: collected.results.length,
          timedOut: collected.timedOut,
          interrupted: collected.interrupted,
          terminal: collected.batch.terminal,
        },
      };
    },
  });

  pi.registerTool({
    name: "delegate_cancel",
    label: "Cancel Delegation",
    description: "Cancel one delegated worker or every unfinished worker in a batch",
    parameters: Type.Object({
      workerId: Type.Optional(Type.String({ description: "Worker ID to cancel" })),
      batchId: Type.Optional(Type.String({ description: "Batch ID to cancel" })),
    }),
    async execute(_toolCallId, params) {
      if ((params.workerId ? 1 : 0) + (params.batchId ? 1 : 0) !== 1) {
        throw new Error("Provide exactly one of workerId or batchId");
      }
      if (params.workerId) {
        const id = normalizeWorkerId(params.workerId);
        if (!id) throw new Error(`Invalid worker ID: ${params.workerId}`);
        const cancelled = delegation.cancelWorker(id);
        return {
          content: [{
            type: "text",
            text: cancelled
              ? `Cancellation requested for ${id}.`
              : `${id} is not queued or running.`,
          }],
          details: {
            targetType: "worker",
            targetId: id,
            cancelledTasks: cancelled ? 1 : 0,
          },
        };
      }

      const cancelled = delegation.cancelBatch(params.batchId!);
      return {
        content: [{
          type: "text",
          text: `Cancellation requested for ${cancelled} task(s) in ${params.batchId}.`,
        }],
        details: {
          targetType: "batch",
          targetId: params.batchId!,
          cancelledTasks: cancelled,
        },
      };
    },
  });
}
