import assert from "node:assert/strict";
import test from "node:test";
import {
  appendWorkerActivity,
  describeWorkerTool,
  formatWorkerDisplayLines,
  formatWorkerWidgetLines,
  normalizeWorkerId,
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

test("bounds streamed worker activity without changing its displayed prefix", () => {
  const first = appendWorkerActivity("", "a".repeat(200));
  const next = appendWorkerActivity(first, "b".repeat(200));

  assert.equal(first, `${"a".repeat(139)}…`);
  assert.equal(next, first);
  assert.equal(appendWorkerActivity("Reading ", "a file"), "Reading a file");
});

test("orders each parent's nested states before the next parent, including queued workers", () => {
  const state = (id: string, nestedLines?: string[]) => ({
    id, task: `Task ${id}`, profile: "fast" as const, status: "queued", latestMessage: "Waiting", nestedLines,
  });
  const lines = formatWorkerWidgetLines([
    state("w2", ["w2.1 Goal: Child 2"]),
    state("w10"),
    state("w1", ["w1.1 Goal: Child 1", "w1.2 Goal: Child 1b", "w1.10 Goal: Child 1j"]),
    state("w3"),
  ], (_color, text) => text);

  assert.deepEqual(lines.filter((line) => line.includes("Goal:")), [
    " w1 [fast] Goal: Task w1",
    "w1.1 Goal: Child 1",
    "w1.2 Goal: Child 1b",
    "w1.10 Goal: Child 1j",
    " w2 [fast] Goal: Task w2",
    "w2.1 Goal: Child 2",
    " w3 [fast] Goal: Task w3",
    " w10 [fast] Goal: Task w10",
  ]);
  assert.deepEqual(
    formatWorkerWidgetLines([state("w1.10"), state("w1.2")], (_color, text) => text)
      .filter((line) => line.includes("Goal:")),
    [" w1.2 [fast] Goal: Task w1.2", " w1.10 [fast] Goal: Task w1.10"],
  );
  assert.equal(normalizeWorkerId("1.10"), "w1.10");
  assert.equal(normalizeWorkerId("w1.2"), "w1.2");
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
