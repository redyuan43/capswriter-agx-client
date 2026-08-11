const assert = require("node:assert/strict");
const test = require("node:test");

const CardputerPointerBridge = require("../src/helpers/cardputerPointerBridge");

class FakeBackend {
  constructor() {
    this.reports = [];
    this.releaseCount = 0;
    this.stopped = false;
  }

  async report(report) {
    this.reports.push({ ...report });
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
    dx: 0,
    dy: 0,
    wheel: 0,
    buttons: 0,
    ...overrides,
  };
}

function createBridge(options = {}) {
  const backend = new FakeBackend();
  const bridge = new CardputerPointerBridge({
    backend,
    allowedDeviceIds: DEVICE.device_id,
    ...options,
  });
  return { bridge, backend };
}

test("forwards pointer motion, wheel, and both button bits", async (t) => {
  const { bridge, backend } = createBridge();
  t.after(() => bridge.stop());

  await bridge.handleReport(DEVICE, report(1, {
    dx: -17,
    dy: 23,
    wheel: -1,
    buttons: 3,
  }));

  assert.deepEqual(backend.reports, [{ dx: -17, dy: 23, wheel: -1, buttons: 3 }]);
});

test("deduplicates reports and releases buttons when a new session starts", async (t) => {
  const { bridge, backend } = createBridge();
  t.after(() => bridge.stop());

  await bridge.handleReport(DEVICE, report(4, { buttons: 1 }));
  const duplicate = await bridge.handleReport(DEVICE, report(4, { dx: 100 }));
  await bridge.handleReport(DEVICE, report(0, {
    session_id: "boot-b",
    buttons: 0,
  }));

  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(backend.reports, [
    { dx: 0, dy: 0, wheel: 0, buttons: 1 },
    { dx: 0, dy: 0, wheel: 0, buttons: 0 },
  ]);
  assert.equal(backend.releaseCount, 1);
});

test("rejects unapproved devices and out-of-range reports", async (t) => {
  const { bridge } = createBridge();
  t.after(() => bridge.stop());

  await assert.rejects(
    bridge.handleReport({ ...DEVICE, device_id: "ac:27:6e:d2:80:e0" }, report(1)),
    (error) => error.statusCode === 403
  );
  await assert.rejects(
    bridge.handleReport(DEVICE, report(1, { dx: 2049 })),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    bridge.handleReport(DEVICE, report(1, { buttons: 4 })),
    (error) => error.statusCode === 400
  );
});

test("watchdog releases held pointer buttons after heartbeats stop", async (t) => {
  let now = 1000;
  const { bridge, backend } = createBridge({ now: () => now });
  t.after(() => bridge.stop());

  await bridge.handleReport(DEVICE, report(1, { buttons: 1 }));
  now += 751;
  await bridge._releaseExpired();

  assert.equal(backend.releaseCount, 1);
  assert.equal(bridge.state.buttons, 0);
});

test("pointer allowlist uses the shared input env before the keyboard fallback", (t) => {
  const previousInput = process.env.M5_CARDPUTER_INPUT_DEVICE_IDS;
  const previousKeyboard = process.env.M5_CARDPUTER_KEYBOARD_DEVICE_IDS;
  process.env.M5_CARDPUTER_INPUT_DEVICE_IDS = "aa:bb";
  process.env.M5_CARDPUTER_KEYBOARD_DEVICE_IDS = "cc:dd";
  t.after(() => {
    if (previousInput === undefined) delete process.env.M5_CARDPUTER_INPUT_DEVICE_IDS;
    else process.env.M5_CARDPUTER_INPUT_DEVICE_IDS = previousInput;
    if (previousKeyboard === undefined) delete process.env.M5_CARDPUTER_KEYBOARD_DEVICE_IDS;
    else process.env.M5_CARDPUTER_KEYBOARD_DEVICE_IDS = previousKeyboard;
  });

  const bridge = new CardputerPointerBridge({ backend: new FakeBackend() });
  t.after(() => bridge.stop());
  assert.deepEqual([...bridge.allowedDeviceIds], ["aa:bb"]);
});
