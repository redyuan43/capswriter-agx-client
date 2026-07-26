const assert = require("node:assert/strict");
const test = require("node:test");

const policyPromise = import("../src/helpers/asrResultPolicy.mjs");

test("ASR payload policy accepts recognized text, partials, and voice commands", async () => {
  const { extractASRText, isUsableASRPayload } = await policyPromise;

  assert.equal(extractASRText({ final_text: "  recognized  " }), "recognized");
  assert.equal(extractASRText({ partial_text: "latest partial" }), "latest partial");
  assert.equal(isUsableASRPayload({ success: true, text: "recognized" }), true);
  assert.equal(isUsableASRPayload({ success: true, voice_command_applied: true }), true);
  assert.equal(isUsableASRPayload({ success: true, text: "" }), false);
  assert.equal(isUsableASRPayload({ success: false, text: "recognized" }), false);
});

test("realtime protocol errors preserve server diagnostics", async () => {
  const { createRealtimeProtocolError } = await policyPromise;
  const payload = {
    type: "error",
    error: "realtime ASR audio stopped without finish or cancel",
    reason: "audio_idle_without_finish",
    fallback: "upload",
  };

  const error = createRealtimeProtocolError(payload, "realtime error");

  assert.equal(error.message, payload.error);
  assert.equal(error.realtimeReason, payload.reason);
  assert.equal(error.realtimeFallback, "upload");
  assert.equal(error.realtimePayload, payload);
});
