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

test("final timeout falls back to the latest usable partial only", async () => {
  const {
    createRealtimeProtocolError,
    selectRealtimeFinalTimeoutFallback,
  } = await policyPromise;
  const partial = { type: "partial", success: true, text: "latest partial" };
  const timeout = new Error("Realtime ASR final timeout (31740ms)");
  timeout.code = "REALTIME_ASR_FINAL_TIMEOUT";

  assert.deepEqual(
    selectRealtimeFinalTimeoutFallback(timeout, partial),
    { ...partial, partial_fallback: true }
  );
  assert.equal(
    selectRealtimeFinalTimeoutFallback(new Error("Realtime ASR websocket error"), partial),
    null
  );
  assert.equal(
    selectRealtimeFinalTimeoutFallback(
      createRealtimeProtocolError({
        type: "error",
        error: "Realtime ASR final timeout (server-side explicit error)",
        reason: "server_busy",
      }, "realtime error"),
      partial
    ),
    null
  );
  const emptyTimeout = new Error("Realtime ASR final timeout (5000ms)");
  emptyTimeout.code = "REALTIME_ASR_FINAL_TIMEOUT";
  assert.equal(
    selectRealtimeFinalTimeoutFallback(
      emptyTimeout,
      { type: "partial", success: true, text: "" }
    ),
    null
  );
});

test("interrupted realtime audio falls back to the latest usable partial", async () => {
  const { createRealtimeProtocolError, selectRealtimeStreamFailureFallback } =
    await policyPromise;
  const partial = { type: "partial", success: true, text: "latest partial" };
  const streamError = createRealtimeProtocolError({
    type: "error",
    error: "realtime ASR audio stopped without finish or cancel",
    reason: "audio_idle_without_finish",
  }, "realtime error");
  const stalledError = new Error("PCM stalled");
  stalledError.realtimeReason = "client_pcm_stalled";

  assert.deepEqual(
    selectRealtimeStreamFailureFallback(streamError, partial),
    {
      ...partial,
      partial_fallback: true,
      partial_fallback_reason: "audio_idle_without_finish",
    }
  );
  assert.deepEqual(
    selectRealtimeStreamFailureFallback(stalledError, partial),
    {
      ...partial,
      partial_fallback: true,
      partial_fallback_reason: "client_pcm_stalled",
    }
  );
  assert.equal(
    selectRealtimeStreamFailureFallback(
      createRealtimeProtocolError({
        type: "error",
        error: "upstream overload",
        reason: "server_busy",
      }, "realtime error"),
      partial
    ),
    null
  );
});
