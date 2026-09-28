import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import delegateWorkersExtension from "../extensions/index.ts";

test("workers cannot register nested delegation in step one", () => {
  const previous = process.env.PI_DELEGATE_COORDINATOR_ENDPOINT;
  process.env.PI_DELEGATE_COORDINATOR_ENDPOINT = "inherited-endpoint";
  let registered = false;
  try {
    delegateWorkersExtension({
      on: () => undefined,
      registerCommand: () => { registered = true; },
      registerTool: () => { registered = true; },
    } as any);
    assert.equal(registered, false);
  } finally {
    if (previous === undefined) delete process.env.PI_DELEGATE_COORDINATOR_ENDPOINT;
    else process.env.PI_DELEGATE_COORDINATOR_ENDPOINT = previous;
  }
});

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
