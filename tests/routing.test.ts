import assert from "node:assert/strict";
import test from "node:test";
import {
  formatModelSetNotification,
  normalizeWorkerId,
  requestWorkerCancellation,
  routeTasks,
  selectAutomaticModelSet,
} from "../extensions/index.ts";
import type { ResolvedDelegateConfig } from "../extensions/config.ts";

const config: ResolvedDelegateConfig = {
  version: 1,
  defaultProfile: "balanced",
  profiles: {
    fast: { model: "test/small", thinkingLevel: "low" },
    balanced: {},
    deep: { model: "test/large", thinkingLevel: "max" },
  },
  modelSets: {},
  parentModelRoutes: [],
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
    model: undefined,
    modelRegistry: {
      find(provider: string, id: string) {
        return models.get(`${provider}/${id}`);
      },
    },
  } as any;
}

test("formats model set notifications only for initial configured selection and changes", () => {
  assert.equal(
    formatModelSetNotification(undefined, undefined, false),
    undefined,
  );
  assert.equal(
    formatModelSetNotification(undefined, "claude", false),
    "Delegate model set: claude",
  );
  assert.equal(
    formatModelSetNotification("claude", "claude", true),
    undefined,
  );
  assert.equal(
    formatModelSetNotification("claude", "diverse", true),
    "Delegate model set changed: claude → diverse",
  );
  assert.equal(
    formatModelSetNotification("claude", undefined, true),
    "Delegate model set changed: claude → baseline",
  );
});

test("normalizes numeric and prefixed worker IDs", () => {
  assert.equal(normalizeWorkerId("13"), "w13");
  assert.equal(normalizeWorkerId(" w13 "), "w13");
  assert.equal(normalizeWorkerId("W2"), "w2");
  assert.equal(normalizeWorkerId("0"), undefined);
  assert.equal(normalizeWorkerId("13 extra"), undefined);
});

test("cancels a worker only once", () => {
  const abortController = new AbortController();
  const state = { abortController, cancelRequested: false };

  assert.equal(requestWorkerCancellation(state), true);
  assert.equal(state.cancelRequested, true);
  assert.equal(abortController.signal.aborted, true);
  assert.equal(requestWorkerCancellation(state), false);
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
      modelSetSource: "none",
      model: "test/small",
      thinkingLevel: "low",
    },
    { task: "routine", profile: "balanced", modelSetSource: "none" },
    {
      task: "architecture",
      profile: "deep",
      modelSetSource: "none",
      model: "test/large",
      thinkingLevel: "max",
    },
  ]);
});

test("routes optional task deadlines and rejects invalid durations", () => {
  assert.equal(
    routeTasks(contextWithModels(), [{ task: "long test", timeoutMs: 1800000 }], config)[0]?.timeoutMs,
    1800000,
  );
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
    assert.throws(
      () => routeTasks(contextWithModels(), [{ task: "invalid", timeoutMs }], config),
      /timeoutMs must be an integer/,
    );
  }
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

test("selects a model set from the current parent model before the default", () => {
  const routedConfig: ResolvedDelegateConfig = {
    ...config,
    defaultModelSet: "diverse",
    modelSets: {
      claude: { profiles: { fast: { model: "test/large", thinkingLevel: "max" } } },
      diverse: { profiles: { fast: { thinkingLevel: "medium" } } },
    },
    parentModelRoutes: [
      { models: ["anthropic/claude-*"], modelSet: "claude" },
      { models: ["anthropic/*"], modelSet: "diverse" },
    ],
  };

  assert.deepEqual(
    selectAutomaticModelSet(
      { provider: "anthropic", id: "claude-sonnet" },
      routedConfig,
    ),
    { modelSet: "claude", source: "parent-model" },
  );
  assert.deepEqual(
    selectAutomaticModelSet({ provider: "other", id: "model" }, routedConfig),
    { modelSet: "diverse", source: "default" },
  );

  const ctx = contextWithModels();
  ctx.model = { provider: "anthropic", id: "claude-sonnet" };
  for (const modelSet of [undefined, "", "  "]) {
    assert.deepEqual(
      routeTasks(ctx, [{ task: "review", profile: "fast", modelSet }], routedConfig),
      [{
        task: "review",
        profile: "fast",
        modelSet: "claude",
        modelSetSource: "parent-model",
        model: "test/large",
        thinkingLevel: "max",
      }],
    );
  }
});

test("task model set overrides automatic routing and overlays the baseline profile", () => {
  const routedConfig: ResolvedDelegateConfig = {
    ...config,
    defaultModelSet: "claude",
    modelSets: {
      claude: { profiles: { fast: { model: "test/large" } } },
      diverse: { profiles: { fast: { thinkingLevel: "medium" } } },
    },
  };

  assert.deepEqual(
    routeTasks(
      contextWithModels(),
      [{ task: "independent review", profile: "fast", modelSet: " diverse " }],
      routedConfig,
    ),
    [{
      task: "independent review",
      profile: "fast",
      modelSet: "diverse",
      modelSetSource: "task",
      model: "test/small",
      thinkingLevel: "medium",
    }],
  );
  assert.throws(
    () => routeTasks(
      contextWithModels(),
      [{ task: "review", modelSet: "missing" }],
      routedConfig,
    ),
    /model set not found: missing; available: claude, diverse/,
  );
  assert.deepEqual(
    routeTasks(
      contextWithModels(),
      [{ task: "review", profile: "fast", modelSet: " " }],
      routedConfig,
    ),
    [{
      task: "review",
      profile: "fast",
      modelSet: "claude",
      modelSetSource: "default",
      model: "test/large",
      thinkingLevel: "low",
    }],
  );
});

test("model-set null values clear baseline worker routing", () => {
  const routedConfig: ResolvedDelegateConfig = {
    ...config,
    defaultModelSet: "startup-defaults",
    modelSets: {
      "startup-defaults": {
        profiles: { fast: { model: null, thinkingLevel: null } },
      },
    },
  };

  assert.deepEqual(
    routeTasks(
      contextWithModels(),
      [{ task: "use startup defaults", profile: "fast" }],
      routedConfig,
    ),
    [{
      task: "use startup defaults",
      profile: "fast",
      modelSet: "startup-defaults",
      modelSetSource: "default",
      model: null,
      thinkingLevel: null,
    }],
  );
});
