import assert from "node:assert/strict";
import test from "node:test";
import { withInputStatus } from "../extensions/rpc-worker.ts";

test("reports delegated worker input as blocked until the dialog settles", async () => {
  const states: Array<{ active: boolean; label?: string }> = [];
  const result = await withInputStatus(
    (active, label) => states.push({ active, label }),
    "[w1] Allow command?",
    async () => "allowed",
  );

  assert.equal(result, "allowed");
  assert.deepEqual(states, [
    { active: true, label: "[w1] Allow command?" },
    { active: false, label: undefined },
  ]);
});

test("clears delegated worker input status when the dialog fails", async () => {
  const states: boolean[] = [];

  await assert.rejects(() => withInputStatus(
    (active) => states.push(active),
    "[w1] Allow command?",
    async () => { throw new Error("cancelled"); },
  ));

  assert.deepEqual(states, [true, false]);
});

test("status reporting failures do not break delegated worker dialogs", async () => {
  const result = await withInputStatus(
    () => { throw new Error("Herdr unavailable"); },
    "[w1] Allow command?",
    async () => "allowed",
  );

  assert.equal(result, "allowed");
});
