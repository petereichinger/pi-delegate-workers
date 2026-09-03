import assert from "node:assert/strict";
import test from "node:test";
import delegateWorkersExtension from "../extensions/index.ts";

test("registers non-blocking delegation lifecycle tools", () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = {
    events: { emit() {} },
    on() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    sendUserMessage() {},
  } as any;

  delegateWorkersExtension(pi);

  assert.deepEqual([...tools.keys()], [
    "delegate_tasks",
    "delegate_add_tasks",
    "delegate_results",
    "delegate_cancel",
  ]);
  assert.match(tools.get("delegate_tasks").description, /background/);
  assert.match(tools.get("delegate_results").description, /next result or all tasks/);
  assert.match(commands.get("delegate").description, /background/);
  assert.match(commands.get("cancel-worker").description, /queued or running/);
});
