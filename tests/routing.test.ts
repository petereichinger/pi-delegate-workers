import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandTasks, routeTasks } from "../extensions/index.ts";
import type { ResolvedDelegateConfig } from "../extensions/config.ts";

const config: ResolvedDelegateConfig = {
  version: 1,
  defaultProfile: "balanced",
  profiles: {
    fast: { model: "test/small", thinkingLevel: "low" },
    balanced: {},
    deep: { model: "test/large", thinkingLevel: "max" },
  },
};

function contextWithModels() {
  const models = new Map([
    [
      "test/small",
      {
        provider: "test",
        id: "small",
        reasoning: true,
      },
    ],
    [
      "test/large",
      {
        provider: "test",
        id: "large",
        reasoning: true,
        thinkingLevelMap: { max: "max" },
      },
    ],
  ]);
  return {
    modelRegistry: {
      find(provider: string, id: string) {
        return models.get(`${provider}/${id}`);
      },
    },
  } as any;
}

test("parses optional slash-command profile annotations", () => {
  assert.deepEqual(
    parseCommandTasks("[fast] locate config | inspect tests | [deep] review migration"),
    [
      { task: "locate config", profile: "fast" },
      { task: "inspect tests" },
      { task: "review migration", profile: "deep" },
    ],
  );
});

test("routes tasks through explicit and default profiles", () => {
  const routed = routeTasks(
    contextWithModels(),
    [
      { task: "lookup", profile: "fast" },
      { task: "routine" },
      { task: "architecture", profile: "deep" },
    ],
    config,
  );

  assert.deepEqual(routed, [
    {
      task: "lookup",
      profile: "fast",
      model: "test/small",
      thinkingLevel: "low",
    },
    { task: "routine", profile: "balanced" },
    {
      task: "architecture",
      profile: "deep",
      model: "test/large",
      thinkingLevel: "max",
    },
  ]);
});

test("rejects model-specific unsupported thinking levels before spawn", () => {
  const invalid: ResolvedDelegateConfig = {
    ...config,
    profiles: {
      ...config.profiles,
      fast: { model: "test/small", thinkingLevel: "max" },
    },
  };

  assert.throws(
    () =>
      routeTasks(
        contextWithModels(),
        [{ task: "lookup", profile: "fast" }],
        invalid,
      ),
    /does not support thinking level max/,
  );
});
