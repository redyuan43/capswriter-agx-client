const assert = require("node:assert/strict");
const fs = require("node:fs");
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
  assert.equal(fs.readFileSync(first.pcmFile).toString("hex"), "010203");
  assert.equal(sessions.latestId(), "second");
  assert.deepEqual(sessions.currentState(), {
    status: "recording",
    session_id: "first",
    source: "m5stickc_plus",
    intent: "dictation",
  });

  assert.equal(sessions.finish(first, { success: true, status: "pasted" }).finished, true);
  assert.deepEqual(sessions.currentState(), {
    status: "recording",
    session_id: "second",
    source: "m5stickc_plus",
    intent: "cyber_fortune",
  });
  assert.equal(sessions.appendAudio(first, Buffer.from([4])), false);
  sessions.clear();
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
  }).finished, true);
  assert.equal(sessions.finish(session, {
    success: false,
    status: "transcription_failed",
  }).finished, false);
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

test("recording sessions own follow-up queue, cancellation, and dispatch claims", () => {
  const sessions = new M5RecordingSessions();
  const session = sessions.create({
    id: "followup",
    intent: "dictation",
    mode: "dictation",
    targetWindowId: "42",
  });

  assert.equal(sessions.queueEnter("missing").status, "session_not_found");
  assert.equal(sessions.queueEnter("followup").status, "queued");
  assert.equal(session.pendingEnter, true);
  assert.equal(sessions.claimEnterDispatch(session, {
    success: false,
    status: "transcription_failed",
  }).status, "paste_not_successful");

  const claim = sessions.claimEnterDispatch(session, {
    success: true,
    status: "pasted",
  });
  assert.equal(claim.status, "claimed");
  assert.equal(claim.targetWindowId, "42");
  assert.equal(sessions.claimEnterDispatch(session, {
    success: true,
    status: "pasted",
  }).status, "dispatching");

  sessions.settleEnterDispatch(session, { sent: true });
  assert.equal(session.enterSent, true);
  assert.equal(session.enterDispatching, false);
  assert.equal(sessions.claimEnterDispatch(session, {
    success: true,
    status: "pasted",
  }).status, "already_sent");
});

test("recording cancellation clears a queued Enter and rejects completed sessions", () => {
  const sessions = new M5RecordingSessions();
  const session = sessions.create({
    id: "cancel",
    intent: "dictation",
    mode: "dictation",
  });

  sessions.queueEnter("cancel");
  const cancellation = sessions.requestCancel("cancel");
  assert.equal(cancellation.status, "cancelled");
  assert.equal(cancellation.session, session);
  assert.equal(session.cancelRequested, true);
  assert.equal(session.pendingEnter, false);

  sessions.finish(session, { success: true, status: "cancelled" });
  assert.equal(sessions.queueEnter("cancel").status, "session_completed");
  assert.equal(sessions.requestCancel("cancel").status, "session_completed");
  sessions.clear();
});
