import assert from "node:assert/strict";
import test from "node:test";
import { createRpcUiDialogQueue } from "../extensions/ui-dialog-queue.ts";

test("RPC UI dialogs run one at a time in arrival order", async () => {
  const queue = createRpcUiDialogQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(async () => {
    events.push("first:start");
    await firstBlocked;
    events.push("first:end");
    return "first";
  });
  const second = queue.enqueue(async () => {
    events.push("second:start");
    events.push("second:end");
    return "second";
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("a cancelled queued dialog is skipped without delaying the next dialog", async () => {
  const queue = createRpcUiDialogQueue();
  const controller = new AbortController();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.enqueue(() => blocked);
  const skipped = queue.enqueue(async () => { throw new Error("cancelled dialog was shown"); }, controller.signal);
  const next = queue.enqueue(async () => "next");

  controller.abort();
  release();
  assert.deepEqual(await Promise.all([first, skipped, next]), [undefined, undefined, "next"]);
});

test("a failed dialog does not stall the queue", async () => {
  const queue = createRpcUiDialogQueue();

  await assert.rejects(
    queue.enqueue(async () => {
      throw new Error("dialog failed");
    }),
    /dialog failed/,
  );

  assert.equal(await queue.enqueue(async () => "next dialog"), "next dialog");
});
