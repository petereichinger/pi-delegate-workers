import assert from "node:assert/strict";
import test from "node:test";
import { runTask } from "../extensions/index.ts";
import { emptyUsage } from "../extensions/rpc-worker.ts";
import { createRpcUiDialogQueue } from "../extensions/ui-dialog-queue.ts";
import { createWidgetRefresh } from "../extensions/widget-refresh.ts";

test("coalesces text updates, while status changes flush and cancel pending updates", () => {
  let now = 0;
  let pending: { callback: () => void; due: number; handle: ReturnType<typeof setTimeout> } | undefined;
  const renders: string[] = [];
  const widget = createWidgetRefresh(
    (text: string) => { renders.push(text); },
    undefined,
    {
      now: () => now,
      setTimer: (callback, delay) => {
        const handle = { id: 1 } as unknown as ReturnType<typeof setTimeout>;
        pending = { callback, due: now + delay, handle };
        return handle;
      },
      clearTimer: (handle) => {
        if (pending?.handle === handle) pending = undefined;
      },
    },
  );
  const advance = (ms: number) => {
    now += ms;
    if (pending && pending.due <= now) {
      const callback = pending.callback;
      pending = undefined;
      callback();
    }
  };

  widget.immediate("starting");
  for (let index = 0; index < 100; index++) widget.schedule(`delta ${index}`);
  assert.deepEqual(renders, ["starting"]);
  advance(999);
  assert.deepEqual(renders, ["starting"]);
  advance(1);
  assert.deepEqual(renders, ["starting", "delta 99"]);

  widget.schedule("stale text");
  widget.immediate("done");
  widget.schedule("discard on shutdown");
  widget.cancel();
  advance(100);
  assert.deepEqual(renders, ["starting", "delta 99", "done"]);
  widget.immediate("new session");
  assert.equal(renders.at(-1), "new session");
});

test("runTask refreshes on state changes but not on every text delta", async () => {
  const widgets: Array<string[] | undefined> = [];
  const ctx = {
    cwd: process.cwd(),
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_key: string, lines?: string[]) => { widgets.push(lines); },
    },
  } as any;
  const workers = new Map();
  const widgetRefresh = createWidgetRefresh((context: typeof ctx) => {
    const lines = [...workers.values()].flatMap((worker) => [worker.latestMessage]);
    context.ui.setWidget("delegate-workers", lines.length ? lines : undefined);
  });

  const result = await runTask(
    ctx,
    workers,
    { task: "stream", profile: "balanced", modelSetSource: "none" },
    "w1",
    {
      uiDialogQueue: createRpcUiDialogQueue(),
      reportInputStatus: () => undefined,
      widgetRefresh,
      createWorker: (() => ({
        prompt: async (_message: string, options: { onEvent?: (event: any) => void } = {}) => {
          options.onEvent?.({ type: "agent_start" });
          options.onEvent?.({ type: "message_start", message: { role: "assistant" } });
          for (let index = 0; index < 100; index++) {
            options.onEvent?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "word " },
            });
          }
          options.onEvent?.({ type: "agent_end" });
          return { text: "done" };
        },
        getUsage: emptyUsage,
        abort: () => undefined,
        dispose: () => undefined,
      })) as any,
    },
  );

  assert.equal(result.ok, true);
  assert.ok(widgets.length < 20, `received ${widgets.length} widget updates for 200 text deltas`);
  assert.equal(widgets.at(-1), undefined);
  widgetRefresh.cancel();
});
