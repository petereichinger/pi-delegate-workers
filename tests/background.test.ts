import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createEventBus,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionToolContext,
  type MessageRenderer,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import delegateWorkersExtension from "../extensions/index.ts";

function runtime(t: TestContext, deny?: string | null, settings = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-delegate-background-"));
  const env = ["PI_DELEGATE_PI_BIN", "PI_DELEGATE_MAX_ACTIVE_WORKERS", "PI_DELEGATE_MAX_LIVE_WORKERS", "PI_DELEGATE_COORDINATOR_ENDPOINT", "PI_DELEGATE_WORKER_DEPTH"];
  const previous = env.map((key) => process.env[key]);
  for (const key of env) delete process.env[key];
  process.env.PI_DELEGATE_PI_BIN = join(cwd, "no-pi-worker");
  process.env.PI_DELEGATE_MAX_ACTIVE_WORKERS = "2";
  process.env.PI_DELEGATE_MAX_LIVE_WORKERS = "3";
  const events = createEventBus();
  const authorizations: string[] = [];
  if (deny !== undefined) events.on("tool-guard:authorize-shell:v1", (data) => {
    const request = data as { command: string; respond(decision: Promise<string | null>): void };
    authorizations.push(request.command);
    request.respond(Promise.resolve(deny));
  });
  const handlers = new Map<string, () => Promise<void>>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionToolContext) => Promise<void> }>();
  const messages: Array<{
    customType: string; display: boolean; content: string;
    details: { id: string; status: string }; options: { triggerTurn: boolean };
  }> = [];
  const renderers = new Map<string, MessageRenderer>();
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as Theme;
  const notifications: string[] = [];
  const ctx = {
    cwd, hasUI: true, tools: [{ name: "bash" }, ...(process.platform === "win32" ? [{ name: "powershell" }] : [])],
    ui: { theme, setWidget: () => {}, notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionToolContext;
  let tool: {
    execute(id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionToolContext): Promise<any>;
    renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component;
  };
  delegateWorkersExtension({
    events,
    getSettings: () => settings,
    on: (name: string, handler: () => Promise<void>) => handlers.set(name, handler),
    registerCommand: (name: string, command: never) => commands.set(name, command),
    registerTool: (definition: typeof tool) => { tool = definition; },
    registerMessageRenderer: (name: string, renderer: MessageRenderer) => renderers.set(name, renderer),
    sendMessage: (message: Omit<(typeof messages)[number], "options">, options: { triggerTurn: boolean }) => messages.push({ ...message, options }),
  } as unknown as ExtensionAPI);
  const stop = () => handlers.get("session_shutdown")!();
  t.after(async () => {
    try { await stop(); } finally {
      rmSync(cwd, { force: true, recursive: true });
      env.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });
  return {
    cwd, messages, notifications, authorizations, stop,
    execute: (params: unknown, signal?: AbortSignal) => tool.execute("test-call", params, signal, undefined, ctx),
    renderToolResult: (result: AgentToolResult<unknown>, expanded: boolean) =>
      tool.renderResult(result, { expanded, isPartial: false }, theme).render(60).map((line) => line.trim()),
    renderMessage: (message: (typeof messages)[number], expanded: boolean) =>
      renderers.get(message.customType)!({ ...message, role: "custom", timestamp: 0 }, { expanded, outputPad: 1 }, theme)!
        .render(60).map((line) => line.trim()),
    cancel: (id: string) => commands.get("cancel-worker")!.handler(id, ctx),
  };
}

async function until(condition: () => boolean) {
  const signal = AbortSignal.timeout(6000);
  while (!condition()) await delay(20, undefined, { signal });
}

test("background commands return job IDs and deliver independently after the caller turn aborts", async (t) => {
  const r = runtime(t, null);
  const turn = new AbortController();
  const start = await r.execute({ mode: "background", commands: [
    { command: "while [ ! -f release ]; do sleep 0.05; done; printf slow" },
    { command: "printf fast; printf stderr >&2; exit 7" },
  ] }, turn.signal);
  assert.deepEqual(start.details, { mode: "background", ids: ["w1", "w2"] });
  turn.abort();
  await until(() => r.messages.length === 1);
  assert.equal(r.messages[0]?.details.id, "w2");
  assert.match(r.messages[0]!.content, /exit_code: 7/);
  assert.match(r.messages[0]!.content, /stderr/);
  assert.match(r.messages[0]!.content, /fast/);
  assert.deepEqual(r.messages[0]?.options, { triggerTurn: false });
  assert.match(r.notifications[0]!, /w2: error/);
  writeFileSync(join(r.cwd, "release"), "");
  await until(() => r.messages.length === 2);
  assert.equal(r.messages[1]?.details.status, "ok");
  assert.match(r.messages[1]!.content, /exit_code: 0/);
  assert.equal(r.messages[1]?.details.id, "w1");
});

test("command delegation fails closed if policy is missing or denies the request", async (t) => {
  await t.test("missing", async (t) => {
    const r = runtime(t);
    await assert.rejects(r.execute({ commands: [{ command: "touch ran" }] }), /requires pi-tool-guard/);
    assert.equal(existsSync(join(r.cwd, "ran")), false);
  });
  await t.test("denied", async (t) => {
    const r = runtime(t, "test deny rule");
    await assert.rejects(r.execute({ mode: "background", commands: [{ command: "touch ran" }] }), /test deny rule/);
    assert.deepEqual(r.authorizations, ["touch ran"]);
    assert.equal(existsSync(join(r.cwd, "ran")), false);
  });
});

test("blocking commands wait for their own output and use configured Bash setup", async (t) => {
  const r = runtime(t, null, { shellCommandPrefix: "export DELEGATE_EXTENSION_TEST=prefix-value" });
  const result = await r.execute({ commands: [{ command: "printf '%s' \"$DELEGATE_EXTENSION_TEST\"" }] });
  assert.match(result.content[0].text, /exit_code: 0/);
  assert.match(result.content[0].text, /prefix-value/);
  assert.deepEqual(r.messages, []);
});

const multiLineCommand = "printf 'row-one\\nrow-two\\nrow-three\\nrow-four\\n'";

function assertOutputPreview(lines: string[]) {
  for (const row of ["row-one", "row-two", "row-three"]) assert.ok(lines.includes(row));
  assert.ok(!lines.includes("row-four"));
  assert.equal(lines.filter((line) => line.startsWith("…")).length >= 1, true);
}

test("blocking results keep metadata and limit each job to three visual rows until expanded", async (t) => {
  const r = runtime(t, null);
  const result = await r.execute({ commands: [
    { command: multiLineCommand },
    { command: "printf '%0200d%s%s\\n' 0 'wrapped-' 'tail'" },
    { command: "printf 'short-output\\n'" },
  ] });
  const collapsed = r.renderToolResult(result, false);
  assertOutputPreview(collapsed);
  assert.equal(collapsed.filter((line) => line === "exit_code: 0").length, 3);
  assert.equal(collapsed.filter((line) => line.startsWith("duration_ms: ")).length, 3);
  assert.equal(collapsed.filter((line) => /^0+$/.test(line)).length, 3);
  assert.equal(collapsed.filter((line) => line.startsWith("…")).length, 2);
  assert.ok(collapsed.includes("short-output"));
  assert.match(result.content[0].text, /\nrow-four\n/);
  assert.match(result.content[0].text, /0wrapped-tail/);
  const expanded = r.renderToolResult(result, true);
  assert.ok(expanded.includes("row-four"));
  assert.ok(expanded.some((line) => /0wrapped-tail$/.test(line)));
  assert.ok(!expanded.some((line) => line.startsWith("…")));
});

test("background results keep full context and show only a preview in the transcript", async (t) => {
  const r = runtime(t, null);
  await r.execute({ mode: "background", commands: [{ command: multiLineCommand }] });
  await until(() => r.messages.length === 1);
  const message = r.messages[0]!;
  assert.match(message.content, /\nrow-four$/);
  assert.deepEqual(r.notifications, ["Delegate job w1: ok"]);
  const collapsed = r.renderMessage(message, false);
  assert.ok(collapsed.includes("status: ok"));
  assertOutputPreview(collapsed);
  assert.ok(r.renderMessage(message, true).includes("row-four"));
});

test("PowerShell executes directly and preserves non-zero exit status", { skip: process.platform !== "win32" }, async (t) => {
  const r = runtime(t, null);
  const result = await r.execute({ commands: [{ command: "Write-Output 'ps-out'; exit 11", shell: "powershell" }] });
  assert.match(result.content[0].text, /exit_code: 11/);
  assert.match(result.content[0].text, /ps-out/);
});

test("command output is bounded and strips control characters", async (t) => {
  const r = runtime(t, null);
  const result = await r.execute({ commands: [{ command: "printf '\\033'; printf '%20000s\\105\\116\\104' ''" }] });
  assert.match(result.content[0].text, /\[command output truncated\]/);
  assert.doesNotMatch(result.content[0].text, /\u001b|END/);
  assert.ok(result.content[0].text.length < 17_000);
});

test("cancel-worker stops an active command and posts its final status", async (t) => {
  const r = runtime(t, null);
  await r.execute({ mode: "background", commands: [{ command: "touch started; sleep 60; touch finished" }] });
  await until(() => existsSync(join(r.cwd, "started")));
  await r.cancel("w1");
  await until(() => r.messages.length === 1);
  assert.equal(r.messages[0]?.details.status, "cancelled");
  assert.equal(existsSync(join(r.cwd, "finished")), false);
});

test("a deadline reports timeout and session shutdown suppresses background completion", async (t) => {
  const r = runtime(t, null);
  const timed = await r.execute({ commands: [{ command: "sleep 60", timeoutMs: 200 }] });
  assert.match(timed.content[0].text, /status: timed out/);
  await r.execute({ mode: "background", commands: [{ command: "touch started; sleep 60; touch finished" }] });
  await until(() => existsSync(join(r.cwd, "started")));
  await r.stop();
  assert.deepEqual(r.messages, []);
  assert.equal(existsSync(join(r.cwd, "finished")), false);
});
