const scenario = process.argv[2];
let buffer = "";
let prompts = 0;

const usage = {
  input: 2,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0.002, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.005 },
};

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function finish(text) {
  send({ type: "agent_start" });
  const line = Buffer.from(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  }) + "\n");
  const unicodeOffset = line.indexOf(Buffer.from("\u2028"));
  const splitAt = unicodeOffset === -1 ? 8 : unicodeOffset + 1;
  process.stdout.write(line.subarray(0, splitAt));
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.stdout.write(line.subarray(splitAt));
  send({ type: "message_end", message: { role: "assistant", usage } });
  if (prompts === 1) send({ type: "compaction_end", result: { usage } });
  send({ type: "agent_end", messages: [] });
  send({ type: "agent_settled" });
}

function receive(record) {
  if (record.type === "abort") {
    send({ type: "extension_ui_request", id: "abort-notice", method: "notify", message: "abort received" });
    return;
  }
  if (record.type === "extension_ui_response") {
    finish(record.confirmed ? "confirmed" : "declined");
    return;
  }
  if (record.type !== "prompt") return;

  prompts++;
  if (scenario === "exit") {
    process.stderr.write("x".repeat(10_000) + "failure at end", () => process.exit(17));
    return;
  }
  if (scenario === "error" || (scenario === "second-error" && prompts === 2)) {
    send({ type: "response", id: record.id, command: "prompt", success: false, error: "prompt rejected" });
    return;
  }
  send({ type: "response", id: record.id, command: "prompt", success: true });
  if (scenario === "stall") return;
  if (scenario === "dialog") {
    send({ type: "extension_ui_request", id: "approval", method: "confirm", title: "Approve", message: "Continue?" });
    return;
  }
  if (prompts === 1) process.stdout.write("not-json\n");
  finish(prompts === 1 ? `first:\u2028${"x".repeat(50)}` : "summary");
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    receive(JSON.parse(line));
  }
});
