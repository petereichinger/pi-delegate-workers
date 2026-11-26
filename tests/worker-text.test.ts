import assert from "node:assert/strict";
import test from "node:test";
import { activeJobStatus, runTask } from "../extensions/index.ts";
import {
  appendBoundedText,
  emptyUsage,
  MAX_INVESTIGATION_TEXT_CHARS,
  MAX_SYNTHESIS_TEXT_CHARS,
} from "../extensions/rpc-worker.ts";
import { createRpcUiDialogQueue } from "../extensions/ui-dialog-queue.ts";

test("bounds captured assistant text while preserving its prefix", () => {
  let capture = { text: "", truncated: false };
  capture = appendBoundedText(capture, "first", 8);
  assert.deepEqual(capture, { text: "first", truncated: false });
  capture = appendBoundedText(capture, "second", 8);
  assert.deepEqual(capture, { text: "firstsec", truncated: true });
  capture = appendBoundedText(capture, "third", 8);
  assert.deepEqual(capture, { text: "firstsec", truncated: true });

  const huge = appendBoundedText({ text: "", truncated: false }, "a".repeat(100_000), 32_768);
  assert.equal(huge.text.length, 32_768);
  assert.equal(huge.truncated, true);
});

test("investigation and synthesis use distinct capture limits and report clipped summaries", async () => {
  const requestedLimits: number[] = [];
  const ctx = {
    cwd: process.cwd(),
    ui: { theme: { fg: (_color: string, text: string) => text }, setWidget: () => undefined },
  } as any;
  let prompts = 0;
  const workers: Parameters<typeof runTask>[1] = new Map();
  const snapshots: ReturnType<typeof activeJobStatus>[] = [];
  const result = await runTask(
    ctx,
    workers,
    { task: "report", profile: "balanced", modelSetSource: "none" },
    "w1",
    {
      uiDialogQueue: createRpcUiDialogQueue(),
      reportInputStatus: () => undefined,
      createWorker: (() => ({
        prompt: async (_message: string, { maxTextChars, onEvent }: { maxTextChars: number; onEvent: (event: unknown) => void }) => {
          requestedLimits.push(maxTextChars);
          ++prompts;
          onEvent({ type: "agent_start" });
          onEvent({ type: "tool_execution_start", toolCallId: "first", toolName: "read", args: { path: "private.txt" } });
          onEvent({ type: "tool_execution_start", toolCallId: "second", toolName: "bash", args: { command: "private command" } });
          snapshots.push(activeJobStatus(workers.get("w1")!));
          onEvent({ type: "tool_execution_end", toolCallId: "second" });
          snapshots.push(activeJobStatus(workers.get("w1")!));
          onEvent({ type: "tool_execution_end", toolCallId: "first" });
          snapshots.push(activeJobStatus(workers.get("w1")!));
          return prompts === 1
            ? { text: "investigation", truncated: true }
            : { text: "summary", truncated: true };
        },
        getUsage: emptyUsage,
        abort: () => undefined,
        dispose: () => undefined,
      })) as any,
    },
  );

  assert.deepEqual(requestedLimits, [MAX_INVESTIGATION_TEXT_CHARS, MAX_SYNTHESIS_TEXT_CHARS]);
  const base = { id: "w1", label: "report" };
  assert.deepEqual(snapshots, [
    { ...base, status: "running", tool: "bash" },
    { ...base, status: "running", tool: "read" },
    { ...base, status: "running", progress: "Thinking about the next step" },
    { ...base, status: "synthesizing", tool: "bash" },
    { ...base, status: "synthesizing", tool: "read" },
    { ...base, status: "synthesizing", progress: "Synthesizing findings" },
  ]);
  assert.equal(result.rawOutput, "investigation");
  assert.equal(result.output, "summary\n\n[synthesis text truncated before returning to parent agent]");
});

test("marks an investigation capture limit when synthesis fails", async () => {
  const ctx = {
    cwd: process.cwd(),
    ui: { theme: { fg: (_color: string, text: string) => text }, setWidget: () => undefined },
  } as any;
  let prompts = 0;
  const result = await runTask(
    ctx,
    new Map(),
    { task: "report", profile: "balanced", modelSetSource: "none" },
    "w2",
    {
      uiDialogQueue: createRpcUiDialogQueue(),
      reportInputStatus: () => undefined,
      createWorker: (() => ({
        prompt: async () => {
          if (++prompts === 1) return { text: "findings", truncated: true };
          throw new Error("Synthesis failed");
        },
        getUsage: emptyUsage,
        abort: () => undefined,
        dispose: () => undefined,
      })) as any,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.output, "findings\n\n[investigation text capture truncated; worker context unchanged]");
});
