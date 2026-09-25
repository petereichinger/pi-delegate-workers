import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./config.ts";
import type { RpcUiDialogQueue } from "./ui-dialog-queue.ts";

export type RpcEvent = any;

const MAX_STDERR_CHARS = 8_192;
export const MAX_INVESTIGATION_TEXT_CHARS = 32_768;
export const MAX_SYNTHESIS_TEXT_CHARS = 16_384;

type StderrBuffer = { text: string; truncated: boolean };

export function appendStderr(buffer: StderrBuffer, chunk: string): StderrBuffer {
  const truncated = buffer.truncated || buffer.text.length + chunk.length > MAX_STDERR_CHARS;
  return {
    text: (buffer.text + chunk.slice(-MAX_STDERR_CHARS)).slice(-MAX_STDERR_CHARS),
    truncated,
  };
}

function stderrDetail(buffer: StderrBuffer): string {
  return `${buffer.truncated ? "[earlier stderr truncated]\n" : ""}${buffer.text.trim()}`;
}

export type RpcWorker = {
  prompt(
    message: string,
    options?: { onEvent?: (event: RpcEvent) => void; signal?: AbortSignal; maxTextChars?: number }
  ): Promise<{ text: string; truncated?: boolean }>;
  getUsage(): Usage;
  abort(): void;
  dispose(): void;
};

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function addUsage(left: Usage, right: Usage): Usage {
  const usage: Usage = {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };

  if (left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined) {
    usage.cacheWrite1h = (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0);
  }
  if (left.reasoning !== undefined || right.reasoning !== undefined) {
    usage.reasoning = (left.reasoning ?? 0) + (right.reasoning ?? 0);
  }

  return usage;
}

export function sumUsage(usages: Iterable<Usage>): Usage {
  let total = emptyUsage();
  for (const usage of usages) total = addUsage(total, usage);
  return total;
}

export function getRpcEventUsage(event: RpcEvent): Usage | undefined {
  if (event.type === "message_end") return event.message?.usage;
  if (event.type === "compaction_end") return event.result?.usage;
  return undefined;
}

type RpcUi = {
  select?: (title: string, options: string[], optionsArg?: any) => Promise<string | undefined>;
  confirm?: (title: string, message: string, optionsArg?: any) => Promise<boolean>;
  input?: (title: string, placeholder?: string, optionsArg?: any) => Promise<string | undefined>;
  editor?: (title: string, prefill?: string, optionsArg?: any) => Promise<string | undefined>;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  setStatus?: (key: string, text?: string) => void;
  setWidget?: (key: string, lines?: string[], optionsArg?: any) => void;
  setTitle?: (title: string) => void;
  setEditorText?: (text: string) => void;
};

type ActivePrompt = {
  id: string;
  text: string;
  truncated: boolean;
  maxTextChars: number;
  onEvent?: (event: RpcEvent) => void;
  resolve: (value: { text: string; truncated: boolean }) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function appendBoundedText(
  current: { text: string; truncated: boolean },
  delta: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const remaining = Math.max(0, maxChars - current.text.length);
  return {
    text: current.text + delta.slice(0, remaining),
    truncated: current.truncated || delta.length > remaining,
  };
}

export async function withInputStatus<T>(
  report: ((active: boolean, label?: string) => void) | undefined,
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    report?.(true, label);
  } catch {
    // Status reporting must never prevent the worker dialog.
  }

  try {
    return await action();
  } finally {
    try {
      report?.(false);
    } catch {
      // Keep the dialog result authoritative if status cleanup fails.
    }
  }
}

function parseJsonl(proc: ChildProcessWithoutNullStreams, onEvent: (event: RpcEvent) => void) {
  let buffer = "";
  proc.stdout.setEncoding("utf8");

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;

      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;

      try {
        onEvent(JSON.parse(line));
      } catch {
        // Ignore malformed lines from the child process.
      }
    }
  });
}

function splitExtraArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  }) ?? [];
}

function findToolGuardExtensionArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if ((arg === "-e" || arg === "--extension") && args[index + 1]?.includes("pi-tool-guard")) return args[index + 1];
    if (arg.startsWith("--extension=") && arg.includes("pi-tool-guard")) return arg.slice("--extension=".length);
  }
  return undefined;
}

function hasToolGuardExtensionArg(args: string[]): boolean {
  return Boolean(findToolGuardExtensionArg(args));
}

function hasNoExtensionsArg(args: string[]): boolean {
  return args.includes("--no-extensions");
}

function isDisabled(value: string | undefined): boolean {
  return ["0", "false", "no", "off", "disabled"].includes(value?.trim().toLowerCase() ?? "");
}

function isEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(value?.trim().toLowerCase() ?? "");
}

function resolveToolGuardExtension(): string | undefined {
  const mode = process.env.PI_DELEGATE_TOOL_GUARD?.trim().toLowerCase();
  if (isDisabled(mode)) return undefined;

  const explicit = process.env.PI_DELEGATE_TOOL_GUARD_EXTENSION?.trim();
  if (explicit) return explicit;

  const parentCliExtension = findToolGuardExtensionArg(process.argv.slice(2));
  if (parentCliExtension) return parentCliExtension;

  const extensionDir = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(extensionDir, "..", "..", "pi-tool-guard");
  if (existsSync(resolve(sibling, "package.json"))) return sibling;

  if (["1", "true", "yes", "on", "required"].includes(mode ?? "")) return "pi-tool-guard";
  return undefined;
}

export type WorkerRoutingOptions = {
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  enforceTools?: boolean;
};

function removeOptions(args: string[], names: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const exact = names.includes(arg);
    const assigned = names.some((name) => arg.startsWith(`${name}=`));
    if (assigned) continue;
    if (exact) {
      index++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function buildWorkerArgs(
  tools: string[],
  routing: WorkerRoutingOptions = {},
): string[] {
  let extraArgs = splitExtraArgs(process.env.PI_DELEGATE_EXTRA_ARGS);
  if (routing.enforceTools) {
    extraArgs = removeOptions(extraArgs, ["--tools", "-t"]);
  }
  if (routing.model !== undefined) {
    extraArgs = removeOptions(extraArgs, ["--model", "--provider"]);
  }
  if (routing.thinkingLevel !== undefined) {
    extraArgs = removeOptions(extraArgs, ["--thinking"]);
  }

  const args = ["--mode", "rpc", "--no-session", "--tools", tools.join(",")];
  const toolGuardExtension = resolveToolGuardExtension();
  if (toolGuardExtension && isEnabled(process.env.PI_DELEGATE_TOOL_GUARD_ISOLATE) && !hasNoExtensionsArg(extraArgs)) {
    args.push("--no-extensions");
  }
  if (toolGuardExtension && !hasToolGuardExtensionArg(extraArgs)) {
    args.push("--extension", toolGuardExtension);
  }
  args.push(...extraArgs);
  if (typeof routing.model === "string") {
    args.push("--model", routing.model);
  }
  if (typeof routing.thinkingLevel === "string") {
    args.push("--thinking", routing.thinkingLevel);
  }
  return args;
}

export function createRpcWorker(options: {
  cwd: string;
  tools: string[];
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  enforceTools?: boolean;
  ui?: RpcUi;
  uiPrefix?: string;
  uiDialogQueue?: RpcUiDialogQueue;
  reportInputStatus?: (active: boolean, label?: string) => void;
  spawnWorker?: (
    bin: string,
    args: string[],
    options: { cwd: string; stdio: ["pipe", "pipe", "pipe"] },
  ) => ChildProcessWithoutNullStreams;
}): RpcWorker {
  const bin = process.env.PI_DELEGATE_PI_BIN || "pi";
  const proc = (options.spawnWorker ?? spawn)(
    bin,
    buildWorkerArgs(options.tools, {
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      enforceTools: options.enforceTools,
    }),
    {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  let disposed = false;
  let stderr: StderrBuffer = { text: "", truncated: false };
  let activePrompt: ActivePrompt | undefined;
  let usage = emptyUsage();

  proc.stderr.on("data", (chunk) => {
    stderr = appendStderr(stderr, chunk.toString("utf8"));
  });

  const respondToUiRequest = (id: string, response: Record<string, unknown>) => {
    try {
      send({ type: "extension_ui_response", id, ...response });
    } catch {
      // ignore; the worker may already be gone
    }
  };

  const dialogMethods = new Set(["select", "confirm", "input", "editor"]);

  const handleUiRequest = async (event: any, receivedAt: number) => {
    const isDialog = dialogMethods.has(event.method);
    const ui = options.ui;
    if (!event.id || !ui || disposed) {
      if (event.id && isDialog) {
        respondToUiRequest(event.id, { cancelled: true });
      }
      return;
    }

    const elapsedMs = Date.now() - receivedAt;
    const timeout = typeof event.timeout === "number"
      ? Math.max(0, event.timeout - elapsedMs)
      : undefined;
    if (isDialog && timeout === 0) {
      respondToUiRequest(event.id, { cancelled: true });
      return;
    }

    const dialogOptions = timeout === undefined ? undefined : { timeout };
    const prefix = options.uiPrefix ? `[${options.uiPrefix}] ` : "[delegate worker] ";
    const inputLabel = `${prefix}${event.title ?? "Waiting for input"}`;
    const invokeUiMethod = async () => {
      if (event.method === "select") {
        const value = await ui.select?.(`${prefix}${event.title ?? "Select"}`, event.options ?? [], dialogOptions);
        respondToUiRequest(event.id, value === undefined ? { cancelled: true } : { value });
        return;
      }
      if (event.method === "confirm") {
        const confirmed = await ui.confirm?.(`${prefix}${event.title ?? "Confirm"}`, String(event.message ?? ""), dialogOptions);
        respondToUiRequest(event.id, { confirmed: Boolean(confirmed) });
        return;
      }
      if (event.method === "input") {
        const value = await ui.input?.(`${prefix}${event.title ?? "Input"}`, event.placeholder, dialogOptions);
        respondToUiRequest(event.id, value === undefined ? { cancelled: true } : { value });
        return;
      }
      if (event.method === "editor") {
        const value = await ui.editor?.(`${prefix}${event.title ?? "Edit"}`, event.prefill, dialogOptions);
        respondToUiRequest(event.id, value === undefined ? { cancelled: true } : { value });
        return;
      }
      if (event.method === "notify") {
        ui.notify?.(`${prefix}${event.message ?? ""}`, event.notifyType);
        return;
      }
      if (event.method === "setStatus") {
        ui.setStatus?.(`delegate-${event.statusKey ?? event.id}`, event.statusText);
        return;
      }
      if (event.method === "setWidget") {
        ui.setWidget?.(`delegate-${event.widgetKey ?? event.id}`, event.widgetLines, { placement: event.widgetPlacement });
        return;
      }
      if (event.method === "setTitle") {
        ui.setTitle?.(String(event.title ?? ""));
        return;
      }
      if (event.method === "set_editor_text") {
        ui.setEditorText?.(String(event.text ?? ""));
      }
    };

    try {
      if (isDialog) {
        await withInputStatus(options.reportInputStatus, inputLabel, invokeUiMethod);
      } else {
        await invokeUiMethod();
      }
    } catch {
      if (isDialog) {
        respondToUiRequest(event.id, { cancelled: true });
      }
    }
  };

  parseJsonl(proc, (event) => {
    const eventUsage = getRpcEventUsage(event);
    if (eventUsage) usage = addUsage(usage, eventUsage);

    if (event.type === "extension_ui_request") {
      const receivedAt = Date.now();
      const handleRequest = () => handleUiRequest(event, receivedAt);
      if (dialogMethods.has(event.method) && options.uiDialogQueue) {
        void options.uiDialogQueue.enqueue(handleRequest);
      } else {
        void handleRequest();
      }
    }

    if (!activePrompt) return;

    activePrompt.onEvent?.(event);

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      const next = appendBoundedText(
        activePrompt,
        event.assistantMessageEvent.delta,
        activePrompt.maxTextChars,
      );
      activePrompt.text = next.text;
      activePrompt.truncated = next.truncated;
      return;
    }

    if (event.type === "response" && event.id === activePrompt.id && event.success === false) {
      const message = event.error || stderrDetail(stderr) || "Worker prompt failed";
      const reject = activePrompt.reject;
      activePrompt.cleanup();
      activePrompt = undefined;
      reject(new Error(message));
      return;
    }

    if (event.type === "agent_settled") {
      const resolve = activePrompt.resolve;
      const { text, truncated } = activePrompt;
      activePrompt.cleanup();
      activePrompt = undefined;
      resolve({ text, truncated });
    }
  });

  proc.on("error", (error) => {
    if (!activePrompt) return;
    const reject = activePrompt.reject;
    activePrompt.cleanup();
    activePrompt = undefined;
    reject(error instanceof Error ? error : new Error(String(error)));
  });

  proc.on("exit", (code, signal) => {
    disposed = true;
    if (!activePrompt) return;

    const reject = activePrompt.reject;
    activePrompt.cleanup();
    activePrompt = undefined;
    const detail = stderrDetail(stderr) || `worker exited with code=${code} signal=${signal}`;
    reject(new Error(detail));
  });

  function send(command: unknown) {
    if (disposed || proc.killed) {
      throw new Error("Worker is not running");
    }
    proc.stdin.write(JSON.stringify(command) + "\n");
  }

  return {
    prompt(message, options = {}) {
      if (activePrompt) {
        return Promise.reject(new Error("Worker already has an active prompt"));
      }

      if (options.signal?.aborted) {
        return Promise.reject(new Error("Worker prompt aborted"));
      }

      if (options.maxTextChars !== undefined && (
        !Number.isSafeInteger(options.maxTextChars) || options.maxTextChars < 1
      )) {
        return Promise.reject(new Error("maxTextChars must be a positive integer"));
      }

      return new Promise<{ text: string; truncated: boolean }>((resolve, reject) => {
        const id = randomId("prompt");
        const abortHandler = () => {
          try {
            send({ type: "abort" });
          } catch {
            // ignore
          }

          if (!activePrompt || activePrompt.id !== id) return;
          const localReject = activePrompt.reject;
          activePrompt.cleanup();
          activePrompt = undefined;
          localReject(new Error("Worker prompt aborted"));
        };

        if (options.signal) {
          options.signal.addEventListener("abort", abortHandler, { once: true });
        }

        activePrompt = {
          id,
          text: "",
          truncated: false,
          maxTextChars: options.maxTextChars ?? MAX_INVESTIGATION_TEXT_CHARS,
          onEvent: options.onEvent,
          resolve,
          reject,
          cleanup: () => {
            if (options.signal) {
              options.signal.removeEventListener("abort", abortHandler);
            }
          },
        };

        try {
          send({ id, type: "prompt", message });
        } catch (error) {
          activePrompt.cleanup();
          activePrompt = undefined;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    getUsage() {
      return addUsage(emptyUsage(), usage);
    },

    abort() {
      try {
        send({ type: "abort" });
      } catch {
        // ignore
      }
    },

    dispose() {
      disposed = true;
      try {
        proc.stdin.end();
      } catch {
        // ignore
      }
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    },
  };
}
