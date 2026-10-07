import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import delegateWorkersExtension, { routeTasks } from "../extensions/index.ts";
import type { ResolvedDelegateConfig } from "../extensions/config.ts";

const config: ResolvedDelegateConfig = {
  version: 1,
  defaultProfile: "balanced",
  profiles: { fast: {}, balanced: {}, deep: {} },
  modelSets: {},
  parentModelRoutes: [],
};

function withWorkerEnvironment(parentDepth: number, tools: string | undefined, run: () => void) {
  const names = [
    "PI_DELEGATE_COORDINATOR_ENDPOINT", "PI_DELEGATE_WORKER_TOKEN",
    "PI_DELEGATE_WORKER_DEPTH", "PI_DELEGATE_MAX_DEPTH", "PI_DELEGATE_TOOLS",
  ] as const;
  const previous = names.map((name) => process.env[name]);
  try {
    delete process.env.PI_DELEGATE_COORDINATOR_ENDPOINT;
    delete process.env.PI_DELEGATE_WORKER_TOKEN;
    process.env.PI_DELEGATE_WORKER_DEPTH = String(parentDepth);
    process.env.PI_DELEGATE_MAX_DEPTH = "2";
    if (tools === undefined) delete process.env.PI_DELEGATE_TOOLS;
    else process.env.PI_DELEGATE_TOOLS = tools;
    run();
  } finally {
    for (const [index, name] of names.entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function registeredTool() {
  let tool: any;
  delegateWorkersExtension({
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: (registered: unknown) => { tool = registered; },
  } as any);
  return tool;
}

for (const workerDepth of [1, 2]) {
  test(`depth-${workerDepth} default tools include codemode and tool_search in task subsets`, () => {
    withWorkerEnvironment(workerDepth - 1, undefined, () => {
      const expected = ["read", "write", "edit", "bash", "codemode", "tool_search"];
      if (workerDepth === 1) expected.push("delegate_tasks");
      const tool = registeredTool();
      assert.equal(
        tool.parameters.properties.tasks.items.properties.tools.description,
        `Optional per-task tool subset of PI_DELEGATE_TOOLS (current default: ${expected.join(",")}). For read-only tasks, include read, codemode, and tool_search when allowed; add bash only when command access is needed.`,
      );
      const context = { model: undefined } as any;
      for (const tools of [expected, ["read", "codemode", "tool_search"], ...expected.map((name) => [name])]) {
        const tasks = [{ task: "inspect", tools }];
        assert.equal(Check(tool.parameters, { tasks }), true);
        assert.deepEqual(routeTasks(context, tasks, config)[0]?.tools, tools);
      }
      if (workerDepth === 2) {
        assert.throws(
          () => routeTasks(context, [{ task: "nested", tools: ["delegate_tasks"] }], config),
          /task tools must be a subset of the worker allowlist/,
        );
      }
    });
  });

  test(`depth-${workerDepth} explicit tool override does not inherit default tools`, () => {
    withWorkerEnvironment(workerDepth - 1, "read,bash", () => {
      const tool = registeredTool();
      assert.equal(
        tool.parameters.properties.tasks.items.properties.tools.description,
        "Optional per-task tool subset of PI_DELEGATE_TOOLS (current default: read,bash). For read-only tasks, include read, codemode, and tool_search when allowed; add bash only when command access is needed.",
      );
      const context = { model: undefined } as any;
      assert.deepEqual(
        routeTasks(context, [{ task: "inspect", tools: ["read", "bash"] }], config)[0]?.tools,
        ["read", "bash"],
      );
      for (const name of ["write", "edit", "codemode", "tool_search", "delegate_tasks"]) {
        assert.throws(
          () => routeTasks(context, [{ task: "excluded", tools: ["read", name] }], config),
          /task tools must be a subset of the worker allowlist/,
        );
      }
    });
  });
}

test("read-only guidance keeps codemode and tool_search without claiming tool subsets are a sandbox", () => {
  withWorkerEnvironment(0, undefined, () => {
    const guidelines = registeredTool().promptGuidelines.join("\n");
    assert.match(guidelines, /For read-only tasks, include read, codemode, and tool_search when allowed by the worker allowlist/);
    assert.match(guidelines, /Explicit PI_DELEGATE_TOOLS restrictions remain authoritative/);
    assert.match(guidelines, /must not make changes through scripts, shell commands, or discovered tools/);
    assert.match(guidelines, /Tool selection is not a read-only sandbox; bash permits writes/);
  });
});

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
