import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
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
  const handlers = new Map<string, (event?: unknown, ctx?: ExtensionToolContext) => Promise<void>>();
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
  let statusTool: Pick<typeof tool, "execute">;
  let waitTool: Pick<typeof tool, "execute">;
  delegateWorkersExtension({
    events,
    getSettings: () => settings,
    on: (name: string, handler: () => Promise<void>) => handlers.set(name, handler),
    registerCommand: (name: string, command: never) => commands.set(name, command),
    registerTool: (definition: typeof tool & { name: string }) => {
      if (definition.name === "delegate_tasks") tool = definition;
      if (definition.name === "delegate_status") statusTool = definition;
      if (definition.name === "delegate_wait") waitTool = definition;
    },
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
    start: () => handlers.get("session_start")!({ type: "session_start" }, ctx),
    status: (id?: string) => statusTool.execute("status-call", id === undefined ? {} : { id }, undefined, undefined, ctx),
    wait: (ids?: string[], signal?: AbortSignal) => waitTool.execute("wait-call", ids === undefined ? {} : { ids }, signal, undefined, ctx),
    execute: (params: unknown, signal?: AbortSignal) => tool.execute("test-call", params, signal, undefined, ctx),
    renderToolResult: (result: AgentToolResult<unknown>, expanded: boolean) =>
      tool.renderResult(result, { expanded, isPartial: false }, theme).render(60).map((line) => line.trim()),
    renderMessage: (message: (typeof messages)[number], expanded: boolean) =>
      renderers.get(message.customType)!(
        { ...message, role: "custom", timestamp: 0 },
        { expanded, outputPad: 1, keyText: () => "", keyHint: () => "" },
        theme,
      )!.render(60).map((line) => line.trim()),
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
  assert.deepEqual((await r.status("w2")).details.jobs, [{ id: "w2", label: "printf fast; printf stderr >&2; exit 7", status: "error" }]);
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

test("delegate_status lists queued and running jobs and looks up finished jobs by ID", async (t) => {
  const r = runtime(t, null);
  assert.match((await r.status()).content[0].text, /No active delegate jobs/);
  assert.match((await r.status("w99")).content[0].text, /not found/);
  await r.execute({ mode: "background", commands: [
    { command: "touch started1; while [ ! -f release ]; do sleep 0.05; done" },
    { command: "touch started2; while [ ! -f release ]; do sleep 0.05; done" },
  ] });
  await until(() => existsSync(join(r.cwd, "started1")) && existsSync(join(r.cwd, "started2")));
  await r.execute({ mode: "background", commands: [{ command: "printf third" }] });
  const active = (await r.status()).details.jobs;
  assert.equal(active.length, 3);
  assert.equal(active.find((job: { id: string }) => job.id === "w1")?.status, "running");
  assert.deepEqual((await r.status("W3")).details.jobs, [{
    id: "w3", label: "printf third", status: "queued", progress: "Waiting for a worker slot",
  }]);
  writeFileSync(join(r.cwd, "release"), "");
  await until(() => r.messages.length === 3);
  assert.deepEqual((await r.status()).details.jobs, []);
  assert.deepEqual((await r.status("w3")).details.jobs, [{ id: "w3", label: "printf third", status: "ok" }]);
  await r.start();
  assert.match((await r.status("w3")).content[0].text, /not found/);
});

test("delegate_wait reports no active jobs and rejects unknown IDs", async (t) => {
  const r = runtime(t, null);
  assert.equal((await r.wait()).content[0].text, "No active delegate jobs.");
  await assert.rejects(r.wait(["w99"]), /w99/);
  await r.execute({ commands: [{ command: "printf completed-output" }] });
  assert.equal((await r.wait()).content[0].text, "No active delegate jobs.");
  await assert.rejects(r.wait(["w1", "w99"]), /w99/);
});

test("delegate_wait snapshots active jobs and does not wait for jobs started later", async (t) => {
  const r = runtime(t, null);
  await r.execute({ mode: "background", commands: [
    { command: "touch started-first; while [ ! -f release-first ]; do sleep 0.05; done; printf first-output" },
  ] });
  await until(() => existsSync(join(r.cwd, "started-first")));
  let settled = false;
  const waiting = r.wait().then((result) => { settled = true; return result; });
  await r.execute({ mode: "background", commands: [
    { command: "touch started-later; while [ ! -f release-later ]; do sleep 0.05; done; printf later-output" },
  ] });
  await until(() => existsSync(join(r.cwd, "started-later")));
  assert.equal(settled, false);
  writeFileSync(join(r.cwd, "release-first"), "");
  await until(() => settled);
  const result = await waiting;
  assert.match(result.content[0].text, /first-output/);
  assert.match(result.content[0].text, /exit_code: 0/);
  assert.doesNotMatch(result.content[0].text, /later-output/);
  assert.equal((await r.status("w2")).details.jobs[0]?.status, "running");
  writeFileSync(join(r.cwd, "release-later"), "");
  await until(() => r.messages.length === 2);
});

test("delegate_wait includes background results that finished before the wait", async (t) => {
  const r = runtime(t, null);
  const started = await r.execute({ mode: "background", commands: [
    { command: "printf '%s' early-result" },
    { command: "while [ ! -f release ]; do sleep 0.05; done; printf '%s' late-result" },
  ] });
  await until(() => r.messages.length === 1);
  const waiting = r.wait();
  writeFileSync(join(r.cwd, "release"), "");
  const result = await waiting;
  assert.deepEqual([...result.details.ids].sort(), started.details.ids);
  assert.match(result.content[0].text, /\nearly-result(?:\n|$)/);
  assert.match(result.content[0].text, /\nlate-result(?:\n|$)/);
  assert.deepEqual((await r.wait()).details.ids, []);
});

test("delegate_wait waits for explicit running and queued jobs and returns recent completions", async (t) => {
  const r = runtime(t, null);
  await r.execute({ mode: "background", commands: [
    { command: "touch started1; while [ ! -f release ]; do sleep 0.05; done; printf running-output" },
    { command: "touch started2; while [ ! -f release-unselected ]; do sleep 0.05; done; printf unselected-output" },
    { command: "printf queued-output; printf queued-error >&2; exit 7" },
  ] });
  await until(() => existsSync(join(r.cwd, "started1")) && existsSync(join(r.cwd, "started2")));
  assert.equal((await r.status("w3")).details.jobs[0]?.status, "queued");
  let settled = false;
  const waiting = r.wait(["w1", "w3"]).then((result) => { settled = true; return result; });
  const allWaiting = r.wait();
  await delay(30);
  assert.equal(settled, false);
  writeFileSync(join(r.cwd, "release"), "");
  await until(() => settled);
  const result = await waiting;
  assert.match(result.content[0].text, /running-output/);
  assert.match(result.content[0].text, /queued-output/);
  assert.match(result.content[0].text, /queued-error/);
  assert.match(result.content[0].text, /exit_code: 0/);
  assert.match(result.content[0].text, /exit_code: 7/);
  assert.doesNotMatch(result.content[0].text, /unselected-output/);
  assert.equal((await r.status("w2")).details.jobs[0]?.status, "running");
  writeFileSync(join(r.cwd, "release-unselected"), "");
  const allResults = await allWaiting;
  assert.match(allResults.content[0].text, /running-output/);
  assert.match(allResults.content[0].text, /unselected-output/);
  assert.match(allResults.content[0].text, /queued-output/);
  await until(() => r.messages.length === 3);
  const completed = await r.wait(["w3"]);
  assert.match(completed.content[0].text, /queued-output/);
  assert.match(completed.content[0].text, /queued-error/);
  assert.match(completed.content[0].text, /exit_code: 7/);
  assert.doesNotMatch(completed.content[0].text, /running-output|unselected-output/);
});

test("aborting delegate_wait rejects the wait without cancelling its background job", async (t) => {
  const r = runtime(t, null);
  await r.execute({ mode: "background", commands: [
    { command: "touch started; while [ ! -f release ]; do sleep 0.05; done; printf survived-wait-abort" },
  ] });
  await until(() => existsSync(join(r.cwd, "started")));
  const controller = new AbortController();
  const waiting = r.wait(["w1"], controller.signal);
  const rejected = assert.rejects(waiting);
  controller.abort();
  await rejected;
  assert.equal((await r.status("w1")).details.jobs[0]?.status, "running");
  assert.equal(r.messages.length, 0);
  writeFileSync(join(r.cwd, "release"), "");
  await until(() => r.messages.length === 1);
  assert.equal(r.messages[0]?.details.status, "ok");
  assert.match(r.messages[0]!.content, /survived-wait-abort/);
  assert.match((await r.wait(["w1"])).content[0].text, /survived-wait-abort/);
});

test("delegate_status retains no more than 50 finished jobs", async (t) => {
  const r = runtime(t, null);
  await r.execute({ commands: [{ command: ":" }] });
  for (let batch = 0; batch < 25; batch++) {
    await r.execute({ commands: [{ command: ":" }, { command: ":" }] });
  }
  assert.match((await r.status("w1")).content[0].text, /not found/);
  assert.equal((await r.status("w2")).details.jobs[0]?.status, "ok");
  assert.equal((await r.status("w51")).details.jobs[0]?.status, "ok");
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

test("blocking command results use one visual line per job until expanded", async (t) => {
  const r = runtime(t, null);
  const result = await r.execute({ commands: [
    { command: multiLineCommand },
    { command: "printf '%0200d%s%s\\n' 0 'wrapped-' 'tail'" },
    { command: "exit 7" },
  ] });
  const collapsed = r.renderToolResult(result, false);
  assert.equal(collapsed.length, 3);
  assert.match(collapsed[0]!, /^w1 \[bash\] ok \(exit 0, \d+ ms\): row-one row-two /);
  assert.match(stripVTControlCharacters(collapsed[1]!), /^w2 \[bash\] ok \(exit 0, \d+ ms\): 0+\.{3}$/);
  assert.match(collapsed[2]!, /^w3 \[bash\] error \(exit 7, \d+ ms\): \(no output\)$/);
  assert.match(result.content[0].text, /\nrow-four\n/);
  assert.match(result.content[0].text, /0wrapped-tail/);
  const expanded = r.renderToolResult(result, true);
  assert.ok(expanded.includes("row-four"));
  assert.ok(expanded.some((line) => /0wrapped-tail$/.test(line)));
  assert.ok(expanded.includes("exit_code: 7"));
});

test("background results keep full context and show only a preview in the transcript", async (t) => {
  const r = runtime(t, null);
  await r.execute({ mode: "background", commands: [{ command: multiLineCommand }] });
  await until(() => r.messages.length === 1);
  const message = r.messages[0]!;
  assert.match(message.content, /\nrow-four$/);
  assert.deepEqual(r.notifications, ["Delegate job w1: ok"]);
  const collapsed = r.renderMessage(message, false).filter(Boolean);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0]!, /^w1 \[bash\] ok \(exit 0, \d+ ms\): row-one row-two /);
  assert.ok(r.renderMessage(message, true).includes("row-four"));
});

test("PowerShell executes directly and preserves non-zero exit status", { skip: process.platform !== "win32" }, async (t) => {
  const r = runtime(t, null);
  const result = await r.execute({ commands: [{ command: "Write-Output 'ps-out', 'ps-next'; exit 11", shell: "powershell" }] });
  assert.match(result.content[0].text, /exit_code: 11/);
  assert.match(result.content[0].text, /ps-out\r?\nps-next/);
  const collapsed = r.renderToolResult(result, false);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0]!, /^w1 \[powershell\] error \(exit 11, \d+ ms\): ps-out ps-next$/);
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
  const cancellation = r.cancel("w1");
  assert.equal((await r.status("w1")).details.jobs[0]?.status, "cancelling");
  await cancellation;
  await until(() => r.messages.length === 1);
  assert.equal(r.messages[0]?.details.status, "cancelled");
  assert.equal((await r.status("w1")).details.jobs[0]?.status, "cancelled");
  assert.equal(existsSync(join(r.cwd, "finished")), false);
});

test("a deadline reports timeout and session shutdown suppresses background completion", async (t) => {
  const r = runtime(t, null);
  const timed = await r.execute({ commands: [{ command: "sleep 60", timeoutMs: 200 }] });
  assert.match(timed.content[0].text, /status: timed out/);
  assert.equal((await r.status("w1")).details.jobs[0]?.status, "timed out");
  await r.execute({ mode: "background", commands: [{ command: "touch started; sleep 60; touch finished" }] });
  await until(() => existsSync(join(r.cwd, "started")));
  await r.stop();
  assert.deepEqual(r.messages, []);
  assert.equal(existsSync(join(r.cwd, "finished")), false);
});
