import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRpcWorker, type RpcEvent, type RpcWorker } from "./rpc-worker.ts";

type WorkerState = {
  id: string;
  task: string;
  status: string;
  output: string;
  worker: RpcWorker;
};

type DelegatedResult = {
  id: string;
  task: string;
  ok: boolean;
  output: string;
  rawOutput: string;
  summaryOutput: string;
  durationMs: number;
};

const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
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
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_WORKERS;
}

function parseTasks(text: string): string[] {
  return text
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildWorkerPrompt(task: string, sharedContext?: string): string {
  return [
    "You are a focused delegated worker inside a codebase.",
    "",
    "Rules:",
    "- stay tightly scoped to the assigned task",
    "- use only the available tools",
    "- do not modify files",
    "- cite concrete file paths when possible",
    "- gather the evidence you need, then stop; a separate synthesis pass will follow",
    sharedContext ? "" : undefined,
    sharedContext ? "Shared context:" : undefined,
    sharedContext,
    "",
    "Assigned task:",
    task,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
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

function formatResults(results: DelegatedResult[]): string {
  return results
    .map((result) => {
      const header = `## ${result.id} — ${result.task}`;
      const status = result.ok ? "ok" : "error";
      const body = result.output.trim() || "(no output)";
      return `${header}\n\nstatus: ${status}\nduration_ms: ${result.durationMs}\n\n${body}`;
    })
    .join("\n\n---\n\n");
}

function refreshUi(ctx: ExtensionContext, workers: Map<string, WorkerState>) {
  if (workers.size === 0) {
    ctx.ui.setStatus("delegate-workers", undefined);
    ctx.ui.setWidget("delegate-workers", ["delegate: idle"]);
    return;
  }

  const lines = ["delegate workers:"];
  for (const worker of workers.values()) {
    lines.push(`[${worker.id}] ${worker.status} :: ${worker.task}`);
  }

  ctx.ui.setWidget("delegate-workers", lines);
  ctx.ui.setStatus("delegate-workers", `${workers.size} active`);
}

async function runTask(
  ctx: ExtensionContext,
  workers: Map<string, WorkerState>,
  task: string,
  id: string,
  options: { signal?: AbortSignal; sharedContext?: string }
): Promise<DelegatedResult> {
  const worker = createRpcWorker({ cwd: ctx.cwd, tools: getWorkerTools() });
  const state: WorkerState = {
    id,
    task,
    status: "starting",
    output: "",
    worker,
  };

  workers.set(id, state);
  refreshUi(ctx, workers);
  const startedAt = Date.now();

  const onEvent = (event: RpcEvent) => {
    if (event.type === "agent_start") {
      state.status = "running";
      refreshUi(ctx, workers);
      return;
    }

    if (event.type === "tool_execution_start") {
      state.status = `tool:${event.toolName}`;
      refreshUi(ctx, workers);
      return;
    }

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      state.output += event.assistantMessageEvent.delta;
      return;
    }

    if (event.type === "agent_end") {
      state.status = "done";
      refreshUi(ctx, workers);
    }
  };

  try {
    const investigation = await worker.prompt(buildWorkerPrompt(task, options.sharedContext), {
      onEvent,
      signal: options.signal,
    });

    state.status = "synthesizing";
    state.output = "";
    refreshUi(ctx, workers);

    let summaryText = truncateFallback(investigation.text);
    try {
      const summary = await worker.prompt(buildSummaryPrompt(task), {
        signal: options.signal,
        onEvent: (event: RpcEvent) => {
          if (event.type === "agent_start") {
            state.status = "synthesizing";
            refreshUi(ctx, workers);
            return;
          }

          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta"
          ) {
            state.output += event.assistantMessageEvent.delta;
            return;
          }

          if (event.type === "agent_end") {
            state.status = "done";
            refreshUi(ctx, workers);
          }
        },
      });

      summaryText = summary.text.trim() || summaryText;
    } catch {
      state.output = summaryText;
    }

    state.output = summaryText;
    state.status = "done";
    refreshUi(ctx, workers);

    return {
      id,
      task,
      ok: true,
      output: summaryText,
      rawOutput: investigation.text,
      summaryOutput: summaryText,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.status = "error";
    refreshUi(ctx, workers);

    return {
      id,
      task,
      ok: false,
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
  let nextWorkerId = 1;

  const makeWorkerId = () => `w${nextWorkerId++}`;

  pi.on("session_start", async (_event, ctx) => {
    refreshUi(ctx, workers);
  });

  pi.on("session_shutdown", async () => {
    for (const worker of workers.values()) {
      worker.worker.dispose();
    }
    workers.clear();
  });

  pi.registerCommand("delegate", {
    description: "Delegate parallel read-only tasks: /delegate task A | task B | task C",
    handler: async (args, ctx) => {
      const tasks = parseTasks(args);
      const maxWorkers = getMaxWorkers();

      if (tasks.length === 0) {
        ctx.ui.notify("Usage: /delegate task A | task B | task C", "warning");
        return;
      }

      if (tasks.length > maxWorkers) {
        ctx.ui.notify(`Too many tasks. Max is ${maxWorkers}.`, "warning");
        return;
      }

      ctx.ui.notify(`Launching ${tasks.length} delegate worker(s)...`, "info");
      const results = await Promise.all(
        tasks.map((task) => runTask(ctx, workers, task, makeWorkerId(), {}))
      );
      const combined = formatResults(results);

      if (!ctx.hasUI) {
        if (ctx.isIdle()) {
          pi.sendUserMessage([
            { type: "text", text: "I ran delegated workers. Please synthesize their results." },
            { type: "text", text: combined },
          ]);
        } else {
          pi.sendUserMessage(
            [
              { type: "text", text: "I ran delegated workers. Please synthesize their results." },
              { type: "text", text: combined },
            ],
            { deliverAs: "followUp" }
          );
        }
        return;
      }

      const choice = await ctx.ui.select("Delegation complete", [
        "Summarize in chat",
        "Open raw results",
        "Both",
        "Do nothing",
      ]);

      if (choice === "Open raw results" || choice === "Both") {
        await ctx.ui.editor("Delegation results", combined);
      }

      if (choice === "Summarize in chat" || choice === "Both") {
        const payload = [
          { type: "text", text: "I ran delegated workers. Please synthesize their results for me." },
          { type: "text", text: combined },
        ];

        if (ctx.isIdle()) {
          pi.sendUserMessage(payload);
        } else {
          pi.sendUserMessage(payload, { deliverAs: "followUp" });
        }
      }
    },
  });

  pi.registerTool({
    name: "delegate_tasks",
    label: "Delegate Tasks",
    description: "Run multiple focused read-only tasks in parallel using pi RPC workers",
    promptSnippet: "Run a few independent read-only investigation tasks in parallel and return combined findings.",
    promptGuidelines: [
      "Use delegate_tasks for independent research or code-reading subtasks that can run in parallel.",
      "Use delegate_tasks only for tasks that do not need to modify files.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(Type.String(), { minItems: 1, maxItems: DEFAULT_MAX_WORKERS }),
      sharedContext: Type.Optional(Type.String({ description: "Extra context to prepend to each worker task" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const maxWorkers = getMaxWorkers();
      if (params.tasks.length > maxWorkers) {
        throw new Error(`Too many tasks. Max is ${maxWorkers}.`);
      }

      onUpdate?.({
        content: [{ type: "text", text: `Launching ${params.tasks.length} delegate worker(s)...` }],
      });

      const results = await Promise.all(
        params.tasks.map((task) =>
          runTask(ctx, workers, task, makeWorkerId(), {
            signal,
            sharedContext: params.sharedContext,
          })
        )
      );

      const combined = formatResults(results);
      const failed = results.filter((result) => !result.ok).length;

      return {
        content: [{ type: "text", text: combined }],
        details: {
          taskCount: results.length,
          failedTasks: failed,
        },
      };
    },
  });
}
