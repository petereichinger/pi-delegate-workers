import assert from "node:assert/strict";
import test from "node:test";
import {
  describeWorkerTool,
  formatWorkerDisplayLines,
} from "../extensions/index.ts";

test("describes common worker RPC tool events", () => {
  assert.equal(
    describeWorkerTool({ type: "tool_execution_start", toolName: "read", args: { path: "extensions/index.ts" } }),
    "Reading extensions/index.ts",
  );
  assert.equal(
    describeWorkerTool({ type: "tool_execution_start", toolName: "bash", args: { command: "rg -n worker extensions" } }),
    "Running rg -n worker extensions",
  );
  assert.equal(
    describeWorkerTool({ type: "tool_execution_start", toolName: "edit", args: { path: "README.md" } }),
    "Editing README.md",
  );
});

test("describes unknown tools without requiring arguments", () => {
  assert.equal(
    describeWorkerTool({ type: "tool_execution_start", toolName: "custom_tool" }),
    "Using custom_tool",
  );
});

test("keeps the worker goal stable while current activity changes", () => {
  const reading = formatWorkerDisplayLines(
    "w1 [balanced]",
    "Trace token refresh failures",
    "Reading extensions/index.ts",
  );
  const searching = formatWorkerDisplayLines(
    "w1 [balanced]",
    "Trace token refresh failures",
    "Searching for refreshToken",
  );

  assert.deepEqual(reading, [
    "w1 [balanced] Goal: Trace token refresh failures",
    "  Now: Reading extensions/index.ts",
  ]);
  assert.equal(searching[0], reading[0]);
  assert.notEqual(searching[1], reading[1]);
});
