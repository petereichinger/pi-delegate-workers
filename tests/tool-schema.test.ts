import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import delegateWorkersExtension from "../extensions/index.ts";

test("nesting is enabled at depth one by default, disabled at depth two or with max depth one", () => {
  const names = ["PI_DELEGATE_COORDINATOR_ENDPOINT", "PI_DELEGATE_WORKER_TOKEN", "PI_DELEGATE_WORKER_DEPTH", "PI_DELEGATE_MAX_DEPTH"] as const;
  const previous = names.map((name) => process.env[name]);
  try {
    process.env.PI_DELEGATE_COORDINATOR_ENDPOINT = "inherited-endpoint";
    process.env.PI_DELEGATE_WORKER_TOKEN = "worker-token";
    delete process.env.PI_DELEGATE_MAX_DEPTH;
    const tools: string[] = [];
    const pi = {
      on: () => undefined,
      registerCommand: () => undefined,
      registerTool: (tool: { name: string }) => { tools.push(tool.name); },
    } as any;
    process.env.PI_DELEGATE_WORKER_DEPTH = "1";
    delegateWorkersExtension(pi);
    assert.deepEqual(tools, ["delegate_tasks"]);
    process.env.PI_DELEGATE_WORKER_DEPTH = "2";
    delegateWorkersExtension(pi);
    assert.deepEqual(tools, ["delegate_tasks"]);
    process.env.PI_DELEGATE_WORKER_DEPTH = "1";
    process.env.PI_DELEGATE_MAX_DEPTH = "1";
    delegateWorkersExtension(pi);
    assert.deepEqual(tools, ["delegate_tasks"]);
  } finally {
    for (const [index, name] of names.entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
