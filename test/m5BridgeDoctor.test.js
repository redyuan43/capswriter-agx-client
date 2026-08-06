const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const doctorPath = path.resolve(__dirname, "../scripts/m5bridge-doctor.py");

function runPython(body) {
  const script = `
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location("m5bridge_doctor", sys.argv[1])
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)
${body}
`;
  const result = spawnSync("python3", ["-c", script, doctorPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("doctor authenticates bridge diagnostics with the runtime token", () => {
  const result = runPython(`
class Response:
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self, *args):
        return b'{"bluetooth":{"target_mac":"C8:85:41:68:39:0A","audio_status":"failed"}}'

captured = {}
doctor.os.environ["M5_VOICE_BRIDGE_TOKEN"] = "runtime-secret"
doctor.urllib.request.urlopen = lambda request, timeout: (
    captured.update({"headers": dict(request.header_items()), "timeout": timeout}) or Response())
value = doctor.bridge_state("http://127.0.0.1:8765/state")
print(json.dumps({"value": value, "captured": captured}))
`);
  const tokenHeader = Object.entries(result.captured.headers).find(
    ([name]) => name.toLowerCase() === "x-vibe-stick-token"
  );
  assert.equal(tokenHeader?.[1], "runtime-secret");
  assert.equal(result.captured.timeout, 3);
  assert.equal(result.value.available, true);
  assert.equal(result.value.state.bluetooth.audio_status, "failed");
});

test("doctor accepts bluetoothctl existing-agent readiness responses", () => {
  const result = runPython(`
print(json.dumps({
    "registered": doctor.bluetooth_agent_registered("Agent registered"),
    "already_registered": doctor.bluetooth_agent_registered("Agent is already registered"),
    "registration_enabled": doctor.bluetooth_agent_registered("Agent registration enabled"),
    "registration_failed": doctor.bluetooth_agent_registered("Agent registration failed"),
}))
`);
  assert.deepEqual(result, {
    registered: true,
    already_registered: true,
    registration_enabled: true,
    registration_failed: false,
  });
});

test("doctor classifies residual PipeWire nodes by recent capture health", () => {
  const result = runPython(`
m5 = {"ok": True}
bluez = {"known": True, "paired": True, "bonded": True, "connected": True}
source = {"enumerated": True, "available": True}
def bridge(status):
    return {"available": True, "state": {"bluetooth": {
        "target_mac": "14:08:08:52:F9:62", "audio_status": status}}}
print(json.dumps({
    "unknown": doctor.diagnostic_stage(m5, bluez, source, bridge("unknown"), "14:08:08:52:F9:62"),
    "failed": doctor.diagnostic_stage(m5, bluez, source, bridge("failed"), "14:08:08:52:F9:62"),
    "healthy": doctor.diagnostic_stage(m5, bluez, source, bridge("healthy"), "14:08:08:52:F9:62"),
}))
`);
  assert.deepEqual(result, {
    unknown: "audio_unverified",
    failed: "audio_capture_failed",
    healthy: "ready",
  });
});

test("doctor reconnects a stale audio stack once and then observes cooldown", () => {
  const result = runPython(`
before = {
    "ok": False, "stage": "audio_capture_failed", "m5": {"ok": True, "paired": True},
    "bluez": {"known": True, "paired": True, "bonded": True, "connected": True},
    "pipewire": {"available": True}, "audio_status": "failed",
}
after = dict(before)
diagnoses = [before, after]
doctor.diagnose = lambda *args: diagnoses.pop(0)
calls = []
doctor.recover_audio_stack_with_bluez = lambda mac, allowed: calls.append([mac, allowed]) or {
    "ok": True, "audio_stack": {"ok": True}, "bluetooth": None,
    "bluez": {"connected": True}, "pipewire": {"available": True},
}
doctor.time.sleep = lambda _seconds: None
first = doctor.repair("serial", "14:08:08:52:F9:62", "bridge", False,
                      previous={}, cooldown_seconds=60, now_epoch=100)

diagnoses[:] = [before, after]
doctor.recover_audio_stack_with_bluez = lambda mac, allowed: (_ for _ in ()).throw(
    RuntimeError("must not recover"))
second = doctor.repair("serial", "14:08:08:52:F9:62", "bridge", False,
                       previous=first, cooldown_seconds=60, now_epoch=110)
print(json.dumps({"first": first["recovery"], "second": second["recovery"], "calls": calls}))
`);
  assert.equal(result.first.action, "audio_stack_restart_and_bluetooth_reconnect");
  assert.equal(result.first.attempted, true);
  assert.equal(result.first.pending_audio_verification, true);
  assert.deepEqual(result.calls, [["14:08:08:52:F9:62", false]]);
  assert.equal(result.second.attempted, false);
  assert.equal(result.second.reason, "cooldown");
  assert.equal(result.second.cooldown_remaining_seconds, 50);
});

test("doctor audio-only recovery does not require or modify M5 serial pairing", () => {
  const result = runPython(`
before = {"ok": False, "stage": "audio_capture_failed", "audio_status": "failed"}
after = {"ok": False, "stage": "audio_unverified", "audio_status": "unknown"}
diagnoses = [before, after]
doctor.audio_only_diagnose = lambda *args: diagnoses.pop(0)
doctor.m5ctl = lambda *args: (_ for _ in ()).throw(RuntimeError("must not access serial"))
doctor.bluetooth_pair = lambda *args: (_ for _ in ()).throw(RuntimeError("must not pair"))
doctor.recover_audio_stack_with_bluez = lambda mac, allowed: {
    "ok": True, "audio_stack": {"ok": True}, "bluetooth": None,
    "bluez": {"connected": True}, "pipewire": {"available": True},
}
doctor.time.sleep = lambda _seconds: None
value = doctor.repair_audio_only("14:08:08:52:F9:62", "bridge", now_epoch=100)
print(json.dumps(value))
`);
  assert.equal(result.audio_only, true);
  assert.equal(result.recovery.attempted, true);
  assert.equal(result.recovery.pending_audio_verification, true);
  assert.equal(result.recovery.action, "audio_stack_restart_and_bluetooth_reconnect");
});

test("doctor can reconnect Bluetooth audio without restarting the host audio stack", () => {
  const result = runPython(`
before = {"ok": False, "stage": "audio_capture_failed", "audio_status": "failed"}
after = {"ok": True, "stage": "ready", "audio_status": "healthy"}
diagnoses = [before, after]
doctor.audio_only_diagnose = lambda *args: diagnoses.pop(0)
calls = []
doctor.reconnect_audio_transport = lambda mac: calls.append(mac) or {
    "ok": True,
    "bluez": {"connected": True},
    "pipewire": {"available": True},
}
doctor.recover_audio_stack_with_bluez = lambda *_args: (_ for _ in ()).throw(
    AssertionError("full audio stack restart must not run"))
value = doctor.repair_audio_only(
    "14:08:08:52:F9:62", "bridge", now_epoch=100, reconnect_only=True)
print(json.dumps({"value": value, "calls": calls}))
`);
  assert.equal(result.value.ok, true);
  assert.equal(result.value.recovery.action, "bluetooth_reconnect");
  assert.deepEqual(result.calls, ["14:08:08:52:F9:62"]);
});

test("doctor cycles Bluetooth before rebuilding a stale PipeWire route", () => {
  const result = runPython(`
calls = []
doctor.disconnect_bluetooth = lambda mac: calls.append(["disconnect", mac]) or {"ok": True}
doctor.restart_audio_stack = lambda: calls.append("restart") or {"ok": True}
doctor.wait_for_pipewire_source = lambda mac, timeout: calls.append(["source", timeout]) or {
    "available": True, "enumerated": True, "state": "SUSPENDED",
}
doctor.connect_bluetooth = lambda mac, **kwargs: calls.append(
    ["connect", mac, kwargs.get("always_attempt")]) or {"ok": True}
doctor.bluez_info = lambda mac: {"connected": True}
value = doctor.recover_audio_stack("14:08:08:52:F9:62")
print(json.dumps({"value": value, "calls": calls}))
`);
  assert.equal(result.value.ok, true);
  assert.deepEqual(result.calls, [
    ["disconnect", "14:08:08:52:F9:62"],
    "restart",
    ["connect", "14:08:08:52:F9:62", true],
    ["source", 15],
  ]);
});

test("doctor reports a missing route after a failed reconnect", () => {
  const result = runPython(`
calls = []
doctor.disconnect_bluetooth = lambda mac: {"ok": True}
doctor.restart_audio_stack = lambda: {"ok": True}
doctor.connect_bluetooth = lambda mac, **kwargs: calls.append(
    ["connect", mac, kwargs.get("always_attempt")]) or {"ok": False}
doctor.wait_for_pipewire_source = lambda *args, **kwargs: (_ for _ in ()).throw(
    RuntimeError("must not accept a stale source after connect fails"))
doctor.bluez_info = lambda mac: {"connected": False}
value = doctor.recover_audio_stack("14:08:08:52:F9:62")
print(json.dumps({"value": value, "calls": calls}))
`);
  assert.equal(result.value.ok, false);
  assert.equal(result.value.pipewire.state, "MISSING");
  assert.deepEqual(result.calls, [
    ["connect", "14:08:08:52:F9:62", true],
  ]);
});

test("doctor escalates to the restricted BlueZ helper only after ordinary recovery fails", () => {
  const result = runPython(`
recoveries = [
    {"ok": False, "audio_stack": {"ok": True}},
    {"ok": True, "audio_stack": {"ok": True}},
]
calls = []
doctor.recover_audio_stack = lambda mac: calls.append(["audio", mac]) or recoveries.pop(0)
doctor.run = lambda *args, **kwargs: calls.append(list(args)) or {"ok": True}
doctor.time.sleep = lambda seconds: calls.append(["sleep", seconds])
value = doctor.recover_audio_stack_with_bluez("14:08:08:52:F9:62", True)
print(json.dumps({"value": value, "calls": calls}))
`);
  assert.equal(result.value.ok, true);
  assert.equal(result.value.bluez_recovery.ok, true);
  assert.deepEqual(result.calls, [
    ["audio", "14:08:08:52:F9:62"],
    ["pkexec", "/usr/libexec/capswriter-m5-recover-bluetooth"],
    ["sleep", 2],
    ["audio", "14:08:08:52:F9:62"],
  ]);
});

test("doctor retries Bluetooth connect after a locally aborted attempt", () => {
  const result = runPython(`
states = [{"connected": False}]
waits = [{"connected": False}, {"connected": True}]
commands = []
results = [{"ok": False}, {"ok": True}, {"ok": True}]
doctor.bluez_info = lambda mac: states.pop(0)
doctor.wait_for_bluez_connection = lambda mac, connected, timeout: waits.pop(0)
doctor.run = lambda *args, **kwargs: commands.append(list(args)) or results.pop(0)
doctor.time.sleep = lambda _seconds: None
value = doctor.connect_bluetooth("14:08:08:52:F9:62", attempts=3)
print(json.dumps({"value": value, "commands": commands}))
`);
  assert.equal(result.value.ok, true);
  assert.equal(result.value.commands.length, 2);
  assert.equal(result.value.audio_profile.profile, "headset-head-unit-msbc");
  assert.equal(result.commands.length, 3);
  assert.deepEqual(result.commands[2], [
    "pactl",
    "set-card-profile",
    "bluez_card.14_08_08_52_F9_62",
    "headset-head-unit-msbc",
  ]);
});

test("doctor reads the target source state from pactl JSON", () => {
  const result = runPython(`
payload = [{
    "name": "bluez_input.14_08_08_52_F9_62.0",
    "state": "SUSPENDED",
    "properties": {"api.bluez5.address": "14:08:08:52:F9:62"},
}]
doctor.run = lambda *args, **kwargs: {"ok": True, "stdout": json.dumps(payload), "stderr": ""}
print(json.dumps(doctor.pipewire_source("14:08:08:52:F9:62")))
`);
  assert.equal(result.enumerated, true);
  assert.equal(result.available, true);
  assert.equal(result.state, "SUSPENDED");
  assert.equal(result.node_name, "bluez_input.14_08_08_52_F9_62.0");
});

test("doctor rejects a residual PipeWire node when its owning card profile is off", () => {
  const result = runPython(`
sources = [{
    "name": "bluez_input.14_08_08_52_F9_62.0",
    "state": "SUSPENDED",
    "properties": {
      "api.bluez5.address": "14:08:08:52:F9:62",
    },
}]
cards = [{"name": "bluez_card.14_08_08_52_F9_62", "active_profile": "off"}]
doctor.run = lambda *args, **kwargs: {"ok": True, "stdout": json.dumps(cards if "cards" in args else sources), "stderr": ""}
print(json.dumps(doctor.pipewire_source("14:08:08:52:F9:62")))
`);
  assert.equal(result.enumerated, true);
  assert.equal(result.available, false);
  assert.equal(result.card_profile, "off");
});

test("doctor keeps only the bridge audio summary to prevent recursive state growth", () => {
  const result = runPython(`
class Response:
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return None
    def read(self):
        return json.dumps({
            "ble": True,
            "recording": {"status": "idle"},
            "bluetooth": {
                "target_mac": "14:08:08:52:F9:62",
                "stage": "ready",
                "ready": True,
                "audio_status": "healthy",
                "last_diagnostic": {"bridge": {"state": {"bluetooth": {}}}},
            },
        }).encode()
doctor.urllib.request.urlopen = lambda *_args, **_kwargs: Response()
print(json.dumps(doctor.bridge_state("http://127.0.0.1:8765/state")))
`);
  assert.deepEqual(result, {
    available: true,
    state: {
      ble: true,
      bluetooth: {
        target_mac: "14:08:08:52:F9:62",
        stage: "ready",
        ready: true,
        audio_status: "healthy",
      },
    },
  });
  assert.equal(JSON.stringify(result).includes("last_diagnostic"), false);
});
