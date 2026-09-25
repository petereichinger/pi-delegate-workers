import assert from "node:assert/strict";
import test from "node:test";
import { appendStderr } from "../extensions/rpc-worker.ts";

test("keeps recent stderr within the limit across chunks", () => {
  let buffer = { text: "", truncated: false };
  buffer = appendStderr(buffer, "a".repeat(8_192));
  assert.equal(buffer.text.length, 8_192);
  assert.equal(buffer.truncated, false);

  buffer = appendStderr(buffer, "final error");
  assert.equal(buffer.text.length, 8_192);
  assert.equal(buffer.text.endsWith("final error"), true);
  assert.equal(buffer.truncated, true);

  buffer = appendStderr(buffer, "!");
  assert.equal(buffer.text.length, 8_192);
  assert.equal(buffer.text.endsWith("final error!"), true);
  assert.equal(buffer.truncated, true);
});

test("bounds a single large stderr chunk", () => {
  const buffer = appendStderr(
    { text: "previous", truncated: false },
    "x".repeat(100_000) + "diagnostic",
  );
  assert.equal(buffer.text.length, 8_192);
  assert.equal(buffer.text.endsWith("diagnostic"), true);
  assert.equal(buffer.truncated, true);
});
