import assert from "node:assert/strict";
import test from "node:test";
import {
  deferUntilAfterAgentSettled,
  shouldSendResultReminder,
} from "../extensions/index.ts";

const availableResult = { undelivered: 1 };
const baseOptions = {
  sessionShuttingDown: false,
  alreadyAnnounced: false,
  activelyCollecting: false,
  parentIdle: true,
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

test("defers reminder work beyond the agent_settled handler", async () => {
  let called = false;
  deferUntilAfterAgentSettled(() => {
    called = true;
  });

  assert.equal(called, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(called, true);
});

test("defers reminders while the parent is already collecting the batch", () => {
  assert.equal(shouldSendResultReminder(availableResult, {
    ...baseOptions,
    activelyCollecting: true,
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
