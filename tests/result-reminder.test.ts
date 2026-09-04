import assert from "node:assert/strict";
import test from "node:test";
import { shouldSendResultReminder } from "../extensions/index.ts";

const availableResult = { undelivered: 1 };
const baseOptions = {
  sessionShuttingDown: false,
  alreadyAnnounced: false,
  activelyCollecting: false,
  parentIdle: true,
  force: false,
};

test("wakes an idle parent for any uncollected result", () => {
  assert.equal(shouldSendResultReminder(availableResult, baseOptions), true);
});

test("coalesces completions while the parent is active", () => {
  assert.equal(shouldSendResultReminder(availableResult, {
    ...baseOptions,
    parentIdle: false,
  }), false);
});

test("flushes a pending completion when the parent settles", () => {
  assert.equal(shouldSendResultReminder(availableResult, {
    ...baseOptions,
    parentIdle: false,
    force: true,
  }), true);
});

test("defers reminders while the parent is already collecting the batch", () => {
  assert.equal(shouldSendResultReminder(availableResult, {
    ...baseOptions,
    activelyCollecting: true,
    force: true,
  }), false);
});

test("does not send stale, duplicate, or empty result reminders", () => {
  assert.equal(shouldSendResultReminder(availableResult, {
    ...baseOptions,
    sessionShuttingDown: true,
  }), false);
  assert.equal(shouldSendResultReminder(availableResult, {
    ...baseOptions,
    alreadyAnnounced: true,
  }), false);
  assert.equal(shouldSendResultReminder({ undelivered: 0 }, baseOptions), false);
});
