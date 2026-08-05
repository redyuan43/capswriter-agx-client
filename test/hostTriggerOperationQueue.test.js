const assert = require("node:assert/strict");
const test = require("node:test");

const HostTriggerOperationQueue = require("../src/helpers/hostTriggerOperationQueue");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("waits for a slow trigger start before processing its release", async () => {
  const queue = new HostTriggerOperationQueue();
  const routeReady = deferred();
  const events = [];

  const start = queue.enqueue(async () => {
    events.push("start_requested");
    await routeReady.promise;
    events.push("start_completed");
  });
  const release = queue.enqueue(async () => {
    events.push("release_processed");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start_requested"]);

  routeReady.resolve();
  await Promise.all([start, release]);
  assert.deepEqual(events, [
    "start_requested",
    "start_completed",
    "release_processed",
  ]);
});

test("does not let a failed operation block the next release", async () => {
  const queue = new HostTriggerOperationQueue();
  const events = [];

  await assert.rejects(
    queue.enqueue(async () => {
      events.push("start_failed");
      throw new Error("route unavailable");
    }),
    /route unavailable/,
  );
  await queue.enqueue(async () => {
    events.push("release_processed");
  });

  assert.deepEqual(events, ["start_failed", "release_processed"]);
});

test("serializes route handoff between different triggers", async () => {
  const queue = new HostTriggerOperationQueue();
  const keyboardReady = deferred();
  const events = [];

  const keyboard = queue.enqueue(async () => {
    events.push("keyboard_start");
    await keyboardReady.promise;
  });
  const miniJoy = queue.enqueue(async () => {
    events.push("minijoy_start");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["keyboard_start"]);
  keyboardReady.resolve();
  await Promise.all([keyboard, miniJoy]);
  assert.deepEqual(events, ["keyboard_start", "minijoy_start"]);
});
