import assert from "node:assert/strict";
import test from "node:test";
import {
  DelegationSession,
  type DelegationTaskState,
} from "../extensions/delegation-session.ts";

type Result = { id: string; value: string; state: "completed" | "failed" | "cancelled" };

type Deferred = {
  signal: AbortSignal;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
};

function createHarness(maxWorkers = 2) {
  const started: string[] = [];
  const deferred = new Map<string, Deferred>();
  let running = 0;
  let peakRunning = 0;

  const session = new DelegationSession<string, Result>({
    maxWorkers,
    runTask(task, id, signal) {
      started.push(task);
      running++;
      peakRunning = Math.max(peakRunning, running);
      return new Promise<Result>((resolve, reject) => {
        deferred.set(task, {
          signal,
          resolve(result) {
            running--;
            resolve(result);
          },
          reject(error) {
            running--;
            reject(error);
          },
        });
      });
    },
    classifyResult: (result) => result.state,
    createCancelledResult: (_task, id) => ({ id, value: "cancelled", state: "cancelled" }),
    createFailedResult: (_task, id, error) => ({ id, value: String(error), state: "failed" }),
  });

  const complete = async (task: string, state: Result["state"] = "completed") => {
    const item = deferred.get(task);
    assert.ok(item, `${task} should have started`);
    item.resolve({ id: task, value: task, state });
    await new Promise((resolve) => setImmediate(resolve));
  };

  return {
    session,
    started,
    deferred,
    complete,
    peakRunning: () => peakRunning,
  };
}

test("enforces global concurrency and starts queued work as slots open", async () => {
  const harness = createHarness(2);
  const first = harness.session.createBatch(["one", "two", "three"]);
  const second = harness.session.createBatch(["four"]);

  assert.equal(first.running, 2);
  assert.equal(first.queued, 1);
  assert.equal(second.queued, 1);
  assert.deepEqual(harness.started, ["one", "two"]);

  await harness.complete("one");
  assert.deepEqual(harness.started, ["one", "two", "three"]);
  await harness.complete("two");
  assert.deepEqual(harness.started, ["one", "two", "three", "four"]);
  assert.equal(harness.peakRunning(), 2);
});

test("adds tasks to a running batch and delivers results only once", async () => {
  const harness = createHarness(2);
  const batch = harness.session.createBatch(["one"]);
  harness.session.addTasks(batch.id, ["two", "three"]);

  assert.deepEqual(harness.started, ["one", "two"]);
  await harness.complete("two");
  await harness.complete("one");

  const available = await harness.session.getResults(batch.id, "available");
  assert.deepEqual(available.results.map((result) => result.value), ["two", "one"]);
  assert.equal(available.batch.running, 1);
  assert.equal(available.batch.undelivered, 0);

  const drained = await harness.session.getResults(batch.id, "available");
  assert.deepEqual(drained.results, []);

  await harness.complete("three");
  const final = await harness.session.getResults(batch.id, "all");
  assert.deepEqual(final.results.map((result) => result.value), ["three"]);
  assert.equal(final.batch.terminal, true);
});

test("next waits for a result and supports timeouts", async () => {
  const harness = createHarness(1);
  const batch = harness.session.createBatch(["one"]);

  const timedOut = await harness.session.getResults(batch.id, "next", { timeoutMs: 1 });
  assert.equal(timedOut.timedOut, true);
  assert.deepEqual(timedOut.results, []);

  const pending = harness.session.getResults(batch.id, "next");
  await harness.complete("one");
  const completed = await pending;
  assert.equal(completed.timedOut, false);
  assert.deepEqual(completed.results.map((result) => result.value), ["one"]);
});

test("cancels queued and running workers independently", async () => {
  const harness = createHarness(1);
  const batch = harness.session.createBatch(["one", "two"]);
  const [one, two] = batch.tasks;
  assert.ok(one && two);

  assert.equal(harness.session.cancelWorker(two.id), true);
  assert.equal(harness.session.cancelWorker(two.id), false);
  assert.equal(harness.session.getBatch(batch.id).cancelled, 1);

  assert.equal(harness.session.cancelWorker(one.id), true);
  assert.equal(harness.session.cancelWorker(one.id), false);
  assert.equal(harness.deferred.get("one")?.signal.aborted, true);
  harness.deferred.get("one")?.reject(new Error("aborted"));
  await new Promise((resolve) => setImmediate(resolve));

  const results = await harness.session.getResults(batch.id, "all");
  assert.equal(results.batch.cancelled, 2);
  assert.deepEqual(results.results.map((result) => result.state), ["cancelled", "cancelled"]);
  assert.deepEqual(harness.started, ["one"]);
});

test("shutdown cancels all work and prevents new batches", async () => {
  const states: DelegationTaskState[] = [];
  const session = new DelegationSession<string, Result>({
    maxWorkers: 1,
    runTask(_task, _id, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    classifyResult: (result) => result.state,
    createCancelledResult: (_task, id) => ({ id, value: "cancelled", state: "cancelled" }),
    createFailedResult: (_task, id, error) => ({ id, value: String(error), state: "failed" }),
    onStateChange: (task) => states.push(task.state),
  });
  const batch = session.createBatch(["one", "two"]);
  const waiting = session.getResults(batch.id, "all");

  session.shutdown();
  const result = await waiting;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.batch.terminal, false);
  assert.ok(states.includes("cancelled"));
  assert.throws(() => session.createBatch(["three"]), /shutting down/);
  assert.equal(session.getBatch(batch.id).terminal, true);
});
