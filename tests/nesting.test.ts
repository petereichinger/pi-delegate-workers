import assert from "node:assert/strict";
import test from "node:test";
import { delegateConfigLoader } from "../extensions/config.ts";
import { createWorkerCoordinator, resumeWorkerSlot, yieldWorkerSlot } from "../extensions/coordinator.ts";
import delegateWorkersExtension from "../extensions/index.ts";

const config = {
  version: 1,
  defaultProfile: "balanced",
  profiles: { fast: {}, balanced: {}, deep: {} },
  modelSets: {},
  parentModelRoutes: [],
} as const;

test("nested tool waits for sibling work, delegates through the shared coordinator, then resumes", { timeout: 5000 }, async () => {
  const coordinator = await createWorkerCoordinator({ maxActive: 1, maxLive: 2, maxDepth: 2 });
  const slot = await coordinator.acquire();
  const names = [
    "PI_DELEGATE_COORDINATOR_ENDPOINT", "PI_DELEGATE_WORKER_TOKEN", "PI_DELEGATE_WORKER_DEPTH",
    "PI_DELEGATE_MAX_DEPTH", "PI_DELEGATE_PI_BIN", "PI_DELEGATE_TOOLS",
  ] as const;
  const previous = names.map((name) => process.env[name]);
  const originalLoad = delegateConfigLoader.load;
  try {
    process.env.PI_DELEGATE_COORDINATOR_ENDPOINT = coordinator.endpoint;
    process.env.PI_DELEGATE_WORKER_TOKEN = slot.token;
    process.env.PI_DELEGATE_WORKER_DEPTH = "1";
    process.env.PI_DELEGATE_MAX_DEPTH = "2";
    process.env.PI_DELEGATE_PI_BIN = "no-such-pi-delegate-binary";
    delete process.env.PI_DELEGATE_TOOLS;
    (delegateConfigLoader as any).load = async () => ({ config, warnings: [] });
    const handlers = new Map<string, (event: any) => void>();
    let tool: any;
    delegateWorkersExtension({
      on: (name: string, handler: (event: any) => void) => { handlers.set(name, handler); },
      registerCommand: () => undefined,
      registerTool: (registered: any) => { tool = registered; },
      events: { emit: () => undefined },
    } as any);
    assert.equal(tool.name, "delegate_tasks");
    const context = {
      cwd: process.cwd(),
      model: undefined,
      modelRegistry: { find: () => undefined },
      ui: { theme: { fg: (_style: string, value: string) => value }, setWidget: () => undefined },
    } as any;
    handlers.get("tool_execution_start")!({ toolCallId: "delegate", toolName: "delegate_tasks" });
    handlers.get("tool_execution_start")!({ toolCallId: "sibling", toolName: "read" });
    const running = tool.execute("delegate", { tasks: [{ task: "child" }] }, undefined, undefined, context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(resumeWorkerSlot(coordinator.endpoint, slot.token), /invalid request/);
    handlers.get("tool_execution_end")!({ toolCallId: "sibling", toolName: "read" });
    const result = await running;
    assert.equal(result.details.taskCount, 1);
    assert.equal(result.details.failedTasks, 1);
    assert.match(result.content[0].text, /child/);
    await yieldWorkerSlot(coordinator.endpoint, slot.token);
    await resumeWorkerSlot(coordinator.endpoint, slot.token);
  } finally {
    (delegateConfigLoader as any).load = originalLoad;
    for (const [index, name] of names.entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    slot.release();
    await coordinator.close();
  }
});
