const assert = require("node:assert/strict");
const test = require("node:test");

const M5RecordingSessions = require("../src/helpers/m5RecordingSessions");

test("recording sessions track audio and expose the newest active session", () => {
  let now = 1000;
  const sessions = new M5RecordingSessions({ now: () => now });
  const first = sessions.create({
    id: "first",
    intent: "dictation",
    mode: "dictation",
    targetWindowId: "42",
  });
  now = 2000;
  const second = sessions.create({
    id: "second",
    intent: "cyber_fortune",
    mode: "cyber_fortune",
  });

  assert.equal(sessions.appendAudio(first, Buffer.from([1, 2, 3])), true);
  assert.equal(first.bytes, 3);
  assert.equal(first.chunks, 1);
  assert.equal(Buffer.concat(first.audioChunks).toString("hex"), "010203");
  assert.equal(sessions.latestId(), "second");
  assert.deepEqual(sessions.currentState(), {
    status: "recording",
    session_id: "first",
    source: "m5stickc_plus",
    intent: "dictation",
  });

  sessions.finish(first, { success: true, status: "pasted" });
  assert.deepEqual(sessions.currentState(), {
    status: "recording",
    session_id: "second",
    source: "m5stickc_plus",
    intent: "cyber_fortune",
  });
  assert.equal(sessions.appendAudio(first, Buffer.from([4])), false);
});

test("recording session wait resolves once and clears its timeout", async (t) => {
  const sessions = new M5RecordingSessions({ cleanupMs: 10 });
  const session = sessions.create({
    id: "wait-once",
    intent: "dictation",
    mode: "dictation",
  });

  const waiting = sessions.waitForResult(session, 1000, () => {
    sessions.finish(session, {
      success: false,
      status: "transcription_failed",
      error: "timeout",
    });
  });
  assert.equal(sessions.finish(session, {
    success: true,
    status: "pasted",
    text: "ready",
  }), true);
  assert.equal(sessions.finish(session, {
    success: false,
    status: "transcription_failed",
  }), false);
  assert.deepEqual(await waiting, {
    success: true,
    status: "pasted",
    text: "ready",
  });
  assert.equal(session.stopTimer, null);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessions.get("wait-once"), undefined);
  t.after(() => sessions.clear());
});

test("recording session wait applies the timeout result", async (t) => {
  const sessions = new M5RecordingSessions({ cleanupMs: 10 });
  const session = sessions.create({
    id: "timeout",
    intent: "dictation",
    mode: "dictation",
  });

  const result = await sessions.waitForResult(session, 5, () => {
    sessions.finish(session, {
      success: false,
      status: "transcription_failed",
      error: "Timed out waiting for CapsWriter renderer",
    });
  });
  assert.equal(session.done, true);
  assert.equal(session.status, "transcription_failed");
  assert.equal(result.error, "Timed out waiting for CapsWriter renderer");
  t.after(() => sessions.clear());
});
