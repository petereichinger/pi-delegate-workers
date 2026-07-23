import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerArgs } from "../extensions/rpc-worker.ts";

function withEnvironment(values: Record<string, string | undefined>, run: () => void) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("adds routed model and thinking CLI arguments", () => {
  withEnvironment(
    {
      PI_DELEGATE_TOOL_GUARD: "0",
      PI_DELEGATE_EXTRA_ARGS: "--offline",
    },
    () => {
      assert.deepEqual(
        buildWorkerArgs(["read"], {
          model: "openai/small",
          thinkingLevel: "low",
        }),
        [
          "--mode",
          "rpc",
          "--no-session",
          "--tools",
          "read",
          "--offline",
          "--model",
          "openai/small",
          "--thinking",
          "low",
        ],
      );
    },
  );
});

test("routed values replace conflicting extra arguments", () => {
  withEnvironment(
    {
      PI_DELEGATE_TOOL_GUARD: "0",
      PI_DELEGATE_EXTRA_ARGS:
        "--provider old --model old/model --thinking high --offline",
    },
    () => {
      const args = buildWorkerArgs(["read"], {
        model: "new/model",
        thinkingLevel: "minimal",
      });
      assert.equal(args.includes("old"), false);
      assert.equal(args.includes("old/model"), false);
      assert.equal(args.includes("high"), false);
      assert.deepEqual(args.slice(-5), [
        "--offline",
        "--model",
        "new/model",
        "--thinking",
        "minimal",
      ]);
    },
  );
});

test("keeps extension discovery enabled unless tool-guard isolation is explicit", () => {
  withEnvironment(
    {
      PI_DELEGATE_TOOL_GUARD: "1",
      PI_DELEGATE_TOOL_GUARD_EXTENSION: "/tmp/pi-tool-guard",
      PI_DELEGATE_TOOL_GUARD_ISOLATE: undefined,
      PI_DELEGATE_EXTRA_ARGS: undefined,
    },
    () => {
      const normalArgs = buildWorkerArgs(["read"], { model: "custom/model" });
      assert.equal(normalArgs.includes("--no-extensions"), false);
      assert.equal(normalArgs.includes("--extension"), true);
    },
  );

  withEnvironment(
    {
      PI_DELEGATE_TOOL_GUARD: "1",
      PI_DELEGATE_TOOL_GUARD_EXTENSION: "/tmp/pi-tool-guard",
      PI_DELEGATE_TOOL_GUARD_ISOLATE: "1",
      PI_DELEGATE_EXTRA_ARGS: undefined,
    },
    () => {
      const isolatedArgs = buildWorkerArgs(["read"], { model: "custom/model" });
      assert.equal(isolatedArgs.includes("--no-extensions"), true);
    },
  );
});

test("null explicitly clears extra model and thinking arguments", () => {
  withEnvironment(
    {
      PI_DELEGATE_TOOL_GUARD: "0",
      PI_DELEGATE_EXTRA_ARGS: "--model old/model --thinking high --offline",
    },
    () => {
      const args = buildWorkerArgs(["read"], {
        model: null,
        thinkingLevel: null,
      });
      assert.equal(args.includes("--model"), false);
      assert.equal(args.includes("--thinking"), false);
      assert.equal(args.includes("--offline"), true);
    },
  );
});
