import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import delegateWorkersExtension from "../extensions/index.ts";

test("delegate_tasks accepts structured tasks without a legacy string adapter", () => {
  let tool: any;
  delegateWorkersExtension({
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: (registered: unknown) => { tool = registered; },
  } as any);

  assert.equal(tool.prepareArguments, undefined);
  assert.equal(Check(tool.parameters, { tasks: [{ task: "inspect" }] }), true);
  assert.equal(Check(tool.parameters, { tasks: ["inspect"] }), false);
});
