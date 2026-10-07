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
  acquireWorkerSlot,
  createWorkerCoordinator,
  resumeWorkerSlot,
  yieldWorkerSlot,
  type WorkerCoordinator,
} from "./coordinator.ts";
import {
  delegateConfigLoader,
  PROFILE_NAMES,
  type DelegateProfileConfig,
  type ProfileName,
  type ResolvedDelegateConfig,
} from "./config.ts";
import {
  createRpcWorker,
  MAX_INVESTIGATION_TEXT_CHARS,
  MAX_SYNTHESIS_TEXT_CHARS,
  sumUsage,
  emptyUsage,
  type RpcEvent,
  type RpcWorker,
} from "./rpc-worker.ts";
import {
  createRpcUiDialogQueue,
  type RpcUiDialogQueue,
} from "./ui-dialog-queue.ts";
import { createWidgetRefresh, type WidgetRefresh } from "./widget-refresh.ts";

type TaskRequest = {
  task: string;
  profile?: ProfileName;
  modelSet?: string;
  timeoutMs?: number;
  tools?: string[];
};

type ModelSetSource = "task" | "parent-model" | "default" | "none";

type RoutedTask = {
  task: string;
  timeoutMs?: number;
  tools?: string[];
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
  nestedLines?: string[];
  worker: RpcWorker;
  abortController: AbortController;
  cancelRequested: boolean;
};

type QueuedWorkerState = {
  id: string;
  task: string;
  profile: ProfileName;
  status: string;
  latestMessage: string;
  abortController: AbortController;
  cancelRequested: boolean;
};

type WorkerUiState = "queued" | "starting" | "working" | "synthesizing" | "done" | "cancelled" | "timed out" | "error";

const WORKER_STATE_STYLES = {
  queued: { icon: "", fg: "muted" },
  starting: { icon: "", fg: "muted" },
  working: { icon: "", fg: "accent" },
  synthesizing: { icon: "", fg: "warning" },
  done: { icon: "", fg: "success" },
  cancelled: { icon: "", fg: "warning" },
  "timed out": { icon: "", fg: "warning" },
  error: { icon: "", fg: "error" },
} as const;

type DelegatedResult = {
  id: string;
  task: string;
  timeoutMs?: number;
  tools?: string[];
  profile: ProfileName;
  modelSet?: string;
  modelSetSource: ModelSetSource;
  model?: string | null;
  thinkingLevel?: DelegateProfileConfig["thinkingLevel"];
  ok: boolean;
  cancelled: boolean;
  timedOut: boolean;
  output: string;
  rawOutput: string;
  summaryOutput: string;
  durationMs: number;
  queueWaitMs?: number;
  usage: Usage;
};

const DEFAULT_TOOLS = ["read", "write", "edit", "bash", "codemode", "tool_search"];
const DEFAULT_MAX_WORKERS = 5;
const DEFAULT_MAX_ACTIVE_WORKERS = 10;
const DEFAULT_MAX_LIVE_WORKERS = 30;

function getMaxDepth(): 1 | 2 {
  const value = process.env.PI_DELEGATE_MAX_DEPTH?.trim();
  if (value === undefined || value === "" || value === "2") return 2;
  if (value === "1") return 1;
  throw new Error("PI_DELEGATE_MAX_DEPTH must be 1 or 2");
}

function getDepth(): number {
  return Number(process.env.PI_DELEGATE_WORKER_DEPTH ?? "0");
}
const MAX_TIMEOUT_MS = 2_147_483_647;

function getWorkerTools(): string[] {
  const raw = process.env.PI_DELEGATE_TOOLS?.trim();
  const defaultTools = getMaxDepth() === 2 && getDepth() + 1 < 2
    ? [...DEFAULT_TOOLS, "delegate_tasks"]
    : DEFAULT_TOOLS;
  if (!raw) return defaultTools;
  const tools = raw.split(",").map((tool) => tool.trim()).filter(Boolean);
  return (tools.length > 0 ? tools : defaultTools)
    .filter((tool) => tool !== "delegate_tasks" || getMaxDepth() === 2 && getDepth() + 1 < 2);
}

function positiveLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function getMaxWorkers(): number {
  const raw = Number(process.env.PI_DELEGATE_MAX_WORKERS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_MAX_WORKERS;
}

function getCoordinatorLimits() {
  return {
    maxActive: positiveLimit("PI_DELEGATE_MAX_ACTIVE_WORKERS", DEFAULT_MAX_ACTIVE_WORKERS),
    maxLive: positiveLimit("PI_DELEGATE_MAX_LIVE_WORKERS", DEFAULT_MAX_LIVE_WORKERS),
    maxDepth: getMaxDepth(),
  };
}

export function normalizeWorkerId(text: string): string | undefined {
  const match = text.trim().match(/^(?:w)?([1-9]\d*(?:\.[1-9]\d*)?)$/i);
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
    let tools: string[] | undefined;
    if (request.tools !== undefined) {
      if (!Array.isArray(request.tools) || request.tools.length === 0) {
        throw new Error("delegate-workers task tools must be a non-empty array");
      }
      const allowed = getWorkerTools();
      tools = request.tools.map((tool) => typeof tool === "string" ? tool.trim() : "");
      if (tools.some((tool) => !tool || !allowed.includes(tool))) {
        throw new Error(`delegate-workers task tools must be a subset of the worker allowlist: ${allowed.join(", ")}`);
      }
      if (new Set(tools).size !== tools.length) {
        throw new Error("delegate-workers task tools must not contain duplicates");
      }
    }
    if (request.timeoutMs !== undefined && (
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > MAX_TIMEOUT_MS
    )) {
      throw new Error(`delegate-workers timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
    }
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
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(tools === undefined ? {} : { tools }),
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
      const status = result.timedOut ? "timed out" : result.cancelled ? "cancelled" : result.ok ? "ok" : "error";
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
        ...(result.tools === undefined ? [] : [`tools: ${result.tools.join(",")}`]),
        `duration_ms: ${result.durationMs}`,
        ...(result.queueWaitMs === undefined ? [] : [`queue_wait_ms: ${result.queueWaitMs}`]),
        ...(result.timeoutMs === undefined ? [] : [`timeout_ms: ${result.timeoutMs}`]),
        "",
        body,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function getWorkerUiState(status: string): WorkerUiState {
  if (status === "queued") return "queued";
  if (status === "synthesizing") return "synthesizing";
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (status === "timed out") return "timed out";
  if (status === "error") return "error";
  if (status === "starting") return "starting";
  return "working";
}

function compactActivity(text: string, maxChars = 140): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

export function appendWorkerActivity(current: string, delta: string): string {
  return compactActivity(current + delta);
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

export function formatWorkerWidgetLines(
  states: Array<Pick<WorkerState, "id" | "task" | "profile" | "status" | "latestMessage" | "nestedLines">>,
  fg: (color: (typeof WORKER_STATE_STYLES)[WorkerUiState]["fg"], text: string) => string,
): string[] {
  return states
    .sort((a, b) => {
      const left = a.id.slice(1).split(".").map(Number);
      const right = b.id.slice(1).split(".").map(Number);
      return left[0]! - right[0]! || (left[1] ?? 0) - (right[1] ?? 0);
    })
    .flatMap((worker) => {
      const uiState = getWorkerUiState(worker.status);
      const style = WORKER_STATE_STYLES[uiState];
      const label = fg(style.fg, `${style.icon} ${worker.id} [${worker.profile}]`);
      return [...formatWorkerDisplayLines(label, worker.task, worker.latestMessage), ...(worker.nestedLines ?? [])];
    });
}

function refreshUi(
  ctx: ExtensionContext,
  workers: Map<string, WorkerState>,
  queued: Map<string, QueuedWorkerState> = new Map(),
) {
  const widgetLines = formatWorkerWidgetLines(
    [...workers.values(), ...queued.values()],
    (color, text) => ctx.ui.theme.fg(color, text),
  );
  if (widgetLines.length === 0) ctx.ui.setWidget("delegate-workers", undefined);
  else ctx.ui.setWidget("delegate-workers", widgetLines, { placement: "aboveEditor" });
}

export async function runTask(
  ctx: ExtensionContext,
  workers: Map<string, WorkerState>,
  task: RoutedTask,
  id: string,
  options: {
    signal?: AbortSignal;
    sharedContext?: string;
    uiDialogQueue: RpcUiDialogQueue;
    reportInputStatus: (active: boolean, label?: string) => void;
    createWorker?: typeof createRpcWorker;
    widgetRefresh?: WidgetRefresh<ExtensionContext>;
    coordinatorEndpoint?: string;
    workerDepth?: number;
    workerToken?: string;
    maxDepth?: number;
  },
): Promise<DelegatedResult> {
  const abortController = new AbortController();
  const deadlineController = new AbortController();
  const timeoutReason = new Error(`Worker ${id} timed out after ${task.timeoutMs} ms.`);
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    abortController.signal,
    deadlineController.signal,
  ]);
  const worker = (options.createWorker ?? createRpcWorker)({
    cwd: ctx.cwd,
    tools: task.tools ?? getWorkerTools(),
    enforceTools: task.tools !== undefined,
    model: task.model,
    thinkingLevel: task.thinkingLevel,
    ui: ctx.ui,
    uiPrefix: id,
    uiDialogQueue: options.uiDialogQueue,
    reportInputStatus: options.reportInputStatus,
    onDelegateWidget: (lines) => {
      const state = workers.get(id);
      if (state) {
        state.nestedLines = lines;
        if (options.widgetRefresh) options.widgetRefresh.immediate(ctx);
        else refreshUi(ctx, workers);
      }
    },
    coordinatorEndpoint: options.coordinatorEndpoint,
    workerDepth: options.workerDepth,
    workerToken: options.workerToken,
    maxDepth: options.maxDepth,
  });
  const updateWidget = (scheduled = false) => {
    if (!options.widgetRefresh) {
      refreshUi(ctx, workers);
    } else if (scheduled) {
      options.widgetRefresh.schedule(ctx);
    } else {
      options.widgetRefresh.immediate(ctx);
    }
  };
  const state: WorkerState = {
    id,
    task: task.task,
    profile: task.profile,
    modelSet: task.modelSet,
    model: task.model,
    thinkingLevel: task.thinkingLevel,
    status: "starting",
    latestMessage: compactActivity(`Starting: ${task.task}`),
    worker,
    abortController,
    cancelRequested: false,
  };

  workers.set(id, state);
  updateWidget();
  const startedAt = Date.now();
  const deadline = task.timeoutMs === undefined ? undefined : setTimeout(
    () => deadlineController.abort(timeoutReason),
    task.timeoutMs,
  );

  const onEvent = (event: RpcEvent) => {
    if (event.type === "message_start" && event.message?.role === "assistant") {
      state.latestMessage = "Thinking about the next step";
      updateWidget();
      return;
    }

    if (event.type === "agent_start") {
      state.status = "running";
      state.latestMessage = compactActivity(`Investigating: ${task.task}`);
      updateWidget();
      return;
    }

    if (event.type === "tool_execution_start") {
      state.status = `tool:${event.toolName}`;
      state.latestMessage = describeWorkerTool(event);
      updateWidget();
      return;
    }

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      const previousMessage = state.latestMessage;
      if (state.latestMessage === "Thinking about the next step") state.latestMessage = "";
      state.latestMessage = appendWorkerActivity(state.latestMessage, event.assistantMessageEvent.delta);
      if (state.latestMessage !== previousMessage) updateWidget(true);
      return;
    }

    if (event.type === "agent_end") {
      state.status = "done";
      updateWidget();
    }
  };

  const resultBase = {
    id,
    task: task.task,
    timeoutMs: task.timeoutMs,
    tools: task.tools,
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
        maxTextChars: MAX_INVESTIGATION_TEXT_CHARS,
      },
    );

    state.status = "synthesizing";
    state.latestMessage = "Synthesizing findings";
    updateWidget();

    let summaryText = truncateFallback(investigation.text);
    if (investigation.truncated) {
      summaryText += "\n\n[investigation text capture truncated; worker context unchanged]";
    }
    try {
      const summary = await worker.prompt(buildSummaryPrompt(task.task), {
        signal,
        maxTextChars: MAX_SYNTHESIS_TEXT_CHARS,
        onEvent: (event: RpcEvent) => {
          if (event.type === "message_start" && event.message?.role === "assistant") {
            state.latestMessage = "Synthesizing findings";
            updateWidget();
            return;
          }

          if (event.type === "agent_start") {
            state.status = "synthesizing";
            state.latestMessage = "Synthesizing findings";
            updateWidget();
            return;
          }

          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta"
          ) {
            const previousMessage = state.latestMessage;
            if (state.latestMessage === "Synthesizing findings") state.latestMessage = "";
            state.latestMessage = appendWorkerActivity(state.latestMessage, event.assistantMessageEvent.delta);
            if (state.latestMessage !== previousMessage) updateWidget(true);
            return;
          }

          if (event.type === "agent_end") {
            state.status = "done";
            updateWidget();
          }
        },
      });

      if (summary.text.trim()) {
        summaryText = summary.text.trim();
        if (summary.truncated) summaryText += "\n\n[synthesis text truncated before returning to parent agent]";
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }

    state.latestMessage = "Done";
    state.status = "done";
    updateWidget();

    return {
      ...resultBase,
      ok: true,
      cancelled: false,
      timedOut: false,
      output: summaryText,
      rawOutput: investigation.text,
      summaryOutput: summaryText,
      durationMs: Date.now() - startedAt,
      usage: worker.getUsage(),
    };
  } catch (error) {
    const timedOut = signal.aborted && signal.reason === timeoutReason;
    const cancelled = signal.aborted && !timedOut;
    const message = timedOut
      ? timeoutReason.message
      : cancelled
        ? `Worker ${id} was cancelled.`
        : error instanceof Error ? error.message : String(error);
    state.status = timedOut ? "timed out" : cancelled ? "cancelled" : "error";
    state.latestMessage = timedOut ? "Timed out" : cancelled ? "Cancelled" : `Error: ${message}`;
    updateWidget();

    return {
      ...resultBase,
      ok: false,
      cancelled,
      timedOut,
      output: message,
      rawOutput: message,
      summaryOutput: message,
      durationMs: Date.now() - startedAt,
      usage: worker.getUsage(),
    };
  } finally {
    if (deadline) clearTimeout(deadline);
    worker.dispose();
    workers.delete(id);
    updateWidget();
  }
}

export async function scheduleTask(
  ctx: ExtensionContext,
  workers: Map<string, WorkerState>,
  queued: Map<string, QueuedWorkerState>,
  coordinator: WorkerCoordinator,
  task: RoutedTask,
  id: string,
  options: {
    signal?: AbortSignal;
    sharedContext?: string;
    uiDialogQueue: RpcUiDialogQueue;
    reportInputStatus: (active: boolean, label?: string) => void;
    createWorker?: typeof createRpcWorker;
    widgetRefresh?: WidgetRefresh<ExtensionContext>;
    depth?: number;
    parentToken?: string;
    maxDepth?: number;
  },
): Promise<DelegatedResult> {
  const startedWaiting = Date.now();
  const abortController = new AbortController();
  const state: QueuedWorkerState = {
    id,
    task: task.task,
    profile: task.profile,
    status: "queued",
    latestMessage: "Waiting for a worker slot",
    abortController,
    cancelRequested: false,
  };
  queued.set(id, state);
  const updateWidget = () => options.widgetRefresh
    ? options.widgetRefresh.immediate(ctx)
    : refreshUi(ctx, workers, queued);
  updateWidget();
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    abortController.signal,
  ]);
  try {
    const slot = await coordinator.acquire(signal, options.depth ?? 1, options.parentToken);
    const queueWaitMs = Date.now() - startedWaiting;
    queued.delete(id);
    try {
      if (signal.aborted || slot.signal.aborted) throw new Error("Worker slot request cancelled");
      const result = await runTask(ctx, workers, task, id, {
        ...options,
        coordinatorEndpoint: coordinator.endpoint,
        workerDepth: options.depth ?? 1,
        workerToken: slot.token,
        maxDepth: options.maxDepth ?? 2,
        signal: AbortSignal.any([signal, slot.signal]),
      });
      return { ...result, queueWaitMs };
    } finally {
      slot.release();
    }
  } catch (error) {
    return {
      id,
      task: task.task,
      timeoutMs: task.timeoutMs,
      tools: task.tools,
      profile: task.profile,
      modelSet: task.modelSet,
      modelSetSource: task.modelSetSource,
      model: task.model,
      thinkingLevel: task.thinkingLevel,
      ok: false,
      cancelled: signal.aborted,
      timedOut: false,
      output: signal.aborted ? `Worker ${id} was cancelled before launch.` : error instanceof Error ? error.message : String(error),
      rawOutput: "",
      summaryOutput: "",
      durationMs: 0,
      queueWaitMs: Date.now() - startedWaiting,
      usage: emptyUsage(),
    };
  } finally {
    queued.delete(id);
    updateWidget();
  }
}

export default function delegateWorkersExtension(pi: ExtensionAPI) {
  const inheritedEndpoint = process.env.PI_DELEGATE_COORDINATOR_ENDPOINT;
  const depth = getDepth();
  const maxDepth = getMaxDepth();
  if (inheritedEndpoint && (depth < 1 || depth >= maxDepth || !process.env.PI_DELEGATE_WORKER_TOKEN)) return;

  const workers = new Map<string, WorkerState>();
  const queued = new Map<string, QueuedWorkerState>();
  const widgetRefresh = createWidgetRefresh((ctx: ExtensionContext) => refreshUi(ctx, workers, queued));
  let coordinator: Promise<WorkerCoordinator> | undefined;
  const inheritedCoordinator: WorkerCoordinator | undefined = inheritedEndpoint ? {
    endpoint: inheritedEndpoint,
    acquire: (signal, childDepth, parentToken) => acquireWorkerSlot(inheritedEndpoint, signal, childDepth, parentToken),
    close: async () => undefined,
  } : undefined;
  const getCoordinator = () => inheritedCoordinator
    ? Promise.resolve(inheritedCoordinator)
    : coordinator ??= createWorkerCoordinator(getCoordinatorLimits());
  const closeCoordinator = async () => {
    const current = coordinator;
    coordinator = undefined;
    if (current && !inheritedEndpoint) await (await current).close();
  };
  const uiDialogQueue = createRpcUiDialogQueue();
  const activeTools = new Set<string>();
  const toolChanged = new Set<() => void>();
  let nestedCallActive = false;
  pi.on("tool_execution_start", (event) => {
    activeTools.add(event.toolCallId);
    for (const notify of toolChanged) notify();
  });
  pi.on("tool_execution_end", (event) => {
    activeTools.delete(event.toolCallId);
    for (const notify of toolChanged) notify();
  });
  const waitForOtherTools = async (toolCallId: string, signal?: AbortSignal) => {
    if ([...activeTools].every((id) => id === toolCallId)) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if ([...activeTools].every((id) => id === toolCallId)) { cleanup(); resolve(); }
      };
      const abort = () => { cleanup(); reject(new Error("Nested delegation cancelled")); };
      const cleanup = () => {
        toolChanged.delete(check);
        signal?.removeEventListener("abort", abort);
      };
      toolChanged.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
  };
  let nextWorkerId = 1;
  let inferredModelSetInitialized = false;
  let inferredModelSet: string | undefined;

  const parentWorkerId = inheritedEndpoint ? process.env.PI_DELEGATE_PARENT_WORKER_ID : undefined;
  const makeWorkerId = () => `${parentWorkerId ? `${parentWorkerId}.` : "w"}${nextWorkerId++}`;
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
    for (const state of queued.values()) requestWorkerCancellation(state);
    queued.clear();
    for (const state of workers.values()) requestWorkerCancellation(state);
    await closeCoordinator();
    widgetRefresh.immediate(ctx);
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
    widgetRefresh.cancel();
    for (const state of queued.values()) requestWorkerCancellation(state);
    queued.clear();
    for (const worker of workers.values()) {
      requestWorkerCancellation(worker);
      worker.worker.dispose();
    }
    workers.clear();
    await closeCoordinator();
  });

  pi.registerCommand("cancel-worker", {
    description: "Cancel one running delegate worker by ID",
    getArgumentCompletions: (prefix) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      const items = [...workers.keys(), ...queued.keys()]
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

      const state = workers.get(id) ?? queued.get(id);
      if (!state || state.cancelRequested) {
        const active = [...workers.keys(), ...queued.keys()];
        const suffix = active.length > 0
          ? ` Active workers: ${active.join(", ")}.`
          : " No workers are currently running.";
        ctx.ui.notify(`Worker ${id} is not available for cancellation.${suffix}`, "warning");
        return;
      }

      requestWorkerCancellation(state);
      state.status = "cancelled";
      state.latestMessage = "Cancelling";
      widgetRefresh.immediate(ctx);
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
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description: "Optional deadline in milliseconds for investigation and synthesis together. No timeout by default.",
      }),
    ),
    tools: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        uniqueItems: true,
        description: `Optional per-task tool subset of PI_DELEGATE_TOOLS (current default: ${getWorkerTools().join(",")}).`,
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
      "Depth-one workers can delegate once by default. Set PI_DELEGATE_MAX_DEPTH=1 to disable nesting; PI_DELEGATE_TOOLS can restrict worker tools.",
      "Use a task's tools field for a read-only subset of the worker tool allowlist. The default for depth-one workers is read,write,edit,bash,codemode,tool_search,delegate_tasks; depth-two workers cannot delegate.",
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
    async execute(toolCallId, params, signal, onUpdate, ctx) {
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
            text: `Scheduling ${tasks.length} delegate worker(s)...`,
          },
        ],
        details: {},
      });

      const scheduler = await getCoordinator();
      if (inheritedEndpoint && nestedCallActive) throw new Error("Only one nested delegate_tasks call may run at a time");
      if (inheritedEndpoint) nestedCallActive = true;
      let yielded = false;
      let results: DelegatedResult[];
      try {
        if (inheritedEndpoint) {
          await waitForOtherTools(toolCallId, signal);
          await yieldWorkerSlot(inheritedEndpoint, process.env.PI_DELEGATE_WORKER_TOKEN!, signal);
          yielded = true;
        }
        results = await Promise.all(
          tasks.map((task) =>
            scheduleTask(ctx, workers, queued, scheduler, task, makeWorkerId(), {
              signal,
              sharedContext: params.sharedContext,
              uiDialogQueue,
              reportInputStatus,
              widgetRefresh,
              depth: depth + 1,
              parentToken: inheritedEndpoint ? process.env.PI_DELEGATE_WORKER_TOKEN : undefined,
              maxDepth,
            }),
          ),
        );
      } finally {
        try {
          if (yielded) await resumeWorkerSlot(inheritedEndpoint!, process.env.PI_DELEGATE_WORKER_TOKEN!, signal);
        } finally {
          if (inheritedEndpoint) nestedCallActive = false;
        }
      }

      const combined = formatResults(results);
      const failed = results.filter((result) => !result.ok).length;
      const cancelled = results.filter((result) => result.cancelled).length;
      const timedOut = results.filter((result) => result.timedOut).length;
      const usage = sumUsage(results.map((result) => result.usage));

      return {
        content: [{ type: "text", text: combined }],
        usage,
        details: {
          taskCount: results.length,
          failedTasks: failed,
          cancelledTasks: cancelled,
          timedOutTasks: timedOut,
          routes: results.map((result) => ({
            id: result.id,
            profile: result.profile,
            modelSet: result.modelSet,
            modelSetSource: result.modelSetSource,
            model: result.model,
            thinkingLevel: result.thinkingLevel,
            timeoutMs: result.timeoutMs,
            queueWaitMs: result.queueWaitMs,
            tools: result.tools,
            usage: result.usage,
          })),
        },
      };
    },
  });
}
