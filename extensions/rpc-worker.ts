import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RpcEvent = any;

export type RpcWorker = {
  prompt(
    message: string,
    options?: { onEvent?: (event: RpcEvent) => void; signal?: AbortSignal }
  ): Promise<{ text: string }>;
  abort(): void;
  dispose(): void;
};

type RpcUi = {
  select?: (title: string, options: string[], optionsArg?: any) => Promise<string | undefined>;
  confirm?: (title: string, message?: string, optionsArg?: any) => Promise<boolean>;
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
  onEvent?: (event: RpcEvent) => void;
  resolve: (value: { text: string }) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseJsonl(proc: ChildProcessWithoutNullStreams, onEvent: (event: RpcEvent) => void) {
  let buffer = "";

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

function buildWorkerArgs(tools: string[]): string[] {
  const extraArgs = splitExtraArgs(process.env.PI_DELEGATE_EXTRA_ARGS);
  const args = ["--mode", "rpc", "--no-session", "--tools", tools.join(",")];
  const toolGuardExtension = resolveToolGuardExtension();
  if (toolGuardExtension && !isDisabled(process.env.PI_DELEGATE_TOOL_GUARD_ISOLATE) && !hasNoExtensionsArg(extraArgs)) {
    args.push("--no-extensions");
  }
  if (toolGuardExtension && !hasToolGuardExtensionArg(extraArgs)) {
    args.push("--extension", toolGuardExtension);
  }
  args.push(...extraArgs);
  return args;
}

export function createRpcWorker(options: { cwd: string; tools: string[]; ui?: RpcUi; uiPrefix?: string }): RpcWorker {
  const bin = process.env.PI_DELEGATE_PI_BIN || "pi";
  const proc = spawn(
    bin,
    buildWorkerArgs(options.tools),
    {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  let disposed = false;
  let stderr = "";
  let activePrompt: ActivePrompt | undefined;

  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const respondToUiRequest = (id: string, response: Record<string, unknown>) => {
    try {
      send({ type: "extension_ui_response", id, ...response });
    } catch {
      // ignore; the worker may already be gone
    }
  };

  const handleUiRequest = async (event: any) => {
    const ui = options.ui;
    if (!event.id || !ui) {
      if (event.id && ["select", "confirm", "input", "editor"].includes(event.method)) {
        respondToUiRequest(event.id, { cancelled: true });
      }
      return;
    }

    const prefix = options.uiPrefix ? `[${options.uiPrefix}] ` : "[delegate worker] ";
    try {
      if (event.method === "select") {
        const value = await ui.select?.(`${prefix}${event.title ?? "Select"}`, event.options ?? [], { timeout: event.timeout });
        respondToUiRequest(event.id, value === undefined ? { cancelled: true } : { value });
        return;
      }
      if (event.method === "confirm") {
        const confirmed = await ui.confirm?.(`${prefix}${event.title ?? "Confirm"}`, event.message, { timeout: event.timeout });
        respondToUiRequest(event.id, { confirmed: Boolean(confirmed) });
        return;
      }
      if (event.method === "input") {
        const value = await ui.input?.(`${prefix}${event.title ?? "Input"}`, event.placeholder, { timeout: event.timeout });
        respondToUiRequest(event.id, value === undefined ? { cancelled: true } : { value });
        return;
      }
      if (event.method === "editor") {
        const value = await ui.editor?.(`${prefix}${event.title ?? "Edit"}`, event.prefill, { timeout: event.timeout });
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
    } catch {
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        respondToUiRequest(event.id, { cancelled: true });
      }
    }
  };

  parseJsonl(proc, (event) => {
    if (event.type === "extension_ui_request") {
      void handleUiRequest(event);
    }

    if (!activePrompt) return;

    activePrompt.onEvent?.(event);

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      activePrompt.text += event.assistantMessageEvent.delta;
      return;
    }

    if (event.type === "response" && event.id === activePrompt.id && event.success === false) {
      const message = event.error || stderr || "Worker prompt failed";
      const reject = activePrompt.reject;
      activePrompt.cleanup();
      activePrompt = undefined;
      reject(new Error(message));
      return;
    }

    if (event.type === "agent_end") {
      const resolve = activePrompt.resolve;
      const text = activePrompt.text;
      activePrompt.cleanup();
      activePrompt = undefined;
      resolve({ text });
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
    const detail = stderr.trim() || `worker exited with code=${code} signal=${signal}`;
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

      return new Promise<{ text: string }>((resolve, reject) => {
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
