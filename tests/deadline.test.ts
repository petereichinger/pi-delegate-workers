import assert from "node:assert/strict";
import test from "node:test";
import { runTask } from "../extensions/index.ts";
import { emptyUsage } from "../extensions/rpc-worker.ts";
import { createRpcUiDialogQueue } from "../extensions/ui-dialog-queue.ts";

const ctx = {
  cwd: process.cwd(),
  ui: {
    theme: { fg: (_color: string, text: string) => text },
    setWidget: () => undefined,
  },
} as any;

function waitForAbort(signal: AbortSignal | undefined): Promise<{ text: string }> {
  return new Promise((_resolve, reject) => {
    if (!signal) return reject(new Error("Missing abort signal"));
    if (signal.aborted) return reject(new Error("Worker prompt aborted"));
    signal.addEventListener("abort", () => reject(new Error("Worker prompt aborted")), { once: true });
  });
}

function options(createWorker: (...args: any[]) => any, signal?: AbortSignal) {
  return {
    createWorker,
    signal,
    uiDialogQueue: createRpcUiDialogQueue(),
    reportInputStatus: () => undefined,
  };
}

test("deadline expires during investigation and disposes the worker", async () => {
  let disposed = false;
  const result = await runTask(
    ctx,
    new Map(),
    { task: "slow investigation", profile: "balanced", modelSetSource: "none", timeoutMs: 20 },
    "w1",
    options(() => ({
      prompt: (_message: string, { signal }: { signal?: AbortSignal } = {}) => waitForAbort(signal),
      getUsage: emptyUsage,
      abort: () => undefined,
      dispose: () => { disposed = true; },
    })),
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.ok, false);
  assert.match(result.output, /timed out after 20 ms/);
  assert.equal(disposed, true);
});

test("one deadline covers investigation and synthesis", async () => {
  let prompts = 0;
  const result = await runTask(
    ctx,
    new Map(),
    { task: "slow synthesis", profile: "balanced", modelSetSource: "none", timeoutMs: 20 },
    "w2",
    options(() => ({
      prompt: (_message: string, { signal }: { signal?: AbortSignal } = {}) => {
        prompts++;
        return prompts === 1 ? Promise.resolve({ text: "findings" }) : waitForAbort(signal);
      },
      getUsage: emptyUsage,
      abort: () => undefined,
      dispose: () => undefined,
    })),
  );

  assert.equal(prompts, 2);
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
});

test("task tool subset reaches the worker without changing the global allowlist", async () => {
  const previous = process.env.PI_DELEGATE_TOOLS;
  process.env.PI_DELEGATE_TOOLS = "read,write,edit,bash";
  let workerOptions: { tools: string[]; enforceTools?: boolean } | undefined;
  try {
    const result = await runTask(
      ctx,
      new Map(),
      { task: "read only", profile: "balanced", modelSetSource: "none", tools: ["read"] },
      "w5",
      options((settings: { tools: string[]; enforceTools?: boolean }) => {
        workerOptions = settings;
        return {
          prompt: async () => ({ text: "done" }),
          getUsage: emptyUsage,
          abort: () => undefined,
          dispose: () => undefined,
        };
      }),
    );
    assert.deepEqual(workerOptions?.tools, ["read"]);
    assert.equal(workerOptions?.enforceTools, true);
    assert.deepEqual(result.tools, ["read"]);
  } finally {
    if (previous === undefined) delete process.env.PI_DELEGATE_TOOLS;
    else process.env.PI_DELEGATE_TOOLS = previous;
  }
});

test("tasks without deadlines can finish, and parent aborts are cancellations", async () => {
  let prompts = 0;
  const finished = await runTask(
    ctx,
    new Map(),
    { task: "normal", profile: "balanced", modelSetSource: "none" },
    "w3",
    options(() => ({
      prompt: async () => ({ text: ++prompts === 1 ? "findings" : "summary" }),
      getUsage: emptyUsage,
      abort: () => undefined,
      dispose: () => undefined,
    })),
  );
  assert.equal(finished.ok, true);
  assert.equal(finished.timedOut, false);
  assert.equal(finished.output, "summary");

  const controller = new AbortController();
  const cancelled = runTask(
    ctx,
    new Map(),
    { task: "parent cancellation", profile: "balanced", modelSetSource: "none" },
    "w4",
    options(() => ({
      prompt: (_message: string, { signal }: { signal?: AbortSignal } = {}) => waitForAbort(signal),
      getUsage: emptyUsage,
      abort: () => undefined,
      dispose: () => undefined,
    }), controller.signal),
  );
  controller.abort();
  const result = await cancelled;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
});
