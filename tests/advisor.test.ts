import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  ADVISOR_TIERS_ENV,
  ADVISOR_TOOL,
  advisorContext,
  inheritedAdvisorTiers,
  nextAdvisorThinkingLevel,
  readAdvisorSetting,
  registerAdvisor,
  routeWorkerTiers,
  saveAdvisorSetting,
} from "../extensions/advisor.ts";
import { decodeDelegateConfig, delegateConfigLoader, mergeDelegateConfigs } from "../extensions/config.ts";
import type { DelegateTierConfig } from "../extensions/config.ts";
import delegateWorkersExtension, { routeTasks } from "../extensions/index.ts";

const models = [
  { provider: "test", id: "small", reasoning: true },
  { provider: "test", id: "large", reasoning: true, thinkingLevelMap: { max: "max" } },
  { provider: "test", id: "plain", reasoning: false },
] as Model<Api>[];
const tiers: DelegateTierConfig[] = [
  { id: "small", model: "test/small", thinkingLevel: "low" },
  { id: "large", model: "test/large", thinkingLevel: "high" },
  { id: "review", model: "test/large", thinkingLevel: "max", advisorOnly: true },
];
const config = mergeDelegateConfigs([decodeDelegateConfig({
  defaultModelSet: "team",
  modelSets: { team: { tiers, profiles: { fast: "small", balanced: "large", deep: "large" } } },
}).value]);

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type Entries = ReturnType<ExtensionContext["sessionManager"]["buildContextEntries"]>;

async function isolated(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "delegate-advisor-test-"));
  const names = new Set([
    ...Object.keys(process.env).filter((name) => name.startsWith("PI_DELEGATE_")),
    "PI_CODING_AGENT_DIR",
  ]);
  const previous = new Map([...names].map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.PI_CODING_AGENT_DIR = dir;
    await run(dir);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("PI_DELEGATE_")) delete process.env[name];
    }
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function harness(entries: Entries = []) {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const calls: { model: Model<Api>; context: Context; options: SimpleStreamOptions }[] = [];
  const notifications: { text: string; level: string }[] = [];
  const usage = {
    input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const pi = {
    on() {},
    registerMessageRenderer() {},
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    getThinkingLevel: () => "low",
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: tmpdir(),
    model: models[0],
    thinkingLevel: "low",
    sessionManager: { buildContextEntries: () => entries },
    modelRegistry: {
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions) {
        calls.push({ model, context, options });
        return { result: async () => ({
          stopReason: "stop",
          content: [{ type: "thinking", thinking: "private reply reasoning" }, { type: "text", text: "Check the invariant." }],
          usage,
        }) };
      },
    },
    ui: { notify: (text: string, level: string) => notifications.push({ text, level }) },
  } as unknown as ExtensionToolContext;
  return {
    pi, ctx, tools, commands, calls, notifications, usage,
    consult: (params: { question: string; target?: string }) => tools.get(ADVISOR_TOOL)!.execute("consult", params, undefined, undefined, ctx),
  };
}

test("advisor settings default to auto and persist auto, off, and explicit tiers", async () => {
  await isolated(async (dir) => {
    const path = join(dir, "nested", "advisor.json");
    assert.equal(await readAdvisorSetting(path), "auto");
    for (const value of ["off", "team/review", "auto"]) {
      await saveAdvisorSetting(value, path);
      assert.equal(await readAdvisorSetting(path), value);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { advisor: value });
      if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    await assert.rejects(saveAdvisorSetting("team/review/extra", path), /Expected auto, off/);
    assert.equal(await readAdvisorSetting(path), "auto");
    await writeFile(path, '{"advisor":"invalid"}');
    await assert.rejects(readAdvisorSetting(path), /Cannot read advisor setting/);
  });
});

test("main advisor obeys persisted off and explicit selection across registrations", async (t) => {
  t.mock.method(delegateConfigLoader, "load", async () => ({ config }));
  await isolated(async () => {
    const first = harness();
    registerAdvisor(first.pi);
    await first.commands.get("advisor")!.handler("off", first.ctx as any);
    assert.equal(await readAdvisorSetting(), "off");
    await assert.rejects(first.consult({ question: "Which invariant?" }), /consultation is off/);
    assert.equal(first.calls.length, 0);

    await first.commands.get("advisor")!.handler("team/review", first.ctx as any);
    assert.equal(await readAdvisorSetting(), "team/review");
    const second = harness();
    registerAdvisor(second.pi);
    const result = await second.consult({ question: "Which invariant?" });
    assert.deepEqual(result.details, { model: "test/large", thinkingLevel: "max", tier: "review" });
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0]!.options.reasoning, "max");
    await second.commands.get("advisor")!.handler("team/missing", second.ctx as any);
    assert.equal(await readAdvisorSetting(), "team/review");
    assert.equal(second.notifications.at(-1)!.level, "error");
    await second.commands.get("advisor")!.handler("auto", second.ctx as any);
    assert.equal(await readAdvisorSetting(), "auto");
  });
});

test("automatic advisor uses the next supported thinking level and follows model changes", async () => {
  assert.equal(nextAdvisorThinkingLevel(models[0]!, "low"), "medium");
  assert.equal(nextAdvisorThinkingLevel(models[0]!, "high"), "high");
  assert.equal(nextAdvisorThinkingLevel(models[1]!, "high"), "max");
  assert.equal(nextAdvisorThinkingLevel(models[2]!, "off"), "off");
  await isolated(async () => {
    const h = harness();
    registerAdvisor(h.pi);
    await saveAdvisorSetting("auto");
    await h.consult({ question: "First decision?" });
    assert.equal(h.calls[0]!.model, models[0]);
    assert.equal(h.calls[0]!.options.reasoning, "medium");
    h.ctx.model = models[1];
    h.ctx.thinkingLevel = "high";
    await h.consult({ question: "New model?" });
    assert.equal(h.calls[1]!.model, models[1]);
    assert.equal(h.calls[1]!.options.reasoning, "max");
    h.ctx.model = models[2];
    h.ctx.thinkingLevel = "off";
    await h.consult({ question: "No reasoning?" });
    assert.equal(h.calls[2]!.model, models[2]);
    assert.equal(h.calls[2]!.options.reasoning, undefined);
    assert.equal(h.calls.length, 3);
  });
});

test("worker advisor defaults to next tier, permits jumps, and rejects current or lower tiers", async () => {
  await isolated(async () => {
    await saveAdvisorSetting("off");
    const h = harness();
    registerAdvisor(h.pi, tiers.slice(1));
    assert.equal(h.commands.has("advisor"), false);
    assert.deepEqual((await h.consult({ question: "Next?" })).details, { model: "test/large", thinkingLevel: "high", tier: "large" });
    assert.deepEqual((await h.consult({ question: "Jump?", target: "review" })).details, { model: "test/large", thinkingLevel: "max", tier: "review" });
    for (const target of ["small", "unknown"]) {
      await assert.rejects(h.consult({ question: "Down?", target }), /must be a higher tier/);
    }
    assert.equal(h.calls.length, 2);
    const top = harness();
    registerAdvisor(top.pi, []);
    await assert.rejects(top.consult({ question: "Beyond top?" }), /must be a higher tier/);
    assert.equal(top.calls.length, 0);
  });
});

test("consultation makes one tool-free request and returns only advice text with usage", async () => {
  const h = harness();
  registerAdvisor(h.pi, tiers.slice(1));
  const result = await h.consult({ question: "  What should I check?  " });
  assert.equal(h.calls.length, 1);
  const request = h.calls[0]!;
  assert.equal(request.context.tools, undefined);
  assert.equal(request.context.messages.length, 1);
  assert.equal(request.context.messages[0]!.role, "user");
  assert.match(String(request.context.messages[0]!.content), /Consultation question:\nWhat should I check\?/);
  assert.match(request.context.systemPrompt!, /tool-free advisor/);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(result.content, [{ type: "text", text: "Advisor: test/large (high thinking)\n\nCheck the invariant." }]);
  assert.deepEqual(result.usage, h.usage);
});

test("advisor context includes text and tool names but excludes arguments, images, and thinking", async () => {
  const entries = [
    { type: "compaction", summary: "Earlier decisions" },
    { type: "branch_summary", summary: "Branch findings" },
    { type: "message", message: { role: "user", content: [
      { type: "text", text: "User question" },
      { type: "image", data: "secret-image", mimeType: "image/png" },
    ] } },
    { type: "message", message: { role: "assistant", content: [
      { type: "text", text: "Visible explanation" },
      { type: "thinking", thinking: "secret-thinking" },
      { type: "toolCall", id: "1", name: "read", arguments: { path: "secret-argument" } },
      { type: "toolCall", id: "2", name: ADVISOR_TOOL, arguments: { question: "secret-consultation" } },
    ] } },
    { type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "File evidence" }] } },
  ] as unknown as Entries;
  const expected = "conversation summary: Earlier decisions\n\nconversation summary: Branch findings\n\nuser: User question\n\nassistant: Visible explanation\n[tool call: read]\n\ntool result (read): File evidence";
  assert.equal(advisorContext(entries), expected);
  const h = harness(entries);
  registerAdvisor(h.pi, tiers.slice(1));
  await h.consult({ question: "Review evidence?" });
  const prompt = String(h.calls[0]!.context.messages[0]!.content);
  assert.ok(prompt.endsWith(expected));
  assert.doesNotMatch(prompt, /secret-|consult_advisor/);
});

test("advisor context bounds excerpts and retains recent text", () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    type: "message", message: { role: "user", content: `${index}: ${"x".repeat(5_000)}` },
  })) as unknown as Entries;
  const context = advisorContext(entries);
  assert.ok(context.length <= 16_000);
  assert.ok(context.includes("user: 11:"));
  assert.ok(!context.includes("user: 0:"));
  assert.ok(context.split("\n\n").every((excerpt) => excerpt.length <= 4_006));
  assert.match(context, /…/);
});

test("tier aliases route workers and higher advisors obey global and per-task tool allowlists", async () => {
  await isolated(async () => {
    const h = harness();
    assert.deepEqual(routeWorkerTiers(config, "team", "fast"), { tier: tiers[0], higherTiers: tiers.slice(1) });
    const route = (profile: "fast" | "deep", tools?: string[]) => routeTasks(h.ctx, [{ task: "inspect", profile, tools }], config)[0]!;
    assert.equal(route("fast").model, "test/small");
    assert.deepEqual(route("fast").advisorTiers, tiers.slice(1));
    assert.deepEqual(route("deep").advisorTiers, tiers.slice(2));
    assert.equal(route("fast", ["read"]).advisorTiers, undefined);
    assert.deepEqual(route("fast", ["read", ADVISOR_TOOL]).advisorTiers, tiers.slice(1));
    process.env.PI_DELEGATE_TOOLS = "read";
    assert.equal(route("fast").advisorTiers, undefined);
    assert.throws(() => route("fast", [ADVISOR_TOOL]), /subset of the worker allowlist/);
    process.env.PI_DELEGATE_TOOLS = `read,${ADVISOR_TOOL}`;
    assert.deepEqual(route("fast").advisorTiers, tiers.slice(1));
  });
});

test("extension registers inherited worker advisors even at maximum delegation depth", async () => {
  await isolated(async () => {
    process.env.PI_DELEGATE_COORDINATOR_ENDPOINT = "mock-endpoint";
    process.env.PI_DELEGATE_WORKER_TOKEN = "mock-token";
    process.env.PI_DELEGATE_WORKER_DEPTH = "2";
    process.env.PI_DELEGATE_MAX_DEPTH = "2";
    process.env[ADVISOR_TIERS_ENV] = JSON.stringify(tiers.slice(1));
    assert.deepEqual(inheritedAdvisorTiers(process.env[ADVISOR_TIERS_ENV]), tiers.slice(1));
    const h = harness();
    delegateWorkersExtension(h.pi);
    assert.deepEqual([...h.tools.keys()], [ADVISOR_TOOL]);
    assert.equal(h.commands.has("advisor"), false);
    await h.consult({ question: "Need review?" });
    assert.equal(h.calls.length, 1);
    delete process.env[ADVISOR_TIERS_ENV];
    const withoutTiers = harness();
    delegateWorkersExtension(withoutTiers.pi);
    assert.equal(withoutTiers.tools.has(ADVISOR_TOOL), false);
  });
});
