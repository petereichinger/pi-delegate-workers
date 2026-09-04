import assert from "node:assert/strict";
import test from "node:test";
import { isRpcPromptSettled } from "../extensions/rpc-worker.ts";

test("waits for agent_settled instead of resolving on a retryable agent_end", () => {
  assert.equal(isRpcPromptSettled({ type: "agent_end", willRetry: true }), false);
  assert.equal(isRpcPromptSettled({ type: "agent_end", willRetry: false }), false);
  assert.equal(isRpcPromptSettled({ type: "agent_settled" }), true);
});
