import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type RpcEvent = any;

export type RpcWorker = {
  prompt(
    message: string,
    options?: { onEvent?: (event: RpcEvent) => void; signal?: AbortSignal }
  ): Promise<{ text: string }>;
  abort(): void;
  dispose(): void;
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

export function createRpcWorker(options: { cwd: string; tools: string[] }): RpcWorker {
  const bin = process.env.PI_DELEGATE_PI_BIN || "pi";
  const proc = spawn(
    bin,
    ["--mode", "rpc", "--no-session", "--tools", options.tools.join(",")],
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

  parseJsonl(proc, (event) => {
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
