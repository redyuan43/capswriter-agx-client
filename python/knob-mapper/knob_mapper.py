#!/usr/bin/env python3
"""Map a two-knob HID controller to desktop shortcuts."""

from __future__ import annotations

import argparse
import ctypes
import fcntl
import glob
import math
import os
import select
import signal
import struct
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import yaml


EVIOCGRAB = 0x40044590
EV_SYN = 0x00
EV_KEY = 0x01
EV_REL = 0x02
EV_ABS = 0x03
SYN_REPORT = 0
INPUT_EVENT = struct.Struct("llHHi")
BUS_USB = 0x03
UINPUT_MAX_NAME_SIZE = 80
ABS_CNT = 0x40
EMERGENCY_RELEASE_KEYS = (
    "Escape",
    "ctrl",
    "alt",
    "shift",
    "Super",
    "Control_L",
    "Control_R",
    "Alt_L",
    "Alt_R",
    "Shift_L",
    "Shift_R",
    "Super_L",
    "Super_R",
    "Caps_Lock",
)
XDOTOOL_TIMEOUT_SECONDS = 1.0
YDOTOOL_TIMEOUT_SECONDS = 1.5
YDOTOOL_KEY_DELAY_MS = 25
INPUT_POLL_TIMEOUT_SECONDS = 0.05
PR_SET_PDEATHSIG = 1

KEY_CODES = {
    2: "KEY_1",
    3: "KEY_2",
    4: "KEY_3",
    28: "KEY_ENTER",
    36: "KEY_J",
    37: "KEY_K",
    38: "KEY_L",
    57: "KEY_SPACE",
    103: "KEY_UP",
    105: "KEY_LEFT",
    106: "KEY_RIGHT",
    108: "KEY_DOWN",
    113: "KEY_MUTE",
    114: "KEY_VOLUMEDOWN",
    115: "KEY_VOLUMEUP",
    163: "KEY_NEXTSONG",
    164: "KEY_PLAYPAUSE",
    165: "KEY_PREVIOUSSONG",
    272: "BTN_LEFT",
    273: "BTN_RIGHT",
    274: "BTN_MIDDLE",
}

MODIFIER_ORDER = {
    "KEY_LEFTCTRL": 0,
    "KEY_RIGHTCTRL": 1,
    "KEY_LEFTSHIFT": 2,
    "KEY_RIGHTSHIFT": 3,
    "KEY_LEFTALT": 4,
    "KEY_RIGHTALT": 5,
    "KEY_LEFTMETA": 6,
    "KEY_RIGHTMETA": 7,
}

REL_CODES = {
    0: "REL_X",
    1: "REL_Y",
    6: "REL_HWHEEL",
    8: "REL_WHEEL",
    11: "REL_WHEEL_HI_RES",
    12: "REL_HWHEEL_HI_RES",
}


def _ioc(direction: int, type_: int, number: int, size: int) -> int:
    nr_bits = 8
    type_bits = 8
    size_bits = 14
    nr_shift = 0
    type_shift = nr_shift + nr_bits
    size_shift = type_shift + type_bits
    dir_shift = size_shift + size_bits
    return (
        (direction << dir_shift)
        | (type_ << type_shift)
        | (number << nr_shift)
        | (size << size_shift)
    )


def _io(type_: int, number: int) -> int:
    return _ioc(0, type_, number, 0)


def _iow(type_: int, number: int, size: int) -> int:
    return _ioc(1, type_, number, size)


UI_DEV_CREATE = _io(ord("U"), 1)
UI_DEV_DESTROY = _io(ord("U"), 2)
UI_SET_EVBIT = _iow(ord("U"), 100, 4)
UI_SET_KEYBIT = _iow(ord("U"), 101, 4)


def now() -> float:
    return time.monotonic()


def set_parent_death_signal() -> None:
    """Stop the mapper if the CapsWriter Electron parent disappears."""
    if os.name != "posix":
        return
    try:
        libc = ctypes.CDLL(None)
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM)
    except (AttributeError, OSError):
        pass


def log(message: str) -> None:
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"{stamp} {message}", flush=True)


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        config = yaml.safe_load(handle) or {}
    if not isinstance(config, dict):
        raise ValueError(f"{path} must contain a YAML mapping")
    return config


def expand_globs(patterns: list[str]) -> list[str]:
    seen: set[str] = set()
    paths: list[str] = []
    for pattern in patterns:
        for match in sorted(glob.glob(os.path.expanduser(pattern))):
            real = os.path.realpath(match)
            if real not in seen:
                seen.add(real)
                paths.append(match)
    return paths


def signed_i16(lo: int, hi: int) -> int:
    value = lo | (hi << 8)
    return value - 0x10000 if value & 0x8000 else value


def input_device_names() -> dict[str, str]:
    names: dict[str, str] = {}
    try:
        text = Path("/proc/bus/input/devices").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return names
    for block in text.strip().split("\n\n"):
        name = ""
        handlers: list[str] = []
        for line in block.splitlines():
            if line.startswith("N: Name="):
                name = line.split("=", 1)[1].strip().strip('"')
            elif line.startswith("H: Handlers="):
                handlers = line.split("=", 1)[1].split()
        for handler in handlers:
            if handler.startswith("event"):
                names[f"/dev/input/{handler}"] = name
    return names


def load_kernel_key_codes() -> tuple[dict[int, str], dict[str, int]]:
    codes = dict(KEY_CODES)
    header = Path("/usr/include/linux/input-event-codes.h")
    if header.exists():
        for line in header.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.startswith("#define KEY_") and not line.startswith("#define BTN_"):
                continue
            parts = line.split()
            if len(parts) < 3:
                continue
            try:
                codes[int(parts[2], 0)] = parts[1]
            except ValueError:
                continue
    return codes, {name: code for code, name in codes.items()}


KEY_CODES, KEY_NAME_TO_CODE = load_kernel_key_codes()


def normalize_chord(names: list[str]) -> str:
    return "+".join(sorted(names, key=lambda name: (MODIFIER_ORDER.get(name, 100), name)))


def find_evdev_by_name(queries: list[str]) -> list[str]:
    if not queries:
        return []
    device_names = input_device_names()
    matches: list[str] = []
    seen: set[str] = set()
    for query in queries:
        lowered = query.lower()
        for path, name in sorted(device_names.items()):
            if lowered in name.lower() and path not in seen:
                matches.append(path)
                seen.add(path)
    return matches


def shortcut_for_xdotool(hotkey: str) -> str:
    # xdotool accepts Ctrl+Alt+Right style names; keep user-facing YAML friendly.
    aliases = {
        "ctrl": "ctrl",
        "control": "ctrl",
        "cmd": "Super",
        "meta": "Super",
        "super": "Super",
        "win": "Super",
        "alt": "alt",
        "shift": "shift",
    }
    parts = [part.strip() for part in hotkey.replace("-", "+").split("+") if part.strip()]
    return "+".join(aliases.get(part.lower(), part) for part in parts)


def parse_uinput_key(value: str) -> int:
    aliases = {
        "ALT_L": "KEY_LEFTALT",
        "ALT_R": "KEY_RIGHTALT",
        "CONTROL_L": "KEY_LEFTCTRL",
        "CONTROL_R": "KEY_RIGHTCTRL",
        "CTRL_L": "KEY_LEFTCTRL",
        "CTRL_R": "KEY_RIGHTCTRL",
        "SHIFT_L": "KEY_LEFTSHIFT",
        "SHIFT_R": "KEY_RIGHTSHIFT",
        "SUPER_L": "KEY_LEFTMETA",
        "SUPER_R": "KEY_RIGHTMETA",
    }
    normalized = value.upper()
    name = aliases.get(normalized, value if value.startswith(("KEY_", "BTN_")) else f"KEY_{normalized}")
    if name not in KEY_NAME_TO_CODE:
        raise ValueError(f"unknown uinput key: {value}")
    return KEY_NAME_TO_CODE[name]


class UInputKeyboard:
    def __init__(self, dry_run: bool = False) -> None:
        self.dry_run = dry_run
        self.fd: int | None = None

    def open(self) -> None:
        if self.fd is not None or self.dry_run:
            return
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_SYN)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
        for code in KEY_NAME_TO_CODE.values():
            fcntl.ioctl(fd, UI_SET_KEYBIT, code)
        name = b"Knob Mapper Virtual Keyboard"
        user_dev = struct.pack(
            "80sHHHHI" + "i" * (ABS_CNT * 4),
            name[: UINPUT_MAX_NAME_SIZE - 1],
            BUS_USB,
            0xFFF2,
            0x4B4D,
            1,
            0,
            *([0] * (ABS_CNT * 4)),
        )
        os.write(fd, user_dev)
        fcntl.ioctl(fd, UI_DEV_CREATE)
        time.sleep(0.2)
        self.fd = fd
        log("opened uinput virtual keyboard")

    def close(self) -> None:
        if self.fd is None:
            return
        try:
            fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        finally:
            os.close(self.fd)
            self.fd = None

    def click(self, key_name: str, event_name: str) -> None:
        code = parse_uinput_key(key_name)
        if self.dry_run:
            log(f"dry-run uinput click {key_name} event={event_name}")
            return
        self.open()
        if self.fd is None:
            return
        self.keydown_code(code)
        self.keyup_code(code)
        log(f"uinput click {key_name} event={event_name}")

    def keydown(self, key_name: str, event_name: str) -> None:
        code = parse_uinput_key(key_name)
        if self.dry_run:
            log(f"dry-run uinput keydown {key_name} event={event_name}")
            return
        self.open()
        if self.fd is None:
            return
        self.keydown_code(code)
        log(f"uinput keydown {key_name} event={event_name}")

    def keyup(self, key_name: str, event_name: str) -> None:
        code = parse_uinput_key(key_name)
        if self.dry_run:
            log(f"dry-run uinput keyup {key_name} event={event_name}")
            return
        self.open()
        if self.fd is None:
            return
        self.keyup_code(code)
        log(f"uinput keyup {key_name} event={event_name}")

    def key_state(self, key_name: str, value: int, event_name: str) -> None:
        if value not in (0, 1, 2):
            return
        code = parse_uinput_key(key_name)
        if self.dry_run:
            log(f"dry-run uinput passthrough {key_name} value={value} event={event_name}")
            return
        self.open()
        if self.fd is None:
            return
        self.emit(EV_KEY, code, value)
        self.sync()
        log(f"uinput passthrough {key_name} value={value} event={event_name}")

    def keydown_code(self, code: int) -> None:
        if self.fd is None:
            return
        self.emit(EV_KEY, code, 1)
        self.sync()

    def keyup_code(self, code: int) -> None:
        if self.fd is None:
            return
        self.emit(EV_KEY, code, 0)
        self.sync()

    def emit(self, event_type: int, code: int, value: int) -> None:
        if self.fd is None:
            return
        t = time.time()
        sec = int(t)
        usec = int((t - sec) * 1_000_000)
        os.write(self.fd, INPUT_EVENT.pack(sec, usec, event_type, code, value))

    def sync(self) -> None:
        self.emit(EV_SYN, SYN_REPORT, 0)


class ActionRunner:
    def __init__(self, actions: dict[str, Any], dry_run: bool = False) -> None:
        self.actions = actions
        self.dry_run = dry_run
        self.uinput = UInputKeyboard(dry_run=dry_run)
        self.active_toggle_keys: set[str] = set()
        self.pulse_hold_keys: dict[str, float] = {}
        self.deferred_hotkeys: dict[str, float] = {}
        self.deferred_key_ups: dict[str, float] = {}
        self.event_counts: dict[str, int] = {}
        self.window_cycle_mods: tuple[str, ...] = ()
        self.window_cycle_deadline: float | None = None
        self.window_cycle_primed = False

    def emit(self, event_name: str, payload: dict[str, Any] | None = None) -> None:
        payload = payload or {}
        action = self.actions.get(event_name)
        log(f"event={event_name} payload={payload}")
        if not action:
            return
        if isinstance(action, str):
            action = {"hotkey": action}
        if not isinstance(action, dict):
            log(f"ignored invalid action for {event_name}: {action!r}")
            return
        every_n = int(action.get("every_n", 1))
        if every_n > 1:
            count = self.event_counts.get(event_name, 0) + 1
            if count < every_n:
                self.event_counts[event_name] = count
                log(f"event={event_name} gated count={count}/{every_n}")
                return
            self.event_counts[event_name] = 0
            log(f"event={event_name} gated count={every_n}/{every_n} fire=true")
        sequence = action.get("sequence")
        if sequence:
            self.run_sequence(sequence, event_name)
        uinput_sequence = action.get("uinput_sequence")
        if uinput_sequence:
            self.run_uinput_sequence(uinput_sequence, event_name)
        window_cycle = action.get("window_cycle")
        if window_cycle:
            self.run_window_cycle(str(window_cycle), float(action.get("release_after_seconds", 0.8)), event_name)
        scroll = action.get("scroll")
        if scroll:
            self.run_scroll(str(scroll), int(action.get("clicks", 1)), event_name)
        key_down = action.get("key_down")
        if key_down:
            self.run_xdotool(["keydown", shortcut_for_xdotool(str(key_down))], event_name)
        key_up = action.get("key_up")
        if key_up:
            key_name = shortcut_for_xdotool(str(key_up))
            min_hold_seconds = float(action.get("min_hold_seconds", 0))
            if min_hold_seconds > 0:
                self.deferred_key_ups[key_name] = now() + min_hold_seconds
                log(f"defer_keyup={key_name} deadline_in={min_hold_seconds:.3f}s")
            else:
                self.run_xdotool(["keyup", key_name], event_name)
        toggle_key = action.get("toggle_key")
        if toggle_key:
            key_name = shortcut_for_xdotool(str(toggle_key))
            if key_name in self.active_toggle_keys:
                self.run_xdotool(["keyup", key_name], event_name)
                self.active_toggle_keys.remove(key_name)
                log(f"toggle={key_name} state=off")
            else:
                self.run_xdotool(["keydown", key_name], event_name)
                self.active_toggle_keys.add(key_name)
                log(f"toggle={key_name} state=on")
        pulse_hold_key = action.get("pulse_hold_key")
        if pulse_hold_key:
            key_name = shortcut_for_xdotool(str(pulse_hold_key))
            hold_seconds = float(action.get("pulse_hold_seconds", 0.8))
            if key_name not in self.pulse_hold_keys:
                self.run_xdotool(["keydown", key_name], event_name)
                log(f"pulse_hold={key_name} state=on")
            self.pulse_hold_keys[key_name] = now() + hold_seconds
            log(f"pulse_hold={key_name} deadline_in={hold_seconds:.3f}s")
        hotkey = action.get("hotkey")
        if hotkey:
            key_name = shortcut_for_xdotool(str(hotkey))
            delay_seconds = float(action.get("delay_seconds", 0))
            if delay_seconds > 0:
                self.deferred_hotkeys[key_name] = now() + delay_seconds
                log(f"defer_hotkey={key_name} deadline_in={delay_seconds:.3f}s")
            else:
                self.run_xdotool(["key", "--clearmodifiers", key_name], event_name)
        uinput_key = action.get("uinput_key")
        if uinput_key:
            self.uinput.click(str(uinput_key), event_name)
        uinput_key_down = action.get("uinput_key_down")
        if uinput_key_down:
            self.uinput.keydown(str(uinput_key_down), event_name)
        uinput_key_up = action.get("uinput_key_up")
        if uinput_key_up:
            self.uinput.keyup(str(uinput_key_up), event_name)
        ydotool_key = action.get("ydotool_key")
        if ydotool_key:
            self.run_ydotool_key(str(ydotool_key), event_name)
        ydotool_key_down = action.get("ydotool_key_down")
        if ydotool_key_down:
            self.run_ydotool_key_state(str(ydotool_key_down), 1, event_name)
        ydotool_key_up = action.get("ydotool_key_up")
        if ydotool_key_up:
            self.run_ydotool_key_state(str(ydotool_key_up), 0, event_name)

    def passthrough_key(self, key_name: str, value: int) -> None:
        try:
            self.uinput.key_state(key_name, value, "passthrough")
        except ValueError as exc:
            log(f"ignored passthrough key={key_name} value={value}: {exc}")

    def run_sequence(self, sequence: Any, event_name: str) -> None:
        if not isinstance(sequence, list):
            log(f"ignored invalid sequence for {event_name}: {sequence!r}")
            return
        for step in sequence:
            if not isinstance(step, dict) or len(step) != 1:
                log(f"ignored invalid sequence step for {event_name}: {step!r}")
                continue
            command, key = next(iter(step.items()))
            if command not in {"key", "keydown", "keyup"}:
                log(f"ignored unsupported sequence command for {event_name}: {command!r}")
                continue
            args = [command, shortcut_for_xdotool(str(key))]
            self.run_xdotool(args, event_name)

    def run_uinput_sequence(self, sequence: Any, event_name: str) -> None:
        if not isinstance(sequence, list):
            log(f"ignored invalid uinput_sequence for {event_name}: {sequence!r}")
            return
        for step in sequence:
            if not isinstance(step, dict) or len(step) != 1:
                log(f"ignored invalid uinput_sequence step for {event_name}: {step!r}")
                continue
            command, key = next(iter(step.items()))
            if command == "key":
                self.uinput.click(str(key), event_name)
            elif command == "keydown":
                self.uinput.keydown(str(key), event_name)
            elif command == "keyup":
                self.uinput.keyup(str(key), event_name)
            else:
                log(f"ignored unsupported uinput_sequence command for {event_name}: {command!r}")

    def run_window_cycle(self, direction: str, release_after_seconds: float, event_name: str) -> None:
        if direction == "forward":
            mods = ("KEY_LEFTALT",)
        elif direction == "backward":
            mods = ("KEY_LEFTALT", "KEY_LEFTSHIFT")
        else:
            log(f"ignored invalid window_cycle direction for {event_name}: {direction!r}")
            return
        if self.window_cycle_mods != mods:
            for mod in reversed(self.window_cycle_mods):
                if mod not in mods:
                    self.uinput.keyup(mod, event_name)
            for mod in mods:
                if mod not in self.window_cycle_mods:
                    self.uinput.keydown(mod, event_name)
            self.window_cycle_mods = mods
            self.window_cycle_primed = False
        if not self.window_cycle_primed:
            self.sleep(0.03, event_name)
            self.window_cycle_primed = True
        self.uinput.click("KEY_ESC", event_name)
        self.window_cycle_deadline = now() + release_after_seconds
        log(f"window_cycle={direction} deadline_in={release_after_seconds:.3f}s")

    def run_ydotool_key(self, key_name: str, event_name: str) -> None:
        code = parse_uinput_key(key_name)
        self.run_ydotool_events([f"{code}:1", f"{code}:0"], event_name)

    def run_ydotool_key_state(self, key_name: str, state: int, event_name: str) -> None:
        code = parse_uinput_key(key_name)
        self.run_ydotool_events([f"{code}:{state}"], event_name)

    def run_ydotool_events(self, events: list[str], event_name: str) -> None:
        command = ["ydotool", "key", "--key-delay", str(YDOTOOL_KEY_DELAY_MS), *events]
        if self.dry_run:
            log(f"dry-run command={' '.join(command)} event={event_name}")
            return
        try:
            subprocess.run(
                command,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                timeout=YDOTOOL_TIMEOUT_SECONDS,
            )
            log(f"ydotool key events={' '.join(events)} event={event_name}")
        except FileNotFoundError:
            log("ydotool not found; install ydotool or configure another output action")
        except subprocess.TimeoutExpired:
            log(f"ydotool timeout events={' '.join(events)} event={event_name}")
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or "").strip()
            log(f"ydotool failed exit={exc.returncode} events={' '.join(events)} event={event_name} stderr={stderr}")

    def run_scroll(self, direction: str, clicks: int, event_name: str) -> None:
        if direction == "up":
            button = "4"
        elif direction == "down":
            button = "5"
        else:
            log(f"ignored invalid scroll direction for {event_name}: {direction!r}")
            return
        window = self.get_focus_window(event_name)
        for _ in range(max(1, clicks)):
            if window and self.scroll_at_window_center(window, button, event_name):
                continue
            self.run_xdotool(["click", button], event_name)

    def get_focus_window(self, event_name: str) -> str | None:
        for command in (["xdotool", "getwindowfocus"], ["xdotool", "getactivewindow"]):
            window = self.read_xdotool_stdout(command, event_name).strip()
            if window:
                return window
        return None

    def scroll_at_window_center(self, window: str, button: str, event_name: str) -> bool:
        mouse = self.parse_shell_output(self.read_xdotool_stdout(["xdotool", "getmouselocation", "--shell"], event_name))
        geometry = self.parse_shell_output(
            self.read_xdotool_stdout(["xdotool", "getwindowgeometry", "--shell", window], event_name)
        )
        try:
            original_x = int(mouse["X"])
            original_y = int(mouse["Y"])
            target_x = int(geometry["X"]) + int(geometry["WIDTH"]) // 2
            target_y = int(geometry["Y"]) + int(geometry["HEIGHT"]) // 2
        except (KeyError, ValueError):
            return False
        self.run_xdotool(["mousemove", str(target_x), str(target_y)], event_name)
        self.run_xdotool(["click", button], event_name)
        self.run_xdotool(["mousemove", str(original_x), str(original_y)], event_name)
        return True

    @staticmethod
    def parse_shell_output(text: str) -> dict[str, str]:
        values: dict[str, str] = {}
        for line in text.splitlines():
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
        return values

    def read_xdotool_stdout(self, command: list[str], event_name: str) -> str:
        if self.dry_run:
            log(f"dry-run command={' '.join(command)}")
            if command[1] in {"getwindowfocus", "getactivewindow"}:
                return "ACTIVE_WINDOW\n"
            if command[1] == "getmouselocation":
                return "X=10\nY=20\nSCREEN=0\nWINDOW=ACTIVE_WINDOW\n"
            if command[1] == "getwindowgeometry":
                return "X=100\nY=200\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n"
            return ""
        try:
            result = subprocess.run(
                command,
                check=True,
                capture_output=True,
                text=True,
                timeout=XDOTOOL_TIMEOUT_SECONDS,
            )
        except FileNotFoundError:
            log("xdotool not found; install xdotool or run with --dry-run")
            return ""
        except subprocess.TimeoutExpired:
            log(f"xdotool read timeout command={' '.join(command)} event={event_name}")
            return ""
        except subprocess.CalledProcessError as exc:
            log(f"xdotool read failed exit={exc.returncode} command={' '.join(command)} event={event_name}")
            return ""
        return result.stdout

    def release_window_cycle_mods(self, event_name: str) -> None:
        for mod in reversed(self.window_cycle_mods):
            self.uinput.keyup(mod, event_name)
        self.window_cycle_mods = ()
        self.window_cycle_deadline = None
        self.window_cycle_primed = False

    def sleep(self, seconds: float, event_name: str) -> None:
        if self.dry_run:
            log(f"dry-run sleep={seconds:.3f}s event={event_name}")
            return
        time.sleep(seconds)

    def run_xdotool(self, args: list[str], event_name: str) -> None:
        command = ["xdotool", *args]
        if self.dry_run:
            log(f"dry-run command={' '.join(command)}")
            return
        try:
            subprocess.run(
                command,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                timeout=XDOTOOL_TIMEOUT_SECONDS,
            )
        except FileNotFoundError:
            log("xdotool not found; install xdotool or run with --dry-run")
        except subprocess.TimeoutExpired:
            log(f"xdotool timeout event={event_name}; releasing emergency keys")
            self.emergency_release_keys("xdotool.timeout")
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or "").strip()
            log(f"xdotool failed exit={exc.returncode} event={event_name} stderr={stderr}")
            self.emergency_release_keys("xdotool.failed")

    def emergency_release_keys(self, event_name: str) -> None:
        for key_name in EMERGENCY_RELEASE_KEYS:
            command = ["xdotool", "keyup", key_name]
            if self.dry_run:
                log(f"dry-run emergency command={' '.join(command)} event={event_name}")
                continue
            try:
                subprocess.run(
                    command,
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=XDOTOOL_TIMEOUT_SECONDS,
                )
            except (FileNotFoundError, subprocess.TimeoutExpired):
                return

    def cleanup(self) -> None:
        self.deferred_hotkeys.clear()
        for key_name in sorted(self.deferred_key_ups):
            self.run_xdotool(["keyup", key_name], "cleanup")
        self.deferred_key_ups.clear()
        for key_name in sorted(self.pulse_hold_keys):
            self.run_xdotool(["keyup", key_name], "cleanup")
        self.pulse_hold_keys.clear()
        for key_name in sorted(self.active_toggle_keys):
            self.run_xdotool(["keyup", key_name], "cleanup")
        self.active_toggle_keys.clear()
        self.release_window_cycle_mods("cleanup")
        release_stuck_keys(self.actions, self.dry_run)
        self.emergency_release_keys("cleanup")
        self.uinput.close()

    def open_virtual_keyboard(self) -> None:
        try:
            self.uinput.open()
        except OSError as exc:
            log(f"warning: cannot open uinput virtual keyboard at startup: {exc}")

    def tick(self) -> None:
        t = now()
        if self.window_cycle_deadline is not None and t >= self.window_cycle_deadline:
            self.release_window_cycle_mods("window_cycle.timeout")
            log("window_cycle state=selected reason=timeout")
        expired_hotkeys = [key_name for key_name, deadline in self.deferred_hotkeys.items() if t >= deadline]
        for key_name in expired_hotkeys:
            self.run_xdotool(["key", "--clearmodifiers", key_name], "deferred_hotkey.timeout")
            self.deferred_hotkeys.pop(key_name, None)
            log(f"defer_hotkey={key_name} state=sent")
        expired_key_ups = [key_name for key_name, deadline in self.deferred_key_ups.items() if t >= deadline]
        for key_name in expired_key_ups:
            self.run_xdotool(["keyup", key_name], "deferred_keyup.timeout")
            self.deferred_key_ups.pop(key_name, None)
            log(f"defer_keyup={key_name} state=sent")
        expired = [key_name for key_name, deadline in self.pulse_hold_keys.items() if t >= deadline]
        for key_name in expired:
            self.run_xdotool(["keyup", key_name], "pulse_hold.timeout")
            self.pulse_hold_keys.pop(key_name, None)
            log(f"pulse_hold={key_name} state=off reason=timeout")


def release_stuck_keys(actions: dict[str, Any], dry_run: bool) -> None:
    key_ups: list[str] = []
    for action in actions.values():
        if isinstance(action, dict) and action.get("key_up"):
            key_ups.append(shortcut_for_xdotool(str(action["key_up"])))
    for key_name in sorted(set(key_ups)):
        command = ["xdotool", "keyup", key_name]
        if dry_run:
            log(f"dry-run cleanup command={' '.join(command)}")
            continue
        try:
            subprocess.run(command, check=False)
        except FileNotFoundError:
            return


@dataclass
class ButtonState:
    name: str
    hold_seconds: float
    emit: Callable[[str, dict[str, Any] | None], None]
    pressed: bool = False
    pressed_at: float = 0.0
    hold_sent: bool = False

    def set_pressed(self, pressed: bool) -> None:
        t = now()
        if pressed and not self.pressed:
            self.pressed = True
            self.pressed_at = t
            self.hold_sent = False
            self.emit(f"{self.name}.press", {"state": "pressed"})
        elif not pressed and self.pressed:
            duration = t - self.pressed_at
            was_holding = self.hold_sent
            self.pressed = False
            if was_holding:
                self.emit(
                    f"{self.name}.hold_release",
                    {"state": "released", "duration": round(duration, 3), "held": True},
                )
            self.emit(f"{self.name}.release", {"state": "released", "duration": round(duration, 3)})

    def tick(self) -> None:
        if not self.pressed or self.hold_sent:
            return
        duration = now() - self.pressed_at
        if duration >= self.hold_seconds:
            self.hold_sent = True
            self.emit(f"{self.name}.hold", {"state": "holding", "duration": round(duration, 3)})


@dataclass
class ReleasePulseButtonState:
    name: str
    emit: Callable[[str, dict[str, Any] | None], None]
    pulse_started_at: float = 0.0

    def set_pressed(self, pressed: bool) -> None:
        t = now()
        if pressed:
            self.pulse_started_at = t
            self.emit(f"{self.name}.pulse_start", {"state": "pulse_started"})
            return
        duration = t - self.pulse_started_at if self.pulse_started_at else 0.0
        self.emit(
            f"{self.name}.release_pulse",
            {"state": "release_pulse", "pulse_duration": round(duration, 3)},
        )
        self.pulse_started_at = 0.0

    def tick(self) -> None:
        return


@dataclass
class HoldTapKeyState:
    name: str
    hold_seconds: float
    emit: Callable[[str, dict[str, Any] | None], None]
    pressed: bool = False
    pressed_at: float = 0.0
    hold_sent: bool = False

    def set_pressed(self, pressed: bool) -> None:
        t = now()
        if pressed and not self.pressed:
            self.pressed = True
            self.pressed_at = t
            self.hold_sent = False
        elif not pressed and self.pressed:
            duration = t - self.pressed_at
            was_holding = self.hold_sent
            self.pressed = False
            if was_holding:
                self.emit(
                    f"{self.name}.hold_release",
                    {"state": "released", "duration": round(duration, 3), "held": True},
                )
            else:
                self.emit(f"{self.name}.tap", {"state": "tapped", "duration": round(duration, 3)})

    def tick(self) -> None:
        if not self.pressed or self.hold_sent:
            return
        duration = now() - self.pressed_at
        if duration >= self.hold_seconds:
            self.hold_sent = True
            self.emit(f"{self.name}.hold", {"state": "holding", "duration": round(duration, 3)})


class EvdevInput:
    def __init__(
        self,
        paths: list[str],
        grab: bool,
        emit: Callable[[str, dict[str, Any] | None], None],
        key_to_event: dict[str, str] | None = None,
        chord_to_event: dict[str, str] | None = None,
        passthrough_unmapped: Callable[[str, int], None] | None = None,
        path_resolver: Callable[[], list[str]] | None = None,
        reconnect_seconds: float = 1.0,
    ) -> None:
        self.paths = paths
        self.grab = grab
        self.emit = emit
        self.fds: dict[int, str] = {}
        self.key_to_event = key_to_event or {}
        self.chord_to_event = chord_to_event or {}
        self.passthrough_unmapped = passthrough_unmapped
        self.path_resolver = path_resolver
        self.reconnect_seconds = reconnect_seconds
        self.next_reconnect_at = 0.0
        self.key_state_events: dict[str, tuple[str, str]] = {}
        self.chorded_key_state_events: dict[str, tuple[str, str, str]] = {}
        self.active_chorded_keys: dict[str, tuple[str, str]] = {}
        self.button_keys: dict[str, ButtonState | ReleasePulseButtonState | HoldTapKeyState] = {}
        self.abs_axis_events: dict[str, dict[str, Any]] = {}
        self.abs_axis_state: dict[str, dict[str, int | bool | None]] = {}
        self.pending_key_events: list[tuple[str, int]] = []
        self.pressed_keys: set[str] = set()

    def add_button_key(self, key_name: str, button: ButtonState | ReleasePulseButtonState | HoldTapKeyState) -> None:
        self.button_keys[key_name] = button

    def add_key_state_events(self, key_name: str, press_event: str, release_event: str) -> None:
        self.key_state_events[key_name] = (press_event, release_event)

    def add_chorded_key_state_events(
        self, modifier_key_name: str, key_name: str, press_event: str, release_event: str
    ) -> None:
        self.chorded_key_state_events[key_name] = (modifier_key_name, press_event, release_event)

    def add_abs_axis_event(
        self,
        axis_name: str,
        positive_event: str,
        negative_event: str,
        touch_key: str = "BTN_TOUCH",
        min_delta: int = 500,
    ) -> None:
        self.abs_axis_events[axis_name] = {
            "positive_event": positive_event,
            "negative_event": negative_event,
            "touch_key": touch_key,
            "min_delta": min_delta,
        }
        self.abs_axis_state[axis_name] = {"active": False, "start": None, "last": None}

    def open(self) -> None:
        open_realpaths = {os.path.realpath(path) for path in self.fds.values()}
        for path in self.paths:
            if os.path.realpath(path) in open_realpaths:
                continue
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                log(f"warning: cannot open evdev path={path}: {exc}")
                continue
            if self.grab:
                try:
                    fcntl.ioctl(fd, EVIOCGRAB, 1)
                except OSError as exc:
                    log(f"warning: cannot grab evdev path={path}: {exc}")
            self.fds[fd] = path
            log(f"opened evdev path={path} fd={fd} grab={self.grab}")

    def refresh_paths(self) -> None:
        if not self.path_resolver:
            return
        paths = self.path_resolver()
        if paths != self.paths:
            log(f"refreshed evdev paths old={self.paths} new={paths}")
            self.paths = paths

    def close(self) -> None:
        for fd in list(self.fds):
            self.close_fd(fd, "close")

    def close_fd(self, fd: int, reason: str) -> None:
        path = self.fds.pop(fd, None)
        if path is None:
            return
        if self.grab:
            try:
                fcntl.ioctl(fd, EVIOCGRAB, 0)
            except OSError:
                pass
        try:
            os.close(fd)
        except OSError:
            pass
        log(f"closed evdev path={path} fd={fd} reason={reason}")
        if not self.fds:
            self.release_pressed_keys(reason)

    def release_pressed_keys(self, reason: str) -> None:
        for key_name in sorted(self.pressed_keys):
            if key_name in self.key_state_events:
                _press_event, release_event = self.key_state_events[key_name]
                self.emit(release_event, {"source": key_name, "state": "released", "reason": reason})
            elif key_name in self.button_keys:
                continue
            elif self.passthrough_unmapped:
                self.passthrough_unmapped(key_name, 0)
        seen_buttons: set[int] = set()
        for key_name in sorted(self.pressed_keys):
            button = self.button_keys.get(key_name)
            if not button:
                continue
            marker = id(button)
            if marker in seen_buttons:
                continue
            seen_buttons.add(marker)
            button.set_pressed(False)
        self.pressed_keys.clear()
        self.active_chorded_keys.clear()
        self.pending_key_events = []

    def read_ready(self, fd: int) -> None:
        while True:
            try:
                data = os.read(fd, INPUT_EVENT.size)
            except BlockingIOError:
                return
            except OSError as exc:
                path = self.fds.get(fd, "<unknown>")
                log(f"warning: evdev read failed path={path} fd={fd}: {exc}")
                self.close_fd(fd, "read_error")
                return
            if len(data) < INPUT_EVENT.size:
                return
            _sec, _usec, event_type, code, value = INPUT_EVENT.unpack(data)
            if event_type == EV_KEY:
                key_name = KEY_CODES.get(code, f"KEY_{code}")
                if self.is_abs_touch_key(key_name) and value in (0, 1):
                    self.handle_abs_touch_key(key_name, value == 1)
                else:
                    self.pending_key_events.append((key_name, value))
            elif event_type == EV_ABS:
                axis_name = ABS_CODES.get(code, f"ABS_{code}")
                self.handle_abs_event(axis_name, value)
            elif event_type == EV_SYN and code == SYN_REPORT:
                self.handle_key_report()

    def handle_key_report(self) -> None:
        if not self.pending_key_events:
            return
        consumed: set[int] = set()
        for index, (key_name, value) in enumerate(self.pending_key_events):
            if value == 1:
                chord_name = normalize_chord([*self.pressed_keys, key_name])
                event_name = self.chord_to_event.get(chord_name)
                if event_name:
                    self.emit(event_name, {"source": chord_name})
                    consumed.add(index)
                self.pressed_keys.add(key_name)
            elif value == 0:
                self.pressed_keys.discard(key_name)
        for index, (key_name, value) in enumerate(self.pending_key_events):
            if index not in consumed:
                self.handle_key_event(key_name, value)
        self.pending_key_events = []

    def handle_key_event(self, key_name: str, value: int) -> None:
        mapped_key = (
            key_name in self.key_to_event
            or key_name in self.chorded_key_state_events
            or key_name in self.key_state_events
            or key_name in self.button_keys
        )
        if value == 1:
            self.pressed_keys.add(key_name)
        if key_name in self.key_to_event and value == 1:
            self.emit(self.key_to_event[key_name], {"source": key_name})
        if key_name in self.chorded_key_state_events and value in (0, 1):
            modifier_key_name, press_event, release_event = self.chorded_key_state_events[key_name]
            if value == 1 and modifier_key_name in self.pressed_keys:
                self.active_chorded_keys[key_name] = (press_event, release_event)
                self.emit(press_event, {"source": key_name, "state": "pressed", "modifier": modifier_key_name})
                return
            if value == 0 and key_name in self.active_chorded_keys:
                _active_press_event, active_release_event = self.active_chorded_keys.pop(key_name)
                self.emit(active_release_event, {"source": key_name, "state": "released", "modifier": modifier_key_name})
                self.pressed_keys.discard(key_name)
                return
        if key_name in self.key_state_events and value in (0, 1):
            press_event, release_event = self.key_state_events[key_name]
            event_name = press_event if value == 1 else release_event
            state = "pressed" if value == 1 else "released"
            self.emit(event_name, {"source": key_name, "state": state})
        if key_name in self.button_keys and value in (0, 1):
            self.button_keys[key_name].set_pressed(value == 1)
        if not mapped_key and self.passthrough_unmapped and value in (0, 1, 2):
            self.passthrough_unmapped(key_name, value)
        if value == 0:
            self.pressed_keys.discard(key_name)

    def is_abs_touch_key(self, key_name: str) -> bool:
        return any(axis_config["touch_key"] == key_name for axis_config in self.abs_axis_events.values())

    def handle_abs_event(self, axis_name: str, value: int) -> None:
        state = self.abs_axis_state.get(axis_name)
        if state is None or not state["active"]:
            return
        if state["start"] is None:
            state["start"] = value
        state["last"] = value

    def handle_abs_touch_key(self, key_name: str, pressed: bool) -> None:
        for axis_name, axis_config in self.abs_axis_events.items():
            if axis_config["touch_key"] != key_name:
                continue
            state = self.abs_axis_state[axis_name]
            if pressed:
                state["active"] = True
                state["start"] = None
                state["last"] = None
                continue
            if not state["active"]:
                continue
            start = state["start"]
            last = state["last"]
            state["active"] = False
            state["start"] = None
            state["last"] = None
            if not isinstance(start, int) or not isinstance(last, int):
                continue
            delta = last - start
            if abs(delta) < int(axis_config["min_delta"]):
                continue
            event_name = axis_config["positive_event"] if delta > 0 else axis_config["negative_event"]
            self.emit(event_name, {"source": axis_name, "start": start, "last": last, "delta": delta})

    def tick(self) -> None:
        if self.path_resolver:
            t = now()
            if t >= self.next_reconnect_at:
                self.refresh_paths()
                self.open()
                self.next_reconnect_at = t + self.reconnect_seconds
        seen: set[int] = set()
        for button in self.button_keys.values():
            marker = id(button)
            if marker in seen:
                continue
            seen.add(marker)
            button.tick()


@dataclass
class RawBurst:
    dx: int = 0
    dy: int = 0
    count: int = 0
    started_at: float = 0.0
    updated_at: float = 0.0

    def add(self, dx: int, dy: int) -> None:
        t = now()
        if self.count == 0:
            self.started_at = t
        self.updated_at = t
        self.dx += dx
        self.dy += dy
        self.count += 1

    def clear(self) -> None:
        self.dx = 0
        self.dy = 0
        self.count = 0
        self.started_at = 0.0
        self.updated_at = 0.0


@dataclass
class RawHidConfig:
    report_id: int = 1
    burst_gap_seconds: float = 0.16
    min_reports: int = 4
    min_magnitude: float = 8.0
    clockwise_vector: tuple[float, float] = (1.0, -1.0)
    counterclockwise_vector: tuple[float, float] = (-1.0, 1.0)


class RawHidInput:
    def __init__(
        self,
        paths: list[str],
        config: RawHidConfig,
        button: ButtonState,
        emit: Callable[[str, dict[str, Any] | None], None],
    ) -> None:
        self.paths = paths
        self.config = config
        self.button = button
        self.emit = emit
        self.fds: dict[int, str] = {}
        self.burst = RawBurst()
        self.last_buttons = 0

    def open(self) -> None:
        for path in self.paths:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                log(f"warning: cannot open hidraw path={path}: {exc}")
                continue
            self.fds[fd] = path
            log(f"opened hidraw path={path} fd={fd}")

    def close(self) -> None:
        for fd in list(self.fds):
            self.close_fd(fd, "close")

    def close_fd(self, fd: int, reason: str) -> None:
        path = self.fds.pop(fd, None)
        if path is None:
            return
        try:
            os.close(fd)
        except OSError:
            pass
        log(f"closed hidraw path={path} fd={fd} reason={reason}")

    def read_ready(self, fd: int) -> None:
        while True:
            try:
                data = os.read(fd, 64)
            except BlockingIOError:
                return
            except OSError as exc:
                path = self.fds.get(fd, "<unknown>")
                log(f"warning: hidraw read failed path={path} fd={fd}: {exc}")
                self.close_fd(fd, "read_error")
                return
            if not data:
                self.close_fd(fd, "end_of_file")
                return
            self.handle_report(data)

    def handle_report(self, data: bytes) -> None:
        if len(data) < 6 or data[0] != self.config.report_id:
            return
        buttons = data[1]
        dx = signed_i16(data[2], data[3])
        dy = signed_i16(data[4], data[5])
        pressed = bool(buttons & 0x01)
        last_pressed = bool(self.last_buttons & 0x01)
        if pressed != last_pressed:
            self.button.set_pressed(pressed)
        self.last_buttons = buttons
        if dx or dy:
            self.burst.add(dx, dy)

    def tick(self) -> None:
        if self.burst.count and now() - self.burst.updated_at >= self.config.burst_gap_seconds:
            self.flush_burst()

    def flush_burst(self) -> None:
        burst = self.burst
        magnitude = math.hypot(burst.dx, burst.dy)
        payload = {
            "dx": burst.dx,
            "dy": burst.dy,
            "reports": burst.count,
            "magnitude": round(magnitude, 3),
        }
        if burst.count >= self.config.min_reports and magnitude >= self.config.min_magnitude:
            direction = self.classify(burst.dx, burst.dy)
            if direction:
                self.emit(f"knob2.{direction}", payload)
            else:
                log(f"event=knob2.unclassified payload={payload}")
        self.burst.clear()

    def classify(self, dx: int, dy: int) -> str | None:
        cw = self.score(dx, dy, self.config.clockwise_vector)
        ccw = self.score(dx, dy, self.config.counterclockwise_vector)
        if cw <= 0 and ccw <= 0:
            return None
        return "cw" if cw >= ccw else "ccw"

    @staticmethod
    def score(dx: int, dy: int, vector: tuple[float, float]) -> float:
        vx, vy = vector
        denom = math.hypot(vx, vy) or 1.0
        return (dx * vx + dy * vy) / denom


class RawReportInput:
    def __init__(
        self,
        paths: list[str],
        report_to_event: dict[str, str],
        emit: Callable[[str, dict[str, Any] | None], None],
    ) -> None:
        self.paths = paths
        self.report_to_event = {normalize_hex_report(report): event for report, event in report_to_event.items()}
        self.emit = emit
        self.fds: dict[int, str] = {}

    def open(self) -> None:
        for path in self.paths:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                log(f"warning: cannot open raw-report hidraw path={path}: {exc}")
                continue
            self.fds[fd] = path
            log(f"opened raw-report hidraw path={path} fd={fd}")

    def close(self) -> None:
        for fd in list(self.fds):
            self.close_fd(fd, "close")

    def close_fd(self, fd: int, reason: str) -> None:
        path = self.fds.pop(fd, None)
        if path is None:
            return
        try:
            os.close(fd)
        except OSError:
            pass
        log(f"closed raw-report hidraw path={path} fd={fd} reason={reason}")

    def read_ready(self, fd: int) -> None:
        while True:
            try:
                data = os.read(fd, 64)
            except BlockingIOError:
                return
            except OSError as exc:
                path = self.fds.get(fd, "<unknown>")
                log(f"warning: raw-report hidraw read failed path={path} fd={fd}: {exc}")
                self.close_fd(fd, "read_error")
                return
            if not data:
                self.close_fd(fd, "end_of_file")
                return
            self.handle_report(data, self.fds.get(fd))

    def handle_report(self, data: bytes, path: str | None = None) -> None:
        report = data.hex(" ")
        event_name = self.report_to_event.get(report)
        if event_name:
            self.emit(event_name, {"source": path or "hidraw", "report": report})


def normalize_hex_report(report: str) -> str:
    return bytes.fromhex(report).hex(" ")


def make_raw_config(raw: dict[str, Any]) -> RawHidConfig:
    def vector(name: str, default: tuple[float, float]) -> tuple[float, float]:
        value = raw.get(name, default)
        if not isinstance(value, list | tuple) or len(value) != 2:
            return default
        return (float(value[0]), float(value[1]))

    return RawHidConfig(
        report_id=int(raw.get("report_id", 1)),
        burst_gap_seconds=float(raw.get("burst_gap_seconds", 0.16)),
        min_reports=int(raw.get("min_reports", 4)),
        min_magnitude=float(raw.get("min_magnitude", 8.0)),
        clockwise_vector=vector("clockwise_vector", (1.0, -1.0)),
        counterclockwise_vector=vector("counterclockwise_vector", (-1.0, 1.0)),
    )


def wait_for_ready_fds(fds: list[int]) -> list[int]:
    if not fds:
        time.sleep(INPUT_POLL_TIMEOUT_SECONDS)
        return []
    ready, _, _ = select.select(fds, [], [], INPUT_POLL_TIMEOUT_SECONDS)
    return ready


def build_inputs(config: dict[str, Any], runner: ActionRunner) -> tuple[list[Any], list[ButtonState]]:
    devices = config.get("devices", {})
    behavior = config.get("behavior", {})
    hold_seconds = float(behavior.get("hold_seconds", 0.6))
    grab_evdev = bool(behavior.get("grab_evdev", True))

    buttons = [
        (
            ReleasePulseButtonState("button1", runner.emit)
            if str(devices.get("button1_mode", "release_pulse")) == "release_pulse"
            else ButtonState("button1", hold_seconds, runner.emit)
        ),
        ButtonState("button2", hold_seconds, runner.emit),
    ]

    evdev_paths = expand_globs(devices.get("knob1_evdev", []))
    knob2_evdev_paths = expand_globs(devices.get("knob2_evdev", []))
    doio_evdev_paths = expand_globs(devices.get("doio_evdev", []))
    named_evdev_queries = [str(query) for query in devices.get("named_evdev", [])]
    passthrough_named_evdev_queries = [str(query) for query in devices.get("passthrough_named_evdev", [])]
    named_evdev_paths = find_evdev_by_name(named_evdev_queries)
    passthrough_named_evdev_paths = find_evdev_by_name(passthrough_named_evdev_queries)
    raw_paths = expand_globs(devices.get("knob2_hidraw", [])) if "knob2_hidraw" in devices else []
    raw_report_paths = expand_globs(devices.get("raw_report_hidraw", []))
    inputs: list[Any] = []
    all_evdev_paths = sorted({*evdev_paths, *knob2_evdev_paths, *doio_evdev_paths})
    key_to_event = {
        str(devices.get("knob1_cw_key", "KEY_VOLUMEUP")): "knob1.cw",
        str(devices.get("knob1_ccw_key", "KEY_VOLUMEDOWN")): "knob1.ccw",
        str(devices.get("knob2_cw_key", "KEY_2")): "knob2.cw",
        str(devices.get("knob2_ccw_key", "KEY_1")): "knob2.ccw",
        str(devices.get("knob1_chord_cw_key", "KEY_NEXTSONG")): "knob1.chord_cw",
        str(devices.get("knob1_chord_ccw_key", "KEY_PREVIOUSSONG")): "knob1.chord_ccw",
    }
    knob2_chord_cw_key = devices.get("knob2_chord_cw_key")
    knob2_chord_ccw_key = devices.get("knob2_chord_ccw_key")
    if knob2_chord_cw_key:
        key_to_event[str(knob2_chord_cw_key)] = "knob2.chord_cw"
    if knob2_chord_ccw_key:
        key_to_event[str(knob2_chord_ccw_key)] = "knob2.chord_ccw"
    if all_evdev_paths:
        evdev = EvdevInput(all_evdev_paths, grab_evdev, runner.emit, key_to_event)
        evdev.add_button_key(str(devices.get("button1_key", "KEY_MUTE")), buttons[0])
        button2_key = devices.get("button2_key")
        if button2_key:
            evdev.add_button_key(str(button2_key), buttons[1])
        doio_key_events = {
            "doio_key1": "doio.key1",
            "doio_key2": "doio.key2",
            "doio_key3": "doio.key3",
            "doio_up_key": "doio.up",
            "doio_down_key": "doio.down",
            "doio_left_key": "doio.left",
            "doio_right_key": "doio.right",
            "doio_enter_key": "doio.enter",
        }
        for config_key, event_prefix in doio_key_events.items():
            key_name = devices.get(config_key)
            if key_name:
                evdev.add_key_state_events(str(key_name), f"{event_prefix}.press", f"{event_prefix}.release")
        doio_super_key = devices.get("doio_key1")
        doio_super_chords = {
            "doio_up_key": "doio.super_up",
            "doio_down_key": "doio.super_down",
            "doio_left_key": "doio.super_left",
            "doio_right_key": "doio.super_right",
        }
        if doio_super_key:
            for config_key, event_prefix in doio_super_chords.items():
                key_name = devices.get(config_key)
                if key_name:
                    evdev.add_chorded_key_state_events(
                        str(doio_super_key), str(key_name), f"{event_prefix}.press", f"{event_prefix}.release"
                    )
        inputs.append(evdev)
    elif not named_evdev_queries and not passthrough_named_evdev_queries:
        log("warning: no evdev devices matched")
    extra_key_events = config.get("key_events", {})
    extra_key_state_events = config.get("key_state_events", {})
    extra_hold_tap_events = config.get("hold_tap_events", {})
    extra_chord_events = config.get("chord_events", {})
    extra_abs_axis_events = config.get("abs_axis_events", {})
    passthrough_key_state_events = config.get("passthrough_key_state_events", {})
    if named_evdev_queries and (
        isinstance(extra_key_events, dict)
        or isinstance(extra_key_state_events, dict)
        or isinstance(extra_hold_tap_events, dict)
        or isinstance(extra_chord_events, dict)
        or isinstance(extra_abs_axis_events, dict)
    ):
        named_key_to_event = (
            {str(key): str(event) for key, event in extra_key_events.items()}
            if isinstance(extra_key_events, dict)
            else {}
        )
        named_chord_to_event = (
            {normalize_chord(str(chord).split("+")): str(event) for chord, event in extra_chord_events.items()}
            if isinstance(extra_chord_events, dict)
            else {}
        )
        named_evdev = EvdevInput(
            named_evdev_paths,
            grab_evdev,
            runner.emit,
            named_key_to_event,
            named_chord_to_event,
            path_resolver=lambda queries=named_evdev_queries: find_evdev_by_name(queries),
        )
        if isinstance(extra_key_state_events, dict):
            for key_name, event_prefix in extra_key_state_events.items():
                named_evdev.add_key_state_events(str(key_name), f"{event_prefix}.press", f"{event_prefix}.release")
        if isinstance(extra_hold_tap_events, dict):
            for key_name, event_prefix in extra_hold_tap_events.items():
                named_evdev.add_button_key(str(key_name), HoldTapKeyState(str(event_prefix), hold_seconds, runner.emit))
        if isinstance(extra_abs_axis_events, dict):
            for axis_name, axis_config in extra_abs_axis_events.items():
                if not isinstance(axis_config, dict):
                    continue
                positive_event = axis_config.get("positive")
                negative_event = axis_config.get("negative")
                if not positive_event or not negative_event:
                    continue
                named_evdev.add_abs_axis_event(
                    str(axis_name),
                    str(positive_event),
                    str(negative_event),
                    touch_key=str(axis_config.get("touch_key", "BTN_TOUCH")),
                    min_delta=int(axis_config.get("min_delta", 500)),
                )
        inputs.append(named_evdev)
    if passthrough_named_evdev_queries and isinstance(passthrough_key_state_events, dict):
        passthrough_evdev = EvdevInput(
            passthrough_named_evdev_paths,
            grab_evdev,
            runner.emit,
            passthrough_unmapped=runner.passthrough_key,
            path_resolver=lambda queries=passthrough_named_evdev_queries: find_evdev_by_name(queries),
        )
        for key_name, event_prefix in passthrough_key_state_events.items():
            passthrough_evdev.add_key_state_events(str(key_name), f"{event_prefix}.press", f"{event_prefix}.release")
        inputs.append(passthrough_evdev)
    if raw_paths:
        inputs.append(RawHidInput(raw_paths, make_raw_config(config.get("raw_hid", {})), buttons[1], runner.emit))
    elif "knob2_hidraw" in devices:
        log("warning: no knob2 hidraw devices matched")
    raw_report_map = config.get("raw_report_map", {})
    if raw_report_paths and isinstance(raw_report_map, dict):
        inputs.append(RawReportInput(raw_report_paths, {str(k): str(v) for k, v in raw_report_map.items()}, runner.emit))
    elif "raw_report_hidraw" in devices:
        log("warning: no raw-report hidraw devices matched")
    return inputs, buttons


def run_service(config: dict[str, Any], dry_run: bool = False) -> int:
    set_parent_death_signal()
    actions = config.get("actions", {})
    runner = ActionRunner(actions, dry_run=dry_run)
    runner.emergency_release_keys("startup")
    runner.open_virtual_keyboard()
    inputs, buttons = build_inputs(config, runner)
    stop = False

    def stop_signal(_signum: int, _frame: Any) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, stop_signal)
    signal.signal(signal.SIGTERM, stop_signal)
    try:
        for item in inputs:
            item.open()
        log("knob mapper started")
        while not stop:
            fds = [fd for item in inputs for fd in item.fds]
            ready = wait_for_ready_fds(fds)
            for fd in ready:
                for item in inputs:
                    if fd in item.fds:
                        item.read_ready(fd)
                        break
            for item in inputs:
                tick = getattr(item, "tick", None)
                if tick:
                    tick()
            for button in buttons:
                button.tick()
            runner.tick()
    finally:
        for item in inputs:
            item.close()
        runner.cleanup()
        log("knob mapper stopped")
    return 0


def list_devices(config: dict[str, Any]) -> int:
    devices = config.get("devices", {})
    for name, patterns in devices.items():
        if not isinstance(patterns, list):
            continue
        matches = (
            find_evdev_by_name([str(pattern) for pattern in patterns])
            if name in {"named_evdev", "passthrough_named_evdev"}
            else expand_globs(patterns)
        )
        print(f"{name}:")
        if not matches:
            print("  (no matches)")
        for match in matches:
            print(f"  {match} -> {os.path.realpath(match)}")
    return 0


def calibrate_second_knob(config: dict[str, Any]) -> int:
    configured_raw_paths = expand_globs(config.get("devices", {}).get("knob2_hidraw", []))
    raw_paths = sorted({*configured_raw_paths, *glob.glob("/dev/hidraw*")})
    if not raw_paths:
        print("No hidraw devices found.", file=sys.stderr)
        return 2
    raw_config = make_raw_config(config.get("raw_hid", {}))
    bursts: list[tuple[str, int, int, int]] = []
    report_counts: dict[str, int] = {}
    report_samples: list[tuple[str, str]] = []
    raw_bursts: dict[str, RawBurst] = {}
    evdev_counts: Counter[tuple[str, str, str, str, int]] = Counter()
    evdev_samples: list[tuple[str, str, str, str, int]] = []
    raw_fds: dict[int, str] = {}
    evdev_fds: dict[int, tuple[str, str]] = {}
    names = input_device_names()
    try:
        for path in raw_paths:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                print(f"SKIP hidraw {path}: {exc}")
                continue
            raw_fds[fd] = path
            raw_bursts[path] = RawBurst()
            marker = "configured" if path in configured_raw_paths else "scan"
            print(f"LISTEN hidraw {path} -> {os.path.realpath(path)} ({marker})")
        for path, label in sorted(names.items()):
            if any(skip in label for skip in ("Power Button", "Video Bus", "HD-Audio")):
                continue
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                print(f"SKIP evdev {path} {label}: {exc}")
                continue
            evdev_fds[fd] = (path, label)
            print(f"LISTEN evdev {path} {label}")
        print("Rotate the second knob clockwise several ticks, pause, then counter-clockwise several ticks.")
        print("Sampling 20 seconds...")
        end = now() + 20
        while now() < end:
            for path, current in raw_bursts.items():
                if current.count and now() - current.updated_at >= raw_config.burst_gap_seconds:
                    bursts.append((path, current.dx, current.dy, current.count))
                    current.clear()
            all_fds = list(raw_fds) + list(evdev_fds)
            if not all_fds:
                time.sleep(0.05)
                continue
            ready, _, _ = select.select(all_fds, [], [], 0.05)
            for fd in ready:
                if fd in raw_fds:
                    while True:
                        try:
                            data = os.read(fd, 64)
                        except BlockingIOError:
                            break
                        path = raw_fds[fd]
                        report_counts[path] = report_counts.get(path, 0) + 1
                        if len(report_samples) < 40:
                            report_samples.append((path, data.hex(" ")))
                        if len(data) < 6 or data[0] != raw_config.report_id:
                            continue
                        dx = signed_i16(data[2], data[3])
                        dy = signed_i16(data[4], data[5])
                        if dx or dy:
                            raw_bursts[path].add(dx, dy)
                elif fd in evdev_fds:
                    while True:
                        try:
                            data = os.read(fd, INPUT_EVENT.size)
                        except BlockingIOError:
                            break
                        if len(data) < INPUT_EVENT.size:
                            break
                        _sec, _usec, event_type, code, value = INPUT_EVENT.unpack(data)
                        if event_type == 0:
                            continue
                        path, label = evdev_fds[fd]
                        if event_type == EV_KEY:
                            event_type_name = "KEY"
                            code_name = KEY_CODES.get(code, f"KEY_{code}")
                        elif event_type == EV_REL:
                            event_type_name = "REL"
                            code_name = REL_CODES.get(code, f"REL_{code}")
                        else:
                            event_type_name = f"EV_{event_type}"
                            code_name = f"CODE_{code}"
                        evdev_counts[(path, label, event_type_name, code_name, value)] += 1
                        if len(evdev_samples) < 80:
                            evdev_samples.append((path, label, event_type_name, code_name, value))
        for path, current in raw_bursts.items():
            if current.count:
                bursts.append((path, current.dx, current.dy, current.count))
    finally:
        for fd in list(raw_fds) + list(evdev_fds):
            os.close(fd)
    print("BURSTS")
    for index, (path, dx, dy, count) in enumerate(bursts, 1):
        print(f"  {index:02d}: {path} dx={dx:5d} dy={dy:5d} reports={count:3d} magnitude={math.hypot(dx, dy):.1f}")
    if not bursts:
        print("  (none)")
    print("RAW_REPORT_COUNTS")
    if report_counts:
        for path, count in sorted(report_counts.items()):
            print(f"  {path}: {count}")
    else:
        print("  (none)")
    if report_samples:
        print("RAW_REPORT_SAMPLES")
        for path, hex_report in report_samples:
            print(f"  {path}: {hex_report}")
    print("EVDEV_EVENT_COUNTS")
    if evdev_counts:
        for (path, label, event_type_name, code_name, value), count in evdev_counts.most_common(80):
            print(f"  {count:4d} {path} {label} {event_type_name} {code_name} value={value}")
    else:
        print("  (none)")
    if evdev_samples:
        print("EVDEV_EVENT_SAMPLES")
        for path, label, event_type_name, code_name, value in evdev_samples:
            print(f"  {path} {label} {event_type_name} {code_name} value={value}")
    print("Pick representative clockwise/counter-clockwise bursts and put them in config.yaml as:")
    print("  clockwise_vector: [DX, DY]")
    print("  counterclockwise_vector: [DX, DY]")
    return 0


def calibrate_keys() -> int:
    names = input_device_names()
    fds: dict[int, tuple[str, str]] = {}
    try:
        for path, label in sorted(names.items()):
            if any(skip in label for skip in ("Power Button", "Video Bus", "HD-Audio")):
                continue
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                print(f"SKIP {path} {label}: {exc}")
                continue
            fds[fd] = (path, label)
            print(f"LISTEN {path} {label}")
        print("Waiting 1 second to ignore the Enter key used to start this command...")
        time.sleep(1)
        for fd in fds:
            while True:
                try:
                    if len(os.read(fd, INPUT_EVENT.size)) < INPUT_EVENT.size:
                        break
                except BlockingIOError:
                    break
        print("READY: operate the target knob/button for 15 seconds.")
        end = now() + 15
        counts: Counter[tuple[str, str, str, int]] = Counter()
        samples: list[tuple[str, str, str, int]] = []
        while now() < end:
            ready, _, _ = select.select(list(fds), [], [], 0.1)
            for fd in ready:
                while True:
                    try:
                        data = os.read(fd, INPUT_EVENT.size)
                    except BlockingIOError:
                        break
                    if len(data) < INPUT_EVENT.size:
                        break
                    _sec, _usec, event_type, code, value = INPUT_EVENT.unpack(data)
                    if event_type == 0:
                        continue
                    path, label = fds[fd]
                    if event_type == EV_KEY:
                        code_name = KEY_CODES.get(code, f"KEY_{code}")
                        kind = "KEY"
                    elif event_type == EV_REL:
                        code_name = REL_CODES.get(code, f"REL_{code}")
                        kind = "REL"
                    else:
                        code_name = f"CODE_{code}"
                        kind = f"EV_{event_type}"
                    counts[(path, label, f"{kind} {code_name}", value)] += 1
                    if len(samples) < 120:
                        samples.append((path, label, f"{kind} {code_name}", value))
    finally:
        for fd in fds:
            os.close(fd)
    print("EVENT_COUNTS")
    if not counts:
        print("  (none)")
    for (path, label, name, value), count in counts.most_common(120):
        print(f"  {count:4d} {path} {label} {name} value={value}")
    if samples:
        print("EVENT_SAMPLES")
        for path, label, name, value in samples:
            print(f"  {path} {label} {name} value={value}")
    return 0


def trace_button(config: dict[str, Any], button_name: str) -> int:
    devices = config.get("devices", {})
    if button_name == "button1":
        key_name = str(devices.get("button1_key", "KEY_MUTE"))
    elif button_name == "button2":
        key_name = str(devices.get("button2_key", ""))
        if not key_name:
            print("button2_key is not configured in config.yaml", file=sys.stderr)
            return 2
    else:
        print(f"unsupported button: {button_name}", file=sys.stderr)
        return 2

    paths = expand_globs(devices.get("knob1_evdev", []) + devices.get("knob2_evdev", []))
    if not paths:
        print("No configured evdev paths matched.", file=sys.stderr)
        return 2

    fds: dict[int, str] = {}
    state_pressed = False
    pressed_at = 0.0
    events: list[tuple[float, str, str, int]] = []
    try:
        for path in sorted(set(paths)):
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                print(f"SKIP {path}: {exc}")
                continue
            fds[fd] = path
            print(f"LISTEN {path} -> {os.path.realpath(path)}")
        if not fds:
            print("No readable evdev devices.", file=sys.stderr)
            return 2

        print("Waiting 1 second to ignore the Enter key used to start this command...")
        time.sleep(1)
        for fd in fds:
            while True:
                try:
                    if len(os.read(fd, INPUT_EVENT.size)) < INPUT_EVENT.size:
                        break
                except BlockingIOError:
                    break

        print(f"READY: perform ONE full {button_name} long-press cycle: press, keep holding, release. Sampling 12 seconds.")
        started = now()
        previous = started
        end = started + 12
        while now() < end:
            ready, _, _ = select.select(list(fds), [], [], 0.05)
            t = now()
            if state_pressed:
                print(f"+{t - started:8.3f}s state={button_name}.pressed elapsed={t - pressed_at:.3f}s", flush=True)
            for fd in ready:
                while True:
                    try:
                        data = os.read(fd, INPUT_EVENT.size)
                    except BlockingIOError:
                        break
                    if len(data) < INPUT_EVENT.size:
                        break
                    _sec, _usec, event_type, code, value = INPUT_EVENT.unpack(data)
                    if event_type == 0:
                        continue
                    t = now()
                    dt = t - previous
                    previous = t
                    if event_type == EV_KEY:
                        code_name = KEY_CODES.get(code, f"KEY_{code}")
                        kind = "KEY"
                    elif event_type == EV_REL:
                        code_name = REL_CODES.get(code, f"REL_{code}")
                        kind = "REL"
                    else:
                        code_name = f"CODE_{code}"
                        kind = f"EV_{event_type}"
                    path = fds[fd]
                    print(f"+{t - started:8.3f}s dt={dt:7.3f}s {path} {kind} {code_name} value={value}", flush=True)
                    events.append((t - started, kind, code_name, value))
                    if kind == "KEY" and code_name == key_name:
                        if value == 1:
                            state_pressed = True
                            pressed_at = t
                            print(f"+{t - started:8.3f}s NORMALIZED {button_name}.press", flush=True)
                        elif value == 0:
                            duration = t - pressed_at if state_pressed else 0.0
                            state_pressed = False
                            print(f"+{t - started:8.3f}s NORMALIZED {button_name}.release duration={duration:.3f}s", flush=True)
                        elif value == 2:
                            print(f"+{t - started:8.3f}s NORMALIZED {button_name}.repeat", flush=True)
    finally:
        for fd in fds:
            os.close(fd)

    target_events = [event for event in events if event[1] == "KEY" and event[2] == key_name]
    print("SUMMARY")
    print(f"  target_key: {key_name}")
    print(f"  target_events: {len(target_events)}")
    for elapsed, _kind, _code_name, value in target_events:
        label = {0: "release", 1: "press", 2: "repeat"}.get(value, str(value))
        print(f"  +{elapsed:.3f}s {label}")
    return 0


def trace_hold_raw(config: dict[str, Any]) -> int:
    devices = config.get("devices", {})
    evdev_paths = expand_globs(devices.get("knob1_evdev", []) + devices.get("knob2_evdev", []))
    hidraw_paths = sorted(glob.glob("/dev/hidraw*"))
    evdev_fds: dict[int, str] = {}
    hidraw_fds: dict[int, str] = {}
    last_raw: dict[str, bytes] = {}
    try:
        for path in sorted(set(evdev_paths)):
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                print(f"SKIP evdev {path}: {exc}")
                continue
            evdev_fds[fd] = path
            print(f"LISTEN evdev {path} -> {os.path.realpath(path)}")
        for path in hidraw_paths:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                print(f"SKIP hidraw {path}: {exc}")
                continue
            hidraw_fds[fd] = path
            print(f"LISTEN hidraw {path} -> {os.path.realpath(path)}")
        print("Waiting 1 second to ignore startup noise...")
        time.sleep(1)
        for fd in list(evdev_fds):
            while True:
                try:
                    if len(os.read(fd, INPUT_EVENT.size)) < INPUT_EVENT.size:
                        break
                except BlockingIOError:
                    break
        for fd in list(hidraw_fds):
            while True:
                try:
                    if not os.read(fd, 64):
                        break
                except BlockingIOError:
                    break

        print("READY: press and hold the button for ~3 seconds, then release. Sampling 8 seconds.")
        started = now()
        end = started + 8
        while now() < end:
            all_fds = list(evdev_fds) + list(hidraw_fds)
            ready, _, _ = select.select(all_fds, [], [], 0.05)
            t = now()
            for fd in ready:
                if fd in evdev_fds:
                    while True:
                        try:
                            data = os.read(fd, INPUT_EVENT.size)
                        except BlockingIOError:
                            break
                        if len(data) < INPUT_EVENT.size:
                            break
                        _sec, _usec, event_type, code, value = INPUT_EVENT.unpack(data)
                        if event_type == 0:
                            continue
                        if event_type == EV_KEY:
                            kind = "KEY"
                            code_name = KEY_CODES.get(code, f"KEY_{code}")
                        elif event_type == EV_REL:
                            kind = "REL"
                            code_name = REL_CODES.get(code, f"REL_{code}")
                        else:
                            kind = f"EV_{event_type}"
                            code_name = f"CODE_{code}"
                        print(f"+{t - started:7.3f}s evdev {evdev_fds[fd]} {kind} {code_name} value={value}", flush=True)
                else:
                    while True:
                        try:
                            data = os.read(fd, 64)
                        except BlockingIOError:
                            break
                        if not data:
                            break
                        path = hidraw_fds[fd]
                        changed = last_raw.get(path) != data
                        last_raw[path] = data
                        marker = "changed" if changed else "same"
                        print(f"+{t - started:7.3f}s hidraw {path} {marker} {data.hex(' ')}", flush=True)
    finally:
        for fd in list(evdev_fds) + list(hidraw_fds):
            os.close(fd)
    return 0


def trace_chord(config: dict[str, Any], target: str = "all") -> int:
    names = input_device_names()
    fds: dict[int, tuple[str, str]] = {}
    events: list[tuple[float, str, str, str, int]] = []
    devices = config.get("devices", {})
    configured_keys = {
        str(devices.get("knob1_cw_key", "KEY_VOLUMEUP")),
        str(devices.get("knob1_ccw_key", "KEY_VOLUMEDOWN")),
        str(devices.get("knob2_cw_key", "KEY_2")),
        str(devices.get("knob2_ccw_key", "KEY_1")),
        str(devices.get("knob1_chord_cw_key", "KEY_NEXTSONG")),
        str(devices.get("knob1_chord_ccw_key", "KEY_PREVIOUSSONG")),
        str(devices.get("button1_key", "KEY_MUTE")),
    }
    try:
        for path, label in sorted(names.items()):
            if any(skip in label for skip in ("Power Button", "Video Bus", "HD-Audio")):
                continue
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                print(f"SKIP {path} {label}: {exc}")
                continue
            fds[fd] = (path, label)
            print(f"LISTEN {path} {label}")
        print("Waiting 1 second to ignore startup noise...")
        time.sleep(1)
        for fd in fds:
            while True:
                try:
                    if len(os.read(fd, INPUT_EVENT.size)) < INPUT_EVENT.size:
                        break
                except BlockingIOError:
                    break
        if target == "second-knob":
            print("READY: hold the target button, rotate ONLY the second knob both directions, then release. Sampling 15 seconds.")
        else:
            print("READY: hold the target button, rotate knobs, then release the button. Sampling 15 seconds.")
        started = now()
        end = started + 15
        while now() < end:
            ready, _, _ = select.select(list(fds), [], [], 0.1)
            for fd in ready:
                while True:
                    try:
                        data = os.read(fd, INPUT_EVENT.size)
                    except BlockingIOError:
                        break
                    if len(data) < INPUT_EVENT.size:
                        break
                    _sec, _usec, event_type, code, value = INPUT_EVENT.unpack(data)
                    if event_type == 0:
                        continue
                    path, label = fds[fd]
                    if event_type == EV_KEY:
                        kind = "KEY"
                        code_name = KEY_CODES.get(code, f"KEY_{code}")
                    elif event_type == EV_REL:
                        kind = "REL"
                        code_name = REL_CODES.get(code, f"REL_{code}")
                    else:
                        kind = f"EV_{event_type}"
                        code_name = f"CODE_{code}"
                    elapsed = now() - started
                    events.append((elapsed, label, kind, code_name, value))
                    print(f"+{elapsed:7.3f}s {path} {label} {kind} {code_name} value={value}", flush=True)
    finally:
        for fd in fds:
            os.close(fd)

    counts: Counter[tuple[str, str, str, int]] = Counter((label, kind, code_name, value) for _elapsed, label, kind, code_name, value in events)
    print("SUMMARY_COUNTS")
    if not counts:
        print("  (none)")
    for (label, kind, code_name, value), count in counts.most_common(100):
        print(f"  {count:4d} {label} {kind} {code_name} value={value}")
    candidates = Counter(
        (label, code_name, value)
        for _elapsed, label, kind, code_name, value in events
        if kind == "KEY" and code_name not in configured_keys
    )
    print("CANDIDATE_UNCONFIGURED_KEYS")
    if not candidates:
        print("  (none)")
    for (label, code_name, value), count in candidates.most_common(50):
        print(f"  {count:4d} {label} KEY {code_name} value={value}")
    if target == "second-knob":
        print("If the two directions are visible above, add them to config.yaml as:")
        print("  knob2_chord_cw_key: KEY_...")
        print("  knob2_chord_ccw_key: KEY_...")
    print("SUMMARY_TIMELINE")
    for elapsed, label, kind, code_name, value in events:
        print(f"  +{elapsed:.3f}s {label} {kind} {code_name} value={value}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Map a two-knob HID controller to X11 shortcuts.")
    parser.add_argument("--config", default=str(Path(__file__).with_name("config.yaml")))
    parser.add_argument("--dry-run", action="store_true", help="Log actions without sending xdotool shortcuts.")
    parser.add_argument("--list-devices", action="store_true", help="Show configured device glob matches.")
    parser.add_argument("--calibrate", choices=["second-knob", "keys"], help="Run an interactive calibration helper.")
    parser.add_argument("--trace-button", choices=["button1", "button2"], help="Trace one full button press cycle with raw timing.")
    parser.add_argument("--trace-hold-raw", action="store_true", help="Trace evdev and hidraw while physically holding a button.")
    parser.add_argument("--trace-chord", action="store_true", help="Trace button-held knob rotations across all evdev devices.")
    parser.add_argument("--trace-second-knob-chord", action="store_true", help="Trace button-held second-knob rotations and summarize unconfigured key candidates.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config(Path(args.config))
    if args.list_devices:
        return list_devices(config)
    if args.calibrate == "second-knob":
        return calibrate_second_knob(config)
    if args.calibrate == "keys":
        return calibrate_keys()
    if args.trace_button:
        return trace_button(config, args.trace_button)
    if args.trace_hold_raw:
        return trace_hold_raw(config)
    if args.trace_chord:
        return trace_chord(config)
    if args.trace_second_knob_chord:
        return trace_chord(config, target="second-knob")
    return run_service(config, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
