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
