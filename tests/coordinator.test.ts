import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  createWorkerCoordinator,
  acquireWorkerSlot,
  resumeWorkerSlot,
  yieldWorkerSlot,
} from "../extensions/coordinator.ts";
import { scheduleTask } from "../extensions/index.ts";
import { emptyUsage } from "../extensions/rpc-worker.ts";
import { createRpcUiDialogQueue } from "../extensions/ui-dialog-queue.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const ctx = {
  cwd: process.cwd(),
  ui: {
    theme: { fg: (_color: string, text: string) => text },
    setWidget: () => undefined,
  },
} as any;

function taskOptions(createWorker: (...args: any[]) => any, signal?: AbortSignal) {
  return {
    createWorker,
    signal,
    uiDialogQueue: createRpcUiDialogQueue(),
    reportInputStatus: () => undefined,
  };
}

test("coordinator queues clients in order and releases slots on disconnect", { timeout: 5000 }, async () => {
  const coordinator = await createWorkerCoordinator({ maxActive: 2, maxLive: 30 });
  try {
    const first = await coordinator.acquire();
    const second = await acquireWorkerSlot(coordinator.endpoint);
    const third = coordinator.acquire();
    const fourth = coordinator.acquire();
    const controller = new AbortController();
    const cancelled = coordinator.acquire(controller.signal);
    let thirdStarted = false;
    void third.then(() => { thirdStarted = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(thirdStarted, false);
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    first.release();
    const thirdSlot = await third;
    assert.equal(thirdStarted, true);
    thirdSlot.release();
    const fourthSlot = await fourth;
    fourthSlot.release();
    second.release();
  } finally {
    await coordinator.close();
  }
});

test("coordinator handles a slot held by a separate process", { timeout: 5000 }, async () => {
  const coordinator = await createWorkerCoordinator({ maxActive: 1, maxLive: 2 });
  const script = `import { acquireWorkerSlot } from ${JSON.stringify(new URL("../extensions/coordinator.ts", import.meta.url).href)};
const slot = await acquireWorkerSlot(process.env.PI_DELEGATE_COORDINATOR_ENDPOINT);
process.stdout.write("ready\\n");
process.stdin.resume();
process.stdin.on("end", () => { slot.release(); process.exit(0); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_DELEGATE_COORDINATOR_ENDPOINT: coordinator.endpoint },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", (chunk: Buffer) => chunk.toString().includes("ready") ? resolve() : reject(new Error("No readiness signal")));
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Child exited early: ${code}`)));
    });
    const waiting = coordinator.acquire();
    child.stdin.end();
    const slot = await waiting;
    slot.release();
  } finally {
    child.kill();
    await coordinator.close();
  }
});

test("waiting parent releases active capacity but retains live capacity", { timeout: 5000 }, async () => {
  const coordinator = await createWorkerCoordinator({ maxActive: 1, maxLive: 2, maxDepth: 2 });
  try {
    const parent = await coordinator.acquire(undefined, 1);
    const otherRoot = coordinator.acquire();
    await yieldWorkerSlot(coordinator.endpoint, parent.token);
    const child = await coordinator.acquire(undefined, 2, parent.token);
    const resuming = resumeWorkerSlot(coordinator.endpoint, parent.token);
    child.release();
    await resuming;
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(coordinator.acquire(abort.signal, 2, parent.token), /cancelled/);
    parent.release();
    const root = await otherRoot;
    root.release();
  } finally {
    await coordinator.close();
  }
});

test("parent disconnect cancels descendants and queued children", { timeout: 5000 }, async () => {
  const coordinator = await createWorkerCoordinator({ maxActive: 2, maxLive: 2, maxDepth: 2 });
  try {
    const parent = await coordinator.acquire();
    const child = await coordinator.acquire(undefined, 2, parent.token);
    const queued = coordinator.acquire(undefined, 2, parent.token);
    await new Promise((resolve) => setTimeout(resolve, 10));
    parent.release();
    await assert.rejects(queued, /connection closed|Invalid worker coordinator response/);
    await new Promise<void>((resolve) => {
      if (child.signal.aborted) resolve();
      else child.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const root = await coordinator.acquire();
    root.release();
  } finally {
    await coordinator.close();
  }
});

test("live-process reserve prevents waiting roots from blocking their children", { timeout: 5000 }, async () => {
  const coordinator = await createWorkerCoordinator({ maxActive: 2, maxLive: 2, maxDepth: 2 });
  try {
    const first = await coordinator.acquire();
    const second = coordinator.acquire();
    await yieldWorkerSlot(coordinator.endpoint, first.token);
    const child = await coordinator.acquire(undefined, 2, first.token);
    await yieldWorkerSlot(coordinator.endpoint, child.token);
    child.release();
    first.release();
    const root = await second;
    root.release();
  } finally {
    await coordinator.close();
  }
});

test("queued cancellation never spawns and its deadline starts after launch", { timeout: 5000 }, async () => {
  const coordinator = await createWorkerCoordinator({ maxActive: 1, maxLive: 3 });
  const workers = new Map();
  const queued = new Map();
  const blocker = await coordinator.acquire();
  let spawned = 0;
  const createWorker = () => {
    spawned++;
    return {
      prompt: async () => ({ text: "done" }),
      getUsage: emptyUsage,
      abort: () => undefined,
      dispose: () => undefined,
    };
  };
  try {
    const cancelled = scheduleTask(ctx, workers, queued, coordinator,
      { task: "cancel", profile: "fast", modelSetSource: "none" }, "w1", taskOptions(createWorker));
    const state = queued.get("w1") as { abortController: AbortController };
    state.abortController.abort();
    const result = await cancelled;
    assert.equal(result.cancelled, true);
    assert.equal(spawned, 0);

    const second = scheduleTask(ctx, workers, queued, coordinator,
      { task: "wait", profile: "fast", modelSetSource: "none", timeoutMs: 10 }, "w2", taskOptions(createWorker));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spawned, 0);
    assert.equal(queued.has("w2"), true);
    blocker.release();
    const finished = await second;
    assert.equal(finished.ok, true);
    assert.ok((finished.queueWaitMs ?? 0) >= 20);
    assert.equal(spawned, 1);
    assert.equal(queued.size, 0);
  } finally {
    blocker.release();
    await coordinator.close();
  }
});

test("overlapping scheduled tasks share the active limit and pass the endpoint to workers", { timeout: 5000 }, async () => {
  const coordinator = await createWorkerCoordinator({ maxActive: 1, maxLive: 3 });
  const workers = new Map();
  const queued = new Map();
  const releaseFirst = deferred<void>();
  const firstStarted = deferred<void>();
  const workerEndpoints: string[] = [];
  let spawned = 0;
  const createWorker = (options: { coordinatorEndpoint: string }) => {
    workerEndpoints.push(options.coordinatorEndpoint);
    const order = ++spawned;
    let prompts = 0;
    return {
      prompt: async () => {
        if (order === 1 && ++prompts === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { text: "done" };
      },
      getUsage: emptyUsage,
      abort: () => undefined,
      dispose: () => undefined,
    };
  };
  try {
    const first = scheduleTask(ctx, workers, queued, coordinator,
      { task: "first", profile: "fast", modelSetSource: "none" }, "w1", taskOptions(createWorker));
    await firstStarted.promise;
    const second = scheduleTask(ctx, workers, queued, coordinator,
      { task: "second", profile: "fast", modelSetSource: "none" }, "w2", taskOptions(createWorker));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(spawned, 1);
    assert.equal(queued.has("w2"), true);
    releaseFirst.resolve();
    assert.deepEqual((await Promise.all([first, second])).map((result) => result.ok), [true, true]);
    assert.deepEqual(workerEndpoints, [coordinator.endpoint, coordinator.endpoint]);
    assert.equal(queued.size, 0);
  } finally {
    releaseFirst.resolve();
    await coordinator.close();
  }
});

test("coordinator shutdown aborts a running worker and rejects queued requests", { timeout: 5000 }, async () => {
  const coordinator = await createWorkerCoordinator({ maxActive: 1, maxLive: 3 });
  const workers = new Map();
  const queued = new Map();
  const started = deferred<void>();
  const createWorker = () => ({
    prompt: (_message: string, options: { signal: AbortSignal }) => {
      started.resolve();
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
    getUsage: emptyUsage,
    abort: () => undefined,
    dispose: () => undefined,
  });
  const first = scheduleTask(ctx, workers, queued, coordinator,
    { task: "first", profile: "fast", modelSetSource: "none" }, "w1", taskOptions(createWorker));
  await started.promise;
  const second = scheduleTask(ctx, workers, queued, coordinator,
    { task: "second", profile: "fast", modelSetSource: "none" }, "w2", taskOptions(createWorker));
  await coordinator.close();
  assert.equal((await first).cancelled, true);
  assert.equal((await second).ok, false);
  assert.equal(workers.size, 0);
  assert.equal(queued.size, 0);
});
