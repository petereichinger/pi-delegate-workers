import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDelegateConfigLoader,
  decodeDelegateConfig,
  mergeDelegateConfigs,
} from "../extensions/config.ts";

test("decodes and deeply merges profile overrides including null clears", () => {
  const global = decodeDelegateConfig({
    version: 1,
    defaultProfile: "balanced",
    profiles: {
      fast: { model: "openai/small", thinkingLevel: "low" },
      balanced: { model: "openai/medium", thinkingLevel: "medium" },
    },
  }).value;
  const repo = decodeDelegateConfig({
    profiles: { balanced: { thinkingLevel: "high" } },
  }).value;
  const directory = decodeDelegateConfig({
    defaultProfile: "fast",
    profiles: { fast: { model: null } },
  }).value;

  const merged = mergeDelegateConfigs([global, repo, directory]);
  assert.equal(merged.defaultProfile, "fast");
  assert.deepEqual(merged.profiles.fast, {
    model: null,
    thinkingLevel: "low",
  });
  assert.deepEqual(merged.profiles.balanced, {
    model: "openai/medium",
    thinkingLevel: "high",
  });
});

test("merges model sets, replaces routes, and supports inherited clears", () => {
  const global = decodeDelegateConfig({
    profiles: { deep: { thinkingLevel: "high" } },
    defaultModelSet: "claude",
    modelSets: {
      claude: { profiles: { deep: { model: "anthropic/sonnet" } } },
      diverse: { profiles: { deep: { model: "openai/reviewer" } } },
    },
    parentModelRoutes: [
      { models: ["anthropic/claude-*"], modelSet: "claude" },
    ],
  }).value;
  const repo = decodeDelegateConfig({
    modelSets: {
      claude: { profiles: { deep: { thinkingLevel: "max" } } },
    },
    parentModelRoutes: [
      { models: ["openrouter/claude-*"], modelSet: "claude" },
    ],
  }).value;

  const merged = mergeDelegateConfigs([global, repo]);
  assert.equal(merged.defaultModelSet, "claude");
  assert.deepEqual(merged.modelSets.claude, {
    profiles: {
      deep: { model: "anthropic/sonnet", thinkingLevel: "max" },
    },
  });
  assert.deepEqual(merged.parentModelRoutes, [
    { models: ["openrouter/claude-*"], modelSet: "claude" },
  ]);

  const cleared = mergeDelegateConfigs([
    global,
    decodeDelegateConfig({
      defaultModelSet: null,
      modelSets: { diverse: null },
      parentModelRoutes: null,
    }).value,
  ]);
  assert.equal(cleared.defaultModelSet, undefined);
  assert.equal(cleared.modelSets.diverse, undefined);
  assert.deepEqual(cleared.parentModelRoutes, []);
});

test("supports model-set names that overlap Object prototype properties", () => {
  const merged = mergeDelegateConfigs([
    decodeDelegateConfig({
      defaultModelSet: "constructor",
      modelSets: {
        constructor: {
          profiles: { fast: { model: "test/small" } },
        },
      },
    }).value,
  ]);

  assert.equal(merged.defaultModelSet, "constructor");
  assert.deepEqual(merged.modelSets.constructor, {
    profiles: { fast: { model: "test/small" } },
  });
});

test("rejects model set references that do not exist after merging", () => {
  assert.throws(
    () => mergeDelegateConfigs([
      decodeDelegateConfig({ defaultModelSet: "missing" }).value,
    ]),
    /defaultModelSet references unknown model set: missing/,
  );
  assert.throws(
    () => mergeDelegateConfigs([
      decodeDelegateConfig({
        parentModelRoutes: [{ models: ["anthropic/*"], modelSet: "missing" }],
      }).value,
    ]),
    /parentModelRoutes\[0\] references unknown model set: missing/,
  );
});

test("rejects invalid models and thinking levels", () => {
  for (const model of ["bare-id", "provider//model", "provider/model with-space", "provider/model\nextra"]) {
    assert.throws(
      () => decodeDelegateConfig({ profiles: { fast: { model } } }),
      /provider\/model/,
    );
  }
  assert.throws(
    () =>
      decodeDelegateConfig({
        profiles: { fast: { thinkingLevel: "extreme" } },
      }),
    /thinkingLevel/,
  );
  assert.throws(
    () => decodeDelegateConfig({ modelSets: { "bad name": {} } }),
    /modelSets key/,
  );
  assert.throws(
    () => decodeDelegateConfig({
      parentModelRoutes: [{ models: ["bare-model"], modelSet: "claude" }],
    }),
    /provider\/model pattern/,
  );
});

test("decodes ordered tiers and separates aliases from legacy profile objects", () => {
  const { value, warnings } = decodeDelegateConfig({
    modelSets: {
      ordered: {
        tiers: [
          { id: "small", model: "test/small", thinkingLevel: "low" },
          { id: "reviewer", model: "test/reviewer", advisorOnly: true },
          { id: "large", model: "test/large", advisorOnly: false },
        ],
        profiles: {
          fast: "small",
          balanced: { model: "test/custom", thinkingLevel: null },
          deep: "large",
        },
      },
    },
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(value.modelSets?.ordered, {
    tiers: [
      { id: "small", model: "test/small", thinkingLevel: "low" },
      { id: "reviewer", model: "test/reviewer", advisorOnly: true },
      { id: "large", model: "test/large", advisorOnly: false },
    ],
    profiles: { balanced: { model: "test/custom", thinkingLevel: null } },
    profileTiers: { fast: "small", deep: "large" },
  });
  assert.deepEqual(mergeDelegateConfigs([value]).modelSets.ordered, value.modelSets?.ordered);
});

test("replaces tier arrays and inherits aliases per profile", () => {
  const global = decodeDelegateConfig({
    modelSets: {
      ordered: {
        tiers: [
          { id: "small", model: "test/old" },
          { id: "large", model: "test/large" },
        ],
        profiles: { fast: "small", balanced: "large", deep: "large" },
      },
    },
  }).value;
  const repo = decodeDelegateConfig({
    modelSets: {
      ordered: {
        tiers: [
          { id: "large", model: "test/new-large" },
          { id: "small", model: "test/new-small" },
        ],
        profiles: { balanced: "small" },
      },
    },
  }).value;
  const merged = mergeDelegateConfigs([global, repo]);
  const modelSet = merged.modelSets.ordered!;
  assert.deepEqual(modelSet.tiers, [
    { id: "large", model: "test/new-large" },
    { id: "small", model: "test/new-small" },
  ]);
  assert.deepEqual(modelSet.profileTiers, {
    fast: "small", balanced: "small", deep: "large",
  });
  modelSet.tiers![0]!.model = "test/mutated";
  assert.equal(repo.modelSets?.ordered?.tiers?.[0]?.model, "test/new-large");
});

test("profile objects override aliases and aliases discard old profile overrides", () => {
  const global = decodeDelegateConfig({
    modelSets: {
      ordered: {
        tiers: [{ id: "worker", model: "test/worker" }],
        profiles: {
          fast: { model: "test/old", thinkingLevel: "high" },
          balanced: "worker",
          deep: { model: "test/deep", thinkingLevel: "low" },
        },
      },
    },
  }).value;
  const repo = decodeDelegateConfig({
    modelSets: {
      ordered: {
        profiles: {
          fast: "worker",
          balanced: { thinkingLevel: "medium" },
          deep: { model: null },
        },
      },
    },
  }).value;
  const merged = mergeDelegateConfigs([global, repo]);
  assert.deepEqual(merged.modelSets.ordered!.profileTiers, { fast: "worker" });
  assert.deepEqual(merged.modelSets.ordered!.profiles, {
    balanced: { thinkingLevel: "medium" },
    deep: { model: null, thinkingLevel: "low" },
  });
  const directory = decodeDelegateConfig({
    modelSets: { ordered: { profiles: { fast: {} } } },
  }).value;
  assert.deepEqual(mergeDelegateConfigs([global, repo, directory]).modelSets.ordered!.profiles?.fast, {});
  assert.deepEqual(mergeDelegateConfigs([global, repo]).modelSets.ordered, merged.modelSets.ordered);
});

test("validates alias references only after all scopes merge", () => {
  const aliases = decodeDelegateConfig({
    modelSets: { ordered: { profiles: { fast: "worker" } } },
  }).value;
  const tiers = decodeDelegateConfig({
    modelSets: { ordered: { tiers: [{ id: "worker", model: "test/worker" }] } },
  }).value;
  assert.doesNotThrow(() => mergeDelegateConfigs([aliases, tiers]));
  assert.throws(() => mergeDelegateConfigs([aliases]), /profiles.fast references unknown tier: worker/);
  assert.throws(() => mergeDelegateConfigs([
    aliases,
    tiers,
    decodeDelegateConfig({ modelSets: { ordered: { tiers: [] } } }).value,
  ]), /references unknown tier: worker/);
  assert.throws(() => mergeDelegateConfigs([
    aliases,
    decodeDelegateConfig({
      modelSets: { ordered: { tiers: [{ id: "worker", model: "test/worker", advisorOnly: true }] } },
    }).value,
  ]), /profiles.fast references advisorOnly tier: worker/);
  assert.doesNotThrow(() => mergeDelegateConfigs([
    aliases,
    decodeDelegateConfig({ modelSets: { ordered: null } }).value,
  ]));
});

test("rejects malformed tiers and aliases", () => {
  const decodeTiers = (tiers: unknown) => decodeDelegateConfig({ modelSets: { ordered: { tiers } } });
  assert.throws(() => decodeTiers(null), /tiers must be an array/);
  assert.throws(() => decodeTiers({}), /tiers must be an array/);
  assert.throws(() => decodeTiers([null]), /must be an object/);
  for (const id of [undefined, null, "", "bad id"]) {
    assert.throws(() => decodeTiers([{ id, model: "test/worker" }]), /\.id/);
  }
  assert.throws(() => decodeTiers([
    { id: "same", model: "test/one" },
    { id: "same", model: "test/two" },
  ]), /duplicate tier id: same/);
  for (const model of [undefined, null, "bare-model", "provider//model"]) {
    assert.throws(() => decodeTiers([{ id: "worker", model }]), /provider\/model/);
  }
  for (const thinkingLevel of [null, "extreme", true]) {
    assert.throws(() => decodeTiers([{ id: "worker", model: "test/worker", thinkingLevel }]), /thinkingLevel/);
  }
  for (const advisorOnly of [null, "true", 1]) {
    assert.throws(() => decodeTiers([{ id: "worker", model: "test/worker", advisorOnly }]), /advisorOnly/);
  }
  assert.throws(() => decodeDelegateConfig({
    modelSets: { ordered: { profiles: { fast: "bad id" } } },
  }), /profiles.fast/);
  assert.throws(() => decodeDelegateConfig({ profiles: { fast: "worker" } }), /must be an object/);
});

test("warns for unknown tier fields and model-set profiles", () => {
  const { warnings } = decodeDelegateConfig({
    modelSets: {
      ordered: {
        tiers: [{ id: "worker", model: "test/worker", extra: true }],
        profiles: { unknown: "worker" },
      },
    },
  });
  assert.deepEqual(warnings, [
    "unknown modelSets.ordered.tiers[0] field ignored: extra",
    "unknown modelSets.ordered.profiles profile ignored: unknown",
  ]);
});

test("untrusted config loading ignores malformed Git metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegate-untrusted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, ".git"), "malformed git metadata", "utf8");

  const loader = createDelegateConfigLoader({ agentDir, configDirName: ".pi" });
  const loaded = await loader.load({
    cwd,
    isProjectTrusted: () => false,
  });
  assert.equal(loaded.config.defaultProfile, "balanced");
  assert.equal(loaded.paths.repo, undefined);
  assert.equal(loaded.paths.directory, undefined);
});

test("loads global, repository, and directory config in precedence order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegate-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const repository = join(root, "project");
  const cwd = join(repository, "service");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "delegate-workers.json"),
    JSON.stringify({
      profiles: { fast: { model: "openai/small", thinkingLevel: "low" } },
    }),
  );
  await writeFile(
    join(repository, ".git", "pi-delegate-workers.json"),
    JSON.stringify({ profiles: { fast: { thinkingLevel: "medium" } } }),
  );
  await writeFile(
    join(cwd, ".pi", "delegate-workers.json"),
    JSON.stringify({ defaultProfile: "fast" }),
  );

  const loader = createDelegateConfigLoader({ agentDir, configDirName: ".pi" });
  const loaded = await loader.load({ cwd, isProjectTrusted: () => true });
  assert.equal(loaded.config.defaultProfile, "fast");
  assert.deepEqual(loaded.config.profiles.fast, {
    model: "openai/small",
    thinkingLevel: "medium",
  });

  loader.invalidate();
  const untrusted = await loader.load({
    cwd,
    isProjectTrusted: () => false,
  });
  assert.equal(untrusted.config.defaultProfile, "balanced");
  assert.deepEqual(untrusted.config.profiles.fast, {
    model: "openai/small",
    thinkingLevel: "low",
  });
});
