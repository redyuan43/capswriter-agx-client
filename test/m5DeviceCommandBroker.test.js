const assert = require("node:assert/strict");
const test = require("node:test");

const M5DeviceCommandBroker = require("../src/helpers/m5DeviceCommandBroker");

test("device command broker returns ordered commands after a cursor", async () => {
  const broker = new M5DeviceCommandBroker({ now: () => 42 });
  const start = broker.enqueue("stick-a", {
    action: "start",
    session_id: "session-a",
  });
  const stop = broker.enqueue("stick-a", {
    action: "stop",
    session_id: "session-a",
  });

  assert.equal((await broker.poll("stick-a", 0, 0)).command_id, start.command_id);
  assert.equal((await broker.poll("stick-a", start.cursor, 0)).command_id, stop.command_id);
  assert.equal(await broker.poll("stick-a", stop.cursor, 0), null);
});

test("device command broker wakes a pending poll and records acknowledgements", async () => {
  const broker = new M5DeviceCommandBroker();
  const pending = broker.poll("stick-a", 0, 1000);
  const command = broker.enqueue("stick-a", {
    action: "start",
    session_id: "session-a",
  });

  assert.equal((await pending).command_id, command.command_id);
  const acknowledgement = broker.acknowledge("stick-a", {
    command_id: command.command_id,
    session_id: "session-a",
    status: "started",
  });
  assert.deepEqual({
    ...acknowledgement,
    acknowledged_at: 0,
  }, {
    command_id: command.command_id,
    device_id: "stick-a",
    status: "started",
    session_id: "session-a",
    error: "",
    acknowledged_at: 0,
  });
  assert.equal(Number.isFinite(acknowledgement.acknowledged_at), true);
});

test("device command broker rebases after a device retained cursor outlives bridge restart", async () => {
  const broker = new M5DeviceCommandBroker();
  const command = broker.enqueue("cardputer", {
    type: "recording_start",
    session_id: "session-after-restart",
  });

  const delivered = await broker.poll("cardputer", 220, 0);
  assert.equal(delivered.command_id, command.command_id);
  assert.equal(delivered.cursor, 221);
  assert.equal(broker.latestCursor("cardputer"), 221);
});

test("device command broker waits for completion acknowledgements", async () => {
  const broker = new M5DeviceCommandBroker();
  const command = broker.enqueue("stick-c", { type: "recording_stop" });
  const waiting = broker.waitForAcknowledgement("stick-c", command.command_id, 100);
  broker.acknowledge("stick-c", {
    command_id: command.command_id,
    status: "completed",
  });
  assert.equal((await waiting).status, "completed");
  assert.equal(broker.commandAfter("stick-c", 0), null);
});
