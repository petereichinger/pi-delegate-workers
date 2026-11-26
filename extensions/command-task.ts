import { StringDecoder } from "node:string_decoder";
import {
  createLocalBashOperations,
  createLocalPowerShellOperations,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

export const SHELLS = ["bash", "powershell"] as const;
export type Shell = typeof SHELLS[number];
export type CommandRequest = { command: string; shell?: Shell; timeoutMs?: number };
export type CommandTask = { task: string; shell: Shell; timeoutMs?: number; shellPath?: string; prefix?: string };

export async function authorizeCommand(
  pi: ExtensionAPI,
  ctx: ExtensionToolContext,
  request: CommandRequest,
  signal: AbortSignal,
): Promise<CommandTask> {
  const shell = request.shell ?? "bash";
  if (!SHELLS.includes(shell) || !request.command.trim()) throw new Error("A non-empty shell command is required.");
  if (!ctx.tools.some((tool) => tool.name === shell)) throw new Error(`The ${shell} tool is not available in this session.`);
  const { shellPath, shellCommandPrefix: prefix } = shell === "bash" ? pi.getSettings() : {};
  signal.throwIfAborted();
  const decisions: Promise<string | null>[] = [];
  pi.events.emit("tool-guard:authorize-shell:v1", {
    ctx,
    shell,
    command: request.command,
    respond: (decision: Promise<string | null>) => decisions.push(decision),
  });
  if (decisions.length === 0) throw new Error("Direct command delegation requires pi-tool-guard with shell authorization support.");
  const reasons = await Promise.all(decisions);
  signal.throwIfAborted();
  for (const reason of reasons) {
    if (reason !== null) throw new Error(typeof reason === "string" ? reason : "Invalid tool-guard decision.");
  }
  return { task: request.command, shell, timeoutMs: request.timeoutMs, shellPath, prefix };
}

const MAX_OUTPUT_CHARS = 16_384;

export async function executeCommand(task: CommandTask, cwd: string, signal: AbortSignal) {
  const backend = task.shell === "bash"
    ? createLocalBashOperations({ shellPath: task.shellPath })
    : createLocalPowerShellOperations();
  const decoder = new StringDecoder("utf8");
  let output = "";
  let truncated = false;
  const append = (text: string) => {
    const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufff9-\ufffb]/g, "");
    const remaining = MAX_OUTPUT_CHARS - output.length;
    output += clean.slice(0, remaining);
    truncated ||= clean.length > remaining;
  };
  let exitCode: number | null = null;
  let error: string | undefined;
  try {
    ({ exitCode } = await backend.exec(task.prefix ? `${task.prefix}\n${task.task}` : task.task, cwd, {
      signal,
      onData: (data) => append(decoder.write(data)),
    }));
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    append(decoder.end());
  }
  if (truncated) output += "\n[command output truncated]";
  return { exitCode, output, error };
}
