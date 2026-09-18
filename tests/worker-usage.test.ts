import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  addUsage,
  emptyUsage,
  getRpcEventUsage,
  sumUsage,
} from "../extensions/rpc-worker.ts";

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 10,
    output: 5,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 20,
    cost: {
      input: 0.01,
      output: 0.02,
      cacheRead: 0.003,
      cacheWrite: 0.004,
      total: 0.037,
      ...overrides.cost,
    },
    ...overrides,
  };
}

test("adds all worker token and cost categories", () => {
  const total = addUsage(
    usage({ reasoning: 2, cacheWrite1h: 1 }),
    usage({ input: 7, output: 4, totalTokens: 16, reasoning: 1 }),
  );

  assert.deepEqual(total, {
    input: 17,
    output: 9,
    cacheRead: 6,
    cacheWrite: 4,
    cacheWrite1h: 1,
    reasoning: 3,
    totalTokens: 36,
    cost: {
      input: 0.02,
      output: 0.04,
      cacheRead: 0.006,
      cacheWrite: 0.008,
      total: 0.074,
    },
  });
});

test("sums usage across workers", () => {
  assert.deepEqual(sumUsage([usage(), usage({ input: 4, totalTokens: 14 })]), {
    input: 14,
    output: 10,
    cacheRead: 6,
    cacheWrite: 4,
    totalTokens: 34,
    cost: {
      input: 0.02,
      output: 0.04,
      cacheRead: 0.006,
      cacheWrite: 0.008,
      total: 0.074,
    },
  });
  assert.deepEqual(sumUsage([]), emptyUsage());
});

test("extracts finalized assistant, nested tool, and compaction usage", () => {
  const assistant = usage();
  const nestedTool = usage({ input: 2, totalTokens: 12 });
  const compaction = usage({ output: 8, totalTokens: 23 });

  assert.equal(
    getRpcEventUsage({ type: "message_end", message: { role: "assistant", usage: assistant } }),
    assistant,
  );
  assert.equal(
    getRpcEventUsage({ type: "message_end", message: { role: "toolResult", usage: nestedTool } }),
    nestedTool,
  );
  assert.equal(
    getRpcEventUsage({ type: "compaction_end", result: { usage: compaction } }),
    compaction,
  );
  assert.equal(getRpcEventUsage({ type: "message_update", usage: assistant }), undefined);
  assert.equal(getRpcEventUsage({ type: "message_end", message: { role: "user" } }), undefined);
});
