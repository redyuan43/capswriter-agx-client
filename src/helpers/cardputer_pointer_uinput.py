#!/usr/bin/env python3
"""Minimal Linux uinput pointer backend for Cardputer Wi-Fi reports."""

import fcntl
import json
import os
import signal
import struct
import sys
import time


UINPUT_PATH = "/dev/uinput"
UINPUT_IOCTL_BASE = ord("U")
EV_SYN = 0x00
EV_KEY = 0x01
EV_REL = 0x02
SYN_REPORT = 0
REL_X = 0x00
REL_Y = 0x01
REL_WHEEL = 0x08
BTN_LEFT = 0x110
BTN_RIGHT = 0x111
BTN_MIDDLE = 0x112
BTN_SIDE = 0x113
BTN_EXTRA = 0x114
BUS_USB = 0x03
UINPUT_MAX_NAME_SIZE = 80

_IOC_NRBITS = 8
_IOC_TYPEBITS = 8
_IOC_SIZEBITS = 14
_IOC_NRSHIFT = 0
_IOC_TYPESHIFT = _IOC_NRSHIFT + _IOC_NRBITS
_IOC_SIZESHIFT = _IOC_TYPESHIFT + _IOC_TYPEBITS
_IOC_DIRSHIFT = _IOC_SIZESHIFT + _IOC_SIZEBITS
_IOC_NONE = 0
_IOC_WRITE = 1


def _ioc(direction, ioctl_type, number, size):
    return (
        (direction << _IOC_DIRSHIFT)
        | (ioctl_type << _IOC_TYPESHIFT)
        | (number << _IOC_NRSHIFT)
        | (size << _IOC_SIZESHIFT)
    )


def _io(ioctl_type, number):
    return _ioc(_IOC_NONE, ioctl_type, number, 0)


def _iow(ioctl_type, number, size):
    return _ioc(_IOC_WRITE, ioctl_type, number, size)


UI_DEV_CREATE = _io(UINPUT_IOCTL_BASE, 1)
UI_DEV_DESTROY = _io(UINPUT_IOCTL_BASE, 2)
UI_DEV_SETUP = _iow(UINPUT_IOCTL_BASE, 3, 92)
UI_SET_EVBIT = _iow(UINPUT_IOCTL_BASE, 100, struct.calcsize("i"))
UI_SET_KEYBIT = _iow(UINPUT_IOCTL_BASE, 101, struct.calcsize("i"))
UI_SET_RELBIT = _iow(UINPUT_IOCTL_BASE, 102, struct.calcsize("i"))

INPUT_EVENT = struct.Struct("@llHHi")
UINPUT_SETUP = struct.Struct("@HHHH80sI")


class UInputPointer:
    def __init__(self):
        self.fd = None
        self.buttons = 0

    def open(self):
        self.fd = os.open(UINPUT_PATH, os.O_WRONLY | os.O_NONBLOCK)
        for event_type in (EV_KEY, EV_REL):
            fcntl.ioctl(self.fd, UI_SET_EVBIT, event_type)
        for key_code in (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA):
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, key_code)
        for relative_axis in (REL_X, REL_Y, REL_WHEEL):
            fcntl.ioctl(self.fd, UI_SET_RELBIT, relative_axis)
        name = b"VibeStick Cardputer Pointer"
        setup = UINPUT_SETUP.pack(
            BUS_USB,
            0x303A,
            0x4002,
            1,
            name.ljust(UINPUT_MAX_NAME_SIZE, b"\0"),
            0,
        )
        fcntl.ioctl(self.fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)
        time.sleep(0.1)

    def _emit(self, event_type, code, value):
        os.write(self.fd, INPUT_EVENT.pack(0, 0, event_type, code, value))

    def report(self, dx, dy, wheel, buttons):
        changed = False
        for mask, code in (
            (1, BTN_LEFT),
            (2, BTN_RIGHT),
            (4, BTN_MIDDLE),
            (8, BTN_SIDE),
            (16, BTN_EXTRA),
        ):
            previous = bool(self.buttons & mask)
            desired = bool(buttons & mask)
            if previous != desired:
                self._emit(EV_KEY, code, 1 if desired else 0)
                changed = True
        for axis, value in ((REL_X, dx), (REL_Y, dy), (REL_WHEEL, wheel)):
            if value:
                self._emit(EV_REL, axis, value)
                changed = True
        if changed:
            self._emit(EV_SYN, SYN_REPORT, 0)
        self.buttons = buttons

    def release_all(self):
        self.report(0, 0, 0, 0)

    def close(self):
        if self.fd is None:
            return
        try:
            self.release_all()
        finally:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY)
            finally:
                os.close(self.fd)
                self.fd = None


def _integer(command, key, minimum, maximum):
    value = command.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"invalid {key}")
    if value < minimum or value > maximum:
        raise ValueError(f"invalid {key}")
    return value


def main():
    pointer = UInputPointer()
    pointer.open()
    print(json.dumps({"ready": True, "backend": "uinput"}), flush=True)

    def stop(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for line in sys.stdin:
            command = json.loads(line)
            command_type = command.get("type")
            if command_type == "report":
                pointer.report(
                    _integer(command, "dx", -2048, 2048),
                    _integer(command, "dy", -2048, 2048),
                    _integer(command, "wheel", -32, 32),
                    _integer(command, "buttons", 0, 31),
                )
            elif command_type == "release_all":
                pointer.release_all()
            elif command_type == "stop":
                break
            else:
                raise ValueError("unknown command")
    finally:
        pointer.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ready": False, "error": str(error)}), file=sys.stderr, flush=True)
        raise
