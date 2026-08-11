const assert = require("node:assert/strict");
const test = require("node:test");

const CardputerKeyboardBridge = require("../src/helpers/cardputerKeyboardBridge");

class FakeBackend {
  constructor() {
    this.reports = [];
    this.releaseCount = 0;
    this.stopped = false;
  }

  async report(codes) {
    this.reports.push([...codes]);
  }

  async releaseAll() {
    this.releaseCount += 1;
  }

  stop() {
    this.stopped = true;
  }
}

const DEVICE = {
  device_id: "28:84:85:76:25:c0",
  board: "cardputer_adv",
};

function report(sequence, overrides = {}) {
  return {
    protocol_version: 1,
    session_id: "boot-a",
    sequence,
    modifiers: 0,
    keys: [],
    ...overrides,
  };
}

function createBridge(options = {}) {
  const backend = new FakeBackend();
  const bridge = new CardputerKeyboardBridge({
    backend,
    allowedDeviceIds: DEVICE.device_id,
    ...options,
  });
  return { bridge, backend };
}

test("maps official Cardputer HID usages and modifiers to Linux input codes", async (t) => {
  const { bridge, backend } = createBridge();
  t.after(() => bridge.stop());

  await bridge.handleReport(DEVICE, report(1, {
    modifiers: 0x02 | 0x40,
    keys: [0x04, 0x1e, 0x2c],
  }));

  assert.deepEqual(backend.reports, [[42, 100, 30, 2, 57]]);
});

test("ignores duplicate reports and releases state when a new boot session starts", async (t) => {
  const { bridge, backend } = createBridge();
  t.after(() => bridge.stop());

  await bridge.handleReport(DEVICE, report(4, { keys: [0x04] }));
  const duplicate = await bridge.handleReport(DEVICE, report(4, { keys: [0x05] }));
  await bridge.handleReport(DEVICE, report(0, {
    session_id: "boot-b",
    keys: [0x05],
  }));

  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(backend.reports, [[30], [48]]);
  assert.equal(backend.releaseCount, 1);
});

test("rejects unapproved devices and unsupported HID usages", async (t) => {
  const { bridge } = createBridge();
  t.after(() => bridge.stop());

  await assert.rejects(
    bridge.handleReport({ ...DEVICE, device_id: "ac:27:6e:d2:80:e0" }, report(1)),
    (error) => error.statusCode === 403
  );
  await assert.rejects(
    bridge.handleReport(DEVICE, report(1, { keys: [0xff] })),
    (error) => error.statusCode === 400
  );
});

test("watchdog releases held keys after report heartbeats stop", async (t) => {
  let now = 1000;
  const { bridge, backend } = createBridge({ now: () => now });
  t.after(() => bridge.stop());

  await bridge.handleReport(DEVICE, report(1, { keys: [0x04] }));
  now += 751;
  await bridge._releaseExpired();

  assert.equal(backend.releaseCount, 1);
  assert.deepEqual(bridge.state.codes, []);
});
