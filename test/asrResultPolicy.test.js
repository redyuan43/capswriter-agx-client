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

test("latest partial fallback is promoted to a successful final payload", async () => {
  const { buildLatestPartialASRFallback } = await policyPromise;
  const fallback = buildLatestPartialASRFallback({
    type: "partial",
    partial_text: "server partial",
    request_id: "rt-1",
  }, "final timeout");

  assert.equal(fallback.type, "final");
  assert.equal(fallback.success, true);
  assert.equal(fallback.final_text, "server partial");
  assert.equal(fallback.asr_text, "server partial");
  assert.equal(fallback.realtime_final_error, "final timeout");
  assert.equal(buildLatestPartialASRFallback({ success: true, partial_text: "" }), null);
});

test("first usable result ignores an empty upload and keeps waiting for realtime", async () => {
  const { settleASRCandidate, waitForFirstUsableASRResult } = await policyPromise;
  let resolveRealtime;
  const realtime = new Promise((resolve) => {
    resolveRealtime = resolve;
  });
  const settledSources = [];
  const outcomePromise = waitForFirstUsableASRResult([
    settleASRCandidate("realtime", realtime),
    settleASRCandidate("upload", Promise.resolve({ success: true, text: "" })),
  ], {
    onSettled: (result) => settledSources.push(result.source),
  });

  await new Promise((resolve) => setImmediate(resolve));
  resolveRealtime({ success: true, final_text: "server final" });

  const outcome = await outcomePromise;
  assert.equal(outcome.winner.source, "realtime");
  assert.equal(outcome.winner.payload.final_text, "server final");
  assert.deepEqual(settledSources, ["upload", "realtime"]);
});

test("first usable result accepts upload recovery after realtime failure", async () => {
  const { settleASRCandidate, waitForFirstUsableASRResult } = await policyPromise;
  const outcome = await waitForFirstUsableASRResult([
    settleASRCandidate("realtime", Promise.reject(new Error("final timeout"))),
    settleASRCandidate("upload", Promise.resolve({ success: true, asr_text: "upload text" })),
  ]);

  assert.equal(outcome.winner.source, "upload");
  assert.equal(outcome.winner.payload.asr_text, "upload text");
});

test("first usable result reports no winner when every candidate is unusable", async () => {
  const { settleASRCandidate, waitForFirstUsableASRResult } = await policyPromise;
  const outcome = await waitForFirstUsableASRResult([
    settleASRCandidate("realtime", Promise.resolve({ success: true, final_text: "" })),
    settleASRCandidate("upload", Promise.reject(new Error("upload failed"))),
  ]);

  assert.equal(outcome.winner, null);
  assert.equal(outcome.settled.length, 2);
  assert.equal(outcome.settled.some((result) => result.error?.message === "upload failed"), true);
});
