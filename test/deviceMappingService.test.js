const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DeviceMappingService,
  defaultProfile,
  normalizeProfile,
} = require("../src/helpers/deviceMappingService");

function database() {
  const values = new Map();
  return {
    getSetting: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    setSetting: (key, value) => values.set(key, value),
  };
}

test("default Cardputer profile preserves current input behavior", () => {
  const profile = defaultProfile();
  assert.equal(profile.controls["cardputer.pointer.primary"].button, "left");
  assert.equal(profile.controls["cardputer.pointer.secondary"].button, "right");
  assert.equal(profile.controls["cardputer.opt.tap"].type, "device.recording.toggle");
  assert.equal(profile.air_mouse.pointer_deadzone_dps, 2.5);
  assert.equal(profile.air_mouse.wheel_deadzone_dps, 5);
});

test("profile normalization rejects out of range tuning", () => {
  const profile = normalizeProfile({
    air_mouse: { pointer_speed: 99, wheel_speed: -1 },
  });
  assert.equal(profile.air_mouse.pointer_speed, 1);
  assert.equal(profile.air_mouse.wheel_speed, 1);
});

test("pointer controls can map to different native mouse buttons", async () => {
  const db = database();
  const service = new DeviceMappingService({ databaseManager: db, now: () => 1000 });
  const profile = service.getProfile();
  profile.controls["cardputer.pointer.primary"] = { type: "pointer.button", button: "middle" };
  service.saveProfile(profile.device_id, profile);
  const output = await service.transformPointerReport(profile.device_id, {
    dx: 4, dy: -3, wheel: 0, buttons: 1,
  });
  assert.deepEqual(output, { dx: 4, dy: -3, wheel: 0, buttons: 4 });
});

test("saving and applying queues a versioned device profile", () => {
  const commands = [];
  const service = new DeviceMappingService({
    databaseManager: database(),
    commandBroker: { enqueue: (_id, command) => {
      commands.push(command);
      return { ...command, command_id: "profile-command" };
    } },
  });
  const result = service.applyProfile("28:84:85:76:25:c0", service.getProfile());
  assert.equal(result.sync.status, "pending");
  assert.equal(commands[0].type, "input_profile_update");
  assert.equal(commands[0].payload.profile_revision, result.profile.revision);
});

test("host semantic controls dispatch through the action executor", async () => {
  const service = new DeviceMappingService({ databaseManager: database() });
  const profile = service.getProfile();
  profile.controls["cardputer.opt.tap"] = { type: "capswriter.confirm" };
  service.saveProfile(profile.device_id, profile);
  const calls = [];
  service.setActionExecutor((action, phase) => {
    calls.push([action.type, phase]);
    return { handled: true };
  });
  const result = await service.handleInputEvent(
    { board: "cardputer_adv", device_id: profile.device_id },
    { protocol_version: 1, session_id: "boot-1", sequence: 1,
      control: "cardputer.opt.tap", phase: "trigger" }
  );
  assert.equal(result.handled, true);
  assert.deepEqual(calls, [["capswriter.confirm", "trigger"]]);
});
