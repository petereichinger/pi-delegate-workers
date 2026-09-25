import assert from "node:assert/strict";
import test from "node:test";
import { runTask } from "../extensions/index.ts";
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
  const result = await runTask(
    ctx,
    new Map(),
    { task: "report", profile: "balanced", modelSetSource: "none" },
    "w1",
    {
      uiDialogQueue: createRpcUiDialogQueue(),
      reportInputStatus: () => undefined,
      createWorker: (() => ({
        prompt: async (_message: string, options: { maxTextChars?: number } = {}) => {
          requestedLimits.push(options.maxTextChars!);
          return ++prompts === 1
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
