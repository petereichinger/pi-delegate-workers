import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runTask } from "../extensions/index.ts";
import { createRpcWorker } from "../extensions/rpc-worker.ts";
import { createRpcUiDialogQueue } from "../extensions/ui-dialog-queue.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-rpc-worker.mjs", import.meta.url));

function fakeWorker(scenario: string, uiOptions: Record<string, unknown> = {}) {
  return createRpcWorker({
    cwd: process.cwd(),
    tools: ["read"],
    ...uiOptions,
    spawnWorker: (_bin, args, options) => spawn(process.execPath, [fixture, scenario, ...args], options),
  });
}

test("real RPC stream handles two prompts, malformed records, usage, and text limits", { timeout: 5000 }, async () => {
  const worker = fakeWorker("normal");
  try {
    const events: string[] = [];
    const investigation = await worker.prompt("investigate", {
      maxTextChars: 12,
      onEvent: (event) => events.push(event.type),
      signal: AbortSignal.timeout(3000),
    });
    const synthesis = await worker.prompt("summarize", { signal: AbortSignal.timeout(3000) });

    assert.deepEqual(investigation, { text: "first:\u2028xxxxx", truncated: true });
    assert.deepEqual(synthesis, { text: "summary", truncated: false });
    assert.deepEqual(events.filter((event) => event === "agent_settled"), ["agent_settled"]);
    assert.ok(events.indexOf("agent_end") < events.indexOf("agent_settled"));
    assert.equal(worker.getUsage().totalTokens, 15);
    assert.equal(worker.getUsage().cost.total, 0.015);
  } finally {
    worker.dispose();
  }
});

test("real RPC synthesis failure returns investigation fallback", { timeout: 5000 }, async () => {
  const ctx = {
    cwd: process.cwd(),
    ui: { theme: { fg: (_color: string, text: string) => text }, setWidget: () => undefined },
  } as any;
  const result = await runTask(
    ctx,
    new Map(),
    { task: "investigate", profile: "balanced", modelSetSource: "none" },
    "w1",
    {
      uiDialogQueue: createRpcUiDialogQueue(),
      reportInputStatus: () => undefined,
      createWorker: (options) => createRpcWorker({
        ...options,
        spawnWorker: (_bin, args, spawnOptions) => spawn(
          process.execPath,
          [fixture, "second-error", ...args],
          spawnOptions,
        ),
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.output, `first:\u2028${"x".repeat(50)}`);
  assert.equal(result.usage.totalTokens, 10);
});

test("RPC prompt rejection reports the matching command error", { timeout: 5000 }, async () => {
  const worker = fakeWorker("error");
  try {
    await assert.rejects(worker.prompt("reject", { signal: AbortSignal.timeout(3000) }), /prompt rejected/);
  } finally {
    worker.dispose();
  }
});

test("RPC startup failure rejects the prompt", { timeout: 5000 }, async () => {
  const missingBinary = fileURLToPath(new URL("./fixtures/no-such-pi-binary", import.meta.url));
  const worker = createRpcWorker({
    cwd: process.cwd(),
    tools: ["read"],
    spawnWorker: (_bin, args, options) => spawn(missingBinary, args, options),
  });
  try {
    await assert.rejects(worker.prompt("start", { signal: AbortSignal.timeout(3000) }), /ENOENT/);
  } finally {
    worker.dispose();
  }
});

test("unexpected RPC exit reports bounded stderr", { timeout: 5000 }, async () => {
  const worker = fakeWorker("exit");
  try {
    await assert.rejects(
      worker.prompt("exit", { signal: AbortSignal.timeout(3000) }),
      (error: Error) => {
        assert.match(error.message, /^\[earlier stderr truncated\]/);
        assert.ok(error.message.endsWith("failure at end"));
        assert.ok(error.message.length <= 8_250);
        return true;
      },
    );
  } finally {
    worker.dispose();
  }
});

test("RPC abort is sent to the child and rejects the active prompt", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  let receivedAbort: () => void = () => undefined;
  const abortedByChild = new Promise<void>((resolve) => { receivedAbort = resolve; });
  const worker = fakeWorker("stall", {
    ui: { notify: (message: string) => { if (message.includes("abort received")) receivedAbort(); } },
  });
  try {
    const result = worker.prompt("stall", { signal: controller.signal });
    controller.abort();
    await assert.rejects(result, /Worker prompt aborted/);
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        abortedByChild,
        new Promise<never>((_resolve, reject) => {
          abortTimer = setTimeout(() => reject(new Error("abort not sent")), 3000);
        }),
      ]);
    } finally {
      clearTimeout(abortTimer);
    }
  } finally {
    worker.dispose();
  }
});

test("real RPC worker deadline reports timeout and stops the child", { timeout: 5000 }, async () => {
  const ctx = {
    cwd: process.cwd(),
    ui: { theme: { fg: (_color: string, text: string) => text }, setWidget: () => undefined },
  } as any;
  let child: ChildProcessWithoutNullStreams | undefined;
  const result = await runTask(
    ctx,
    new Map(),
    { task: "stall", profile: "balanced", modelSetSource: "none", timeoutMs: 250 },
    "w2",
    {
      uiDialogQueue: createRpcUiDialogQueue(),
      reportInputStatus: () => undefined,
      createWorker: (options) => createRpcWorker({
        ...options,
        spawnWorker: (_bin, args, spawnOptions) => {
          child = spawn(process.execPath, [fixture, "stall", ...args], spawnOptions);
          return child;
        },
      }),
    },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(child?.killed, true);
});

test("disposing an active RPC worker terminates its child", { timeout: 5000 }, async () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  const worker = createRpcWorker({
    cwd: process.cwd(),
    tools: ["read"],
    spawnWorker: (_bin, args, options) => {
      child = spawn(process.execPath, [fixture, "stall", ...args], options);
      return child;
    },
  });
  const prompt = worker.prompt("stall", { signal: AbortSignal.timeout(3000) });
  worker.dispose();
  await assert.rejects(prompt, /worker exited/);
  assert.equal(child?.killed, true);
});

test("RPC dialog is forwarded and its response reaches the worker", { timeout: 5000 }, async () => {
  const statuses: boolean[] = [];
  const worker = fakeWorker("dialog", {
    uiPrefix: "w5",
    uiDialogQueue: createRpcUiDialogQueue(),
    reportInputStatus: (active: boolean) => { statuses.push(active); },
    ui: {
      confirm: async (title: string, message: string) => {
        assert.equal(title, "[w5] Approve");
        assert.equal(message, "Continue?");
        return true;
      },
    },
  });
  try {
    assert.deepEqual(
      await worker.prompt("ask", { signal: AbortSignal.timeout(3000) }),
      { text: "confirmed", truncated: false },
    );
    assert.deepEqual(statuses, [true, false]);
  } finally {
    worker.dispose();
  }
});
