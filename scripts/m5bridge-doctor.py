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
    result = run("wpctl", "status")
    normalized = mac.replace(":", "_").lower()
    return {"available": normalized in result["stdout"].lower(),
            "raw": result["stdout"] if result["ok"] else result["stderr"]}


def bridge_state(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return {"available": True, "state": json.load(response)}
    except Exception as error:  # noqa: BLE001 - return diagnostics to caller
        return {"available": False, "error": str(error)}


def diagnose(port: str, mac: str, bridge: str) -> dict:
    m5 = m5ctl(port, "STATUS")
    bluez = bluez_info(mac)
    source = pipewire_source(mac)
    bridge_result = bridge_state(bridge)
    stage = "serial"
    if m5.get("ok"):
        stage = "bluez_discovery" if not bluez["known"] else "bluez_bond"
        if bluez["paired"] and bluez["bonded"]:
            stage = "hid_hfp" if not bluez["connected"] else "pipewire"
        if source["available"]:
            stage = "bridge"
        if bridge_result.get("state", {}).get("ble"):
            stage = "ready"
    return {"ok": stage == "ready", "stage": stage, "m5": m5,
            "bluez": bluez, "pipewire": source,
            "bridge": bridge_result}


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


def repair(port: str, mac: str, bridge: str, recover_bluez: bool) -> dict:
    before = diagnose(port, mac, bridge)
    recovery = None
    if recover_bluez and before["m5"].get("pairing") and not before["bluez"]["known"]:
        recovery = run("pkexec", RECOVERY_HELPER, timeout=30)
        if recovery["ok"]:
            time.sleep(2)
            before = diagnose(port, mac, bridge)
    m5_paired = bool(before["m5"].get("paired"))
    host_paired = before["bluez"]["paired"] and before["bluez"]["bonded"]
    reset = m5_paired != host_paired
    if reset:
        run("bluetoothctl", "remove", mac)
        response = m5ctl(port, "RESET_PAIRING")
        if not response.get("ok"):
            return {"ok": False, "stage": "m5_reset_pairing", "before": before,
                    "m5_response": response}
    elif not m5_paired:
        response = m5ctl(port, "PAIR 180")
        if not response.get("ok"):
            return {"ok": False, "stage": "m5_pairing", "before": before,
                    "m5_response": response}
    pairing = bluetooth_pair(mac)
    after = diagnose(port, mac, bridge)
    return {"ok": after["ok"], "reset_pairing": reset, "bluez_recovery": recovery, "before": before,
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
    args = parser.parse_args()
    try:
        port = serial_port(args.port)
        result = diagnose(port, args.mac.upper(), args.bridge) if args.action == "diagnose" else repair(port, args.mac.upper(), args.bridge, args.recover_bluez)
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
