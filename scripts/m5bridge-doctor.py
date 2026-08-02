#!/usr/bin/env python3
"""Diagnose and repair the local M5StickC Plus SE Bluetooth route.

This tool deliberately uses BlueZ's public bluetoothctl interface.  It does
not create raw HCI links, because raw links bypass the state that PipeWire and
CapsWriter need to observe.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import select
import subprocess
import sys
import termios
import time
import urllib.request

DEFAULT_MAC = "14:08:08:52:F9:62"
DEFAULT_BRIDGE = "http://127.0.0.1:8765/state"
SERIAL_GLOB = "/dev/serial/by-id/usb-Hades2001_M5stack_*-if00-port0"
DEFAULT_STATE_FILE = os.path.join(os.path.expanduser("~"), ".cache",
                                  "capswriter-agx-client", "m5bridge-doctor.json")
RECOVERY_HELPER = "/usr/libexec/capswriter-m5-recover-bluetooth"


def run(*args: str, timeout: int = 20) -> dict:
    try:
        result = subprocess.run(args, text=True, capture_output=True,
                                timeout=timeout, check=False)
        return {"ok": result.returncode == 0, "code": result.returncode,
                "stdout": result.stdout, "stderr": result.stderr}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"ok": False, "code": None, "stdout": "", "stderr": str(error)}


def bool_property(output: str, name: str) -> bool:
    return f"{name}: yes" in output.lower()


def serial_port(value: str | None) -> str:
    if value:
        return value
    candidates = sorted(glob.glob(SERIAL_GLOB))
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise RuntimeError("未找到 M5 USB 串口；请使用 --port 指定设备")
    raise RuntimeError("发现多个 M5 USB 串口；请使用 --port 指定目标")


def m5ctl(port: str, command: str, timeout: float = 8.0) -> dict:
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        old = termios.tcgetattr(fd)
        attrs = termios.tcgetattr(fd)
        attrs[0] = 0
        attrs[1] = 0
        attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        attrs[3] = 0
        attrs[4] = termios.B115200
        attrs[5] = termios.B115200
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        termios.tcflush(fd, termios.TCIFLUSH)
        buffer = b""
        for _ in range(2):
            # Opening the USB-UART can reset an M5. Retry on the same open file
            # descriptor so the second command arrives after the boot sequence.
            command_bytes = f"M5CTL {command}\n".encode("ascii")
            written = 0
            write_deadline = time.monotonic() + 1.0
            while written < len(command_bytes):
                _, writable, _ = select.select([], [fd], [], 0.1)
                if writable:
                    written += os.write(fd, command_bytes[written:])
                elif time.monotonic() >= write_deadline:
                    return {"ok": False, "error": "m5ctl_write_timeout"}
            deadline = time.monotonic() + timeout / 2
            while time.monotonic() < deadline:
                readable, _, _ = select.select([fd], [], [], 0.1)
                if not readable:
                    continue
                buffer += os.read(fd, 512)
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    text = raw.decode("utf-8", "replace").strip()
                    if not text.startswith("M5CTL "):
                        continue
                    payload = text.removeprefix("M5CTL ")
                    try:
                        return json.loads(payload)
                    except json.JSONDecodeError:
                        return {"ok": False, "error": "invalid_m5ctl_reply", "reply": payload}
        return {"ok": False, "error": "m5ctl_timeout"}
    finally:
        try:
            termios.tcsetattr(fd, termios.TCSANOW, old)
        except UnboundLocalError:
            pass
        os.close(fd)


def bluez_info(mac: str) -> dict:
    result = run("bluetoothctl", "info", mac)
    output = result["stdout"]
    return {
        "known": "not available" not in output.lower(),
        "paired": bool_property(output, "paired"),
        "bonded": bool_property(output, "bonded"),
        "connected": bool_property(output, "connected"),
        "trusted": bool_property(output, "trusted"),
        "raw": output.strip() or result["stderr"].strip(),
    }


def pipewire_source(mac: str) -> dict:
    result = run("pactl", "-f", "json", "list", "sources")
    normalized = mac.replace(":", "").replace("_", "").lower()
    try:
        sources = json.loads(result["stdout"] or "[]")
    except json.JSONDecodeError:
        sources = []
    for source in sources:
        properties = source.get("properties") or {}
        node_name = str(source.get("name") or properties.get("node.name") or "")
        address = str(properties.get("api.bluez5.address") or "")
        identity = (address or node_name).replace(":", "").replace("_", "").lower()
        if normalized not in identity:
            continue
        state = str(source.get("state") or "UNKNOWN").upper()
        return {
            "enumerated": True,
            "available": state != "UNAVAILABLE",
            "node_name": node_name,
            "state": state,
            "raw": source,
        }
    return {"enumerated": False, "available": False, "node_name": "",
            "state": "MISSING", "raw": result["stderr"].strip()}


def bridge_state(url: str) -> dict:
    try:
        token = os.environ.get("M5_VOICE_BRIDGE_TOKEN") or \
            os.environ.get("VIBE_STICK_BRIDGE_TOKEN")
        headers = {"X-Vibe-Stick-Token": token} if token else {}
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=3) as response:
            state = json.load(response)
            bluetooth = state.get("bluetooth") or {}
            return {
                "available": True,
                "state": {
                    "ble": bool(state.get("ble")),
                    "bluetooth": {
                        "target_mac": bluetooth.get("target_mac", ""),
                        "stage": bluetooth.get("stage", ""),
                        "ready": bool(bluetooth.get("ready")),
                        "audio_status": bluetooth.get("audio_status", "unknown"),
                    },
                },
            }
    except Exception as error:  # noqa: BLE001 - return diagnostics to caller
        return {"available": False, "error": str(error)}


def bridge_audio_status(bridge_result: dict, mac: str) -> str:
    state = bridge_result.get("state") or {}
    bluetooth = state.get("bluetooth") or {}
    target = str(bluetooth.get("target_mac") or "").replace(":", "").lower()
    normalized = mac.replace(":", "").lower()
    if not target or target == normalized:
        status = str(bluetooth.get("audio_status") or "").lower()
        if status in {"healthy", "failed", "unknown", "unavailable"}:
            return status
    return "unknown"


def diagnostic_stage(m5: dict, bluez: dict, source: dict,
                     bridge_result: dict, mac: str) -> str:
    if not m5.get("ok"):
        return "serial"
    if not bluez["known"]:
        return "bluez_discovery"
    if not bluez["paired"] or not bluez["bonded"]:
        return "bluez_bond"
    if not bluez["connected"]:
        return "hid_hfp"
    if not source["available"]:
        return "pipewire_source_missing"
    if not bridge_result.get("available"):
        return "bridge"
    audio_status = bridge_audio_status(bridge_result, mac)
    if audio_status == "healthy":
        return "ready"
    if audio_status == "failed":
        return "audio_capture_failed"
    return "audio_unverified"


def diagnose(port: str, mac: str, bridge: str) -> dict:
    m5 = m5ctl(port, "STATUS")
    bluez = bluez_info(mac)
    source = pipewire_source(mac)
    bridge_result = bridge_state(bridge)
    stage = diagnostic_stage(m5, bluez, source, bridge_result, mac)
    return {"ok": stage == "ready", "stage": stage, "m5": m5,
            "bluez": bluez, "pipewire": source,
            "bridge": bridge_result,
            "audio_status": bridge_audio_status(bridge_result, mac)}


def bluetooth_pair(mac: str) -> dict:
    """Pair in one persistent bluetoothctl session.

    BlueZ sends numeric-confirmation and service-authorization prompts back to
    the agent that started Pair().  Separate one-shot bluetoothctl commands
    cannot answer those prompts, which leaves the device discovered but not
    paired.  Keep the agent alive until HFP and HID authorization complete.
    """
    transcript: list[str] = []
    try:
        process = subprocess.Popen(
            ["bluetoothctl"], text=True, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=1,
        )
    except OSError as error:
        return {"pair": {"ok": False, "error": str(error)}, "state": bluez_info(mac)}

    def send(command: str) -> None:
        if process.stdin and process.poll() is None:
            process.stdin.write(command + "\n")
            process.stdin.flush()

    send("agent on")
    send("default-agent")
    send("power on")
    send("scan on")
    send(f"pair {mac}")
    deadline = time.monotonic() + 45
    paired = False
    try:
        while time.monotonic() < deadline and process.poll() is None:
            readable, _, _ = select.select([process.stdout], [], [], 0.25)
            if not readable:
                continue
            line = process.stdout.readline()
            if not line:
                continue
            transcript.append(line.rstrip())
            lower = line.lower()
            if "confirm passkey" in lower or "authorize service" in lower:
                send("yes")
            if "pairing successful" in lower or "paired: yes" in lower:
                paired = True
                send(f"trust {mac}")
                send(f"connect {mac}")
            if paired and ("connection successful" in lower or "connected: yes" in lower):
                break
    finally:
        send("scan off")
        send("quit")
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=3)
    state = bluez_info(mac)
    pair = {"ok": state["paired"] and state["bonded"], "transcript": transcript[-80:]}
    if not pair["ok"]:
        pair["error"] = "bluez_device_not_paired"
    return {"pair": pair, "state": state}


def wait_for_bluez_connection(mac: str, connected: bool,
                              timeout: float = 8.0) -> dict:
    deadline = time.monotonic() + timeout
    state = bluez_info(mac)
    while state["connected"] != connected and time.monotonic() < deadline:
        time.sleep(0.5)
        state = bluez_info(mac)
    return state


def wait_for_pipewire_source(mac: str, timeout: float = 8.0) -> dict:
    deadline = time.monotonic() + timeout
    source = pipewire_source(mac)
    while not source["available"] and time.monotonic() < deadline:
        time.sleep(0.5)
        source = pipewire_source(mac)
    return source


def connect_bluetooth(mac: str, attempts: int = 3,
                      always_attempt: bool = False) -> dict:
    commands = []
    state = bluez_info(mac)
    for _ in range(max(1, attempts)):
        if state["connected"] and not always_attempt:
            return {"ok": True, "commands": commands, "state": state}
        command = run("bluetoothctl", "connect", mac)
        commands.append(command)
        state = wait_for_bluez_connection(mac, True, timeout=6)
        if command["ok"] and state["connected"]:
            return {"ok": True, "commands": commands, "state": state}
        always_attempt = True
        time.sleep(1)
    return {"ok": False, "commands": commands, "state": state}


def disconnect_bluetooth(mac: str) -> dict:
    state = bluez_info(mac)
    if not state["connected"]:
        return {"ok": True, "command": None, "state": state}
    command = run("bluetoothctl", "disconnect", mac)
    state = wait_for_bluez_connection(mac, False, timeout=8)
    return {
        "ok": command["ok"] and not state["connected"],
        "command": command,
        "state": state,
    }


def restart_audio_stack() -> dict:
    return run(
        "systemctl", "--user", "restart",
        "pipewire.service", "pipewire-pulse.service", "wireplumber.service",
        timeout=30,
    )


def recover_audio_stack(mac: str) -> dict:
    disconnect = disconnect_bluetooth(mac)
    audio_stack = restart_audio_stack()
    bluetooth = connect_bluetooth(mac, always_attempt=True) if audio_stack["ok"] else None
    source = wait_for_pipewire_source(mac, timeout=15) if bluetooth and bluetooth["ok"] else {
        "available": False, "enumerated": False, "state": "MISSING",
    }
    state = bluez_info(mac)
    ok = audio_stack["ok"] and state["connected"] and source["available"]
    return {
        "ok": ok,
        "disconnect": disconnect,
        "audio_stack": audio_stack,
        "bluetooth": bluetooth,
        "bluez": state,
        "pipewire": source,
    }


def reconnect_audio_transport(mac: str) -> dict:
    disconnect = disconnect_bluetooth(mac)
    bluetooth = connect_bluetooth(mac, always_attempt=True)
    source = wait_for_pipewire_source(mac, timeout=15) if bluetooth["ok"] else {
        "available": False, "enumerated": False, "state": "MISSING",
    }
    state = bluez_info(mac)
    return {
        "ok": state["connected"] and source["available"],
        "disconnect": disconnect,
        "bluetooth": bluetooth,
        "bluez": state,
        "pipewire": source,
    }


def recover_audio_stack_with_bluez(mac: str, recover_bluez: bool) -> dict:
    initial = recover_audio_stack(mac)
    if initial["ok"] or not recover_bluez:
        return {**initial, "bluez_recovery": None}
    bluez_recovery = run("pkexec", RECOVERY_HELPER, timeout=30)
    if not bluez_recovery["ok"]:
        return {**initial, "bluez_recovery": bluez_recovery}
    time.sleep(2)
    recovered = recover_audio_stack(mac)
    return {
        **recovered,
        "initial_recovery": initial,
        "bluez_recovery": bluez_recovery,
    }


def load_previous_state(state_file: str) -> dict:
    try:
        with open(state_file, encoding="utf-8") as handle:
            value = json.load(handle)
            return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def recovery_cooldown(previous: dict, now_epoch: float, cooldown_seconds: int) -> int:
    recovery = previous.get("recovery") or {}
    attempted_at = float(recovery.get("attempted_at_epoch") or 0)
    if not recovery.get("attempted") or attempted_at <= 0:
        return 0
    return max(0, int(attempted_at + cooldown_seconds - now_epoch))


def audio_only_diagnose(mac: str, bridge: str) -> dict:
    bluez = bluez_info(mac)
    source = pipewire_source(mac)
    bridge_result = bridge_state(bridge)
    if not bluez["known"]:
        stage = "bluez_discovery"
    elif not bluez["paired"] or not bluez["bonded"]:
        stage = "bluez_bond"
    elif not bluez["connected"]:
        stage = "hid_hfp"
    elif not source["available"]:
        stage = "pipewire_source_missing"
    elif not bridge_result.get("available"):
        stage = "bridge"
    else:
        status = bridge_audio_status(bridge_result, mac)
        stage = {"healthy": "ready", "failed": "audio_capture_failed"}.get(
            status, "audio_unverified")
    return {
        "ok": stage == "ready",
        "stage": stage,
        "bluez": bluez,
        "pipewire": source,
        "bridge": bridge_result,
        "audio_status": bridge_audio_status(bridge_result, mac),
    }


def repair_audio_only(mac: str, bridge: str, previous: dict | None = None,
                      cooldown_seconds: int = 60,
                      now_epoch: float | None = None,
                      recover_bluez: bool = False,
                      reconnect_only: bool = False) -> dict:
    now_epoch = time.time() if now_epoch is None else now_epoch
    before = audio_only_diagnose(mac, bridge)
    recovery = None
    if before["stage"] == "hid_hfp":
        connected = connect_bluetooth(mac)
        recovery = {
            "attempted": True,
            "attempted_at_epoch": now_epoch,
            "action": "connect",
            "ok": connected["ok"],
            "result": connected,
        }
    elif before["stage"] in {"pipewire_source_missing", "audio_capture_failed"}:
        remaining = recovery_cooldown(previous or {}, now_epoch, cooldown_seconds)
        if remaining:
            recovery = {
                "attempted": False,
                "action": "audio_stack_restart_and_bluetooth_reconnect",
                "reason": "cooldown",
                "cooldown_remaining_seconds": remaining,
            }
        else:
            recovered = reconnect_audio_transport(mac) if reconnect_only else (
                recover_audio_stack_with_bluez(mac, recover_bluez)
            )
            recovery = {
                "attempted": True,
                "attempted_at_epoch": now_epoch,
                "action": "bluetooth_reconnect" if reconnect_only
                else "audio_stack_restart_and_bluetooth_reconnect",
                "pending_audio_verification": recovered["ok"],
                **recovered,
            }
    after = audio_only_diagnose(mac, bridge)
    return {"ok": after["ok"], "audio_only": True,
            "recovery": recovery, "before": before, "after": after}


def repair(port: str, mac: str, bridge: str, recover_bluez: bool,
           previous: dict | None = None, cooldown_seconds: int = 60,
           now_epoch: float | None = None) -> dict:
    now_epoch = time.time() if now_epoch is None else now_epoch
    previous = previous or {}
    before = diagnose(port, mac, bridge)
    bluez_recovery = None
    recovery = None
    if recover_bluez and before["m5"].get("pairing") and not before["bluez"]["known"]:
        bluez_recovery = run("pkexec", RECOVERY_HELPER, timeout=30)
        if bluez_recovery["ok"]:
            time.sleep(2)
            before = diagnose(port, mac, bridge)
    m5_paired = bool(before["m5"].get("paired"))
    host_paired = before["bluez"]["paired"] and before["bluez"]["bonded"]
    reset = m5_paired != host_paired
    pairing = None
    if reset:
        run("bluetoothctl", "remove", mac)
        response = m5ctl(port, "RESET_PAIRING")
        if not response.get("ok"):
            return {"ok": False, "stage": "m5_reset_pairing", "before": before,
                    "m5_response": response}
        pairing = bluetooth_pair(mac)
    elif not m5_paired:
        response = m5ctl(port, "PAIR 180")
        if not response.get("ok"):
            return {"ok": False, "stage": "m5_pairing", "before": before,
                    "m5_response": response}
        pairing = bluetooth_pair(mac)
    elif not before["bluez"]["connected"]:
        run("bluetoothctl", "trust", mac)
        connected = connect_bluetooth(mac)
        recovery = {
            "attempted": True,
            "attempted_at_epoch": now_epoch,
            "action": "connect",
            "ok": connected["ok"],
            "result": connected,
        }
    elif before["stage"] in {"pipewire_source_missing", "audio_capture_failed"}:
        remaining = recovery_cooldown(previous, now_epoch, cooldown_seconds)
        if remaining:
            recovery = {
                "attempted": False,
                "action": "bluetooth_reconnect",
                "reason": "cooldown",
                "cooldown_remaining_seconds": remaining,
            }
        else:
            recovered = recover_audio_stack_with_bluez(mac, recover_bluez)
            recovery = {
                "attempted": True,
                "attempted_at_epoch": now_epoch,
                "action": "audio_stack_restart_and_bluetooth_reconnect",
                "pending_audio_verification": recovered["ok"],
                **recovered,
            }
    after = diagnose(port, mac, bridge)
    return {"ok": after["ok"], "reset_pairing": reset,
            "bluez_recovery": bluez_recovery,
            "recovery": recovery, "before": before,
            "pairing": pairing, "after": after}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("diagnose", "repair"))
    parser.add_argument("--port")
    parser.add_argument("--mac", default=DEFAULT_MAC)
    parser.add_argument("--bridge", default=DEFAULT_BRIDGE)
    parser.add_argument("--state-file", default=DEFAULT_STATE_FILE)
    parser.add_argument("--recover-bluez", action="store_true",
                        help="BlueZ cannot discover a pairing M5时，调用受限恢复助手")
    parser.add_argument("--audio-only", action="store_true",
                        help="只恢复主机蓝牙音频栈，不访问 M5 串口或修改配对信息")
    parser.add_argument("--reconnect-only", action="store_true",
                        help="只重连蓝牙传输，不重启 PipeWire/WirePlumber")
    parser.add_argument("--recovery-cooldown", type=int, default=60,
                        help="重复音频栈恢复的最短间隔秒数（默认 60）")
    args = parser.parse_args()
    try:
        previous = load_previous_state(args.state_file)
        if args.action == "diagnose":
            port = serial_port(args.port)
            result = diagnose(port, args.mac.upper(), args.bridge)
            if previous.get("recovery"):
                result["recovery"] = previous["recovery"]
        elif args.audio_only:
            result = repair_audio_only(
                args.mac.upper(), args.bridge, previous=previous,
                cooldown_seconds=max(0, args.recovery_cooldown),
                recover_bluez=args.recover_bluez,
                reconnect_only=args.reconnect_only,
            )
        else:
            port = serial_port(args.port)
            result = repair(
                port, args.mac.upper(), args.bridge, args.recover_bluez,
                previous=previous,
                cooldown_seconds=max(0, args.recovery_cooldown),
            )
    except Exception as error:  # noqa: BLE001 - CLI should return structured failures
        result = {"ok": False, "stage": "setup", "error": str(error)}
    try:
        os.makedirs(os.path.dirname(args.state_file), exist_ok=True)
        with open(args.state_file, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, sort_keys=True)
    except OSError as error:
        result.setdefault("warnings", []).append(f"无法写入诊断状态：{error}")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
