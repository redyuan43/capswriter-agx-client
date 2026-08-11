#!/usr/bin/env python3
"""Minimal Linux uinput keyboard backend for Cardputer Wi-Fi reports."""

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
EV_REP = 0x14
SYN_REPORT = 0
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

INPUT_EVENT = struct.Struct("@llHHi")
UINPUT_SETUP = struct.Struct("@HHHH80sI")


class UInputKeyboard:
    def __init__(self):
        self.fd = None
        self.current = []

    def open(self):
        self.fd = os.open(UINPUT_PATH, os.O_WRONLY | os.O_NONBLOCK)
        for event_type in (EV_KEY, EV_REP):
            fcntl.ioctl(self.fd, UI_SET_EVBIT, event_type)
        for key_code in range(1, 256):
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, key_code)
        name = b"VibeStick Cardputer Keyboard"
        setup = UINPUT_SETUP.pack(
            BUS_USB,
            0x303A,
            0x4001,
            1,
            name.ljust(UINPUT_MAX_NAME_SIZE, b"\0"),
            0,
        )
        fcntl.ioctl(self.fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)
        time.sleep(0.1)

    def _emit(self, event_type, code, value):
        os.write(self.fd, INPUT_EVENT.pack(0, 0, event_type, code, value))

    def report(self, desired):
        desired = list(dict.fromkeys(desired))
        desired_set = set(desired)
        current_set = set(self.current)
        for code in reversed(self.current):
            if code not in desired_set:
                self._emit(EV_KEY, code, 0)
        for code in desired:
            if code not in current_set:
                self._emit(EV_KEY, code, 1)
        if desired != self.current:
            self._emit(EV_SYN, SYN_REPORT, 0)
        self.current = desired

    def release_all(self):
        self.report([])

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


def main():
    keyboard = UInputKeyboard()
    keyboard.open()
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
                codes = command.get("codes", [])
                if not isinstance(codes, list) or len(codes) > 14:
                    raise ValueError("invalid key report")
                normalized = []
                for code in codes:
                    if not isinstance(code, int) or code < 1 or code > 255:
                        raise ValueError("invalid Linux key code")
                    normalized.append(code)
                keyboard.report(normalized)
            elif command_type == "release_all":
                keyboard.release_all()
            elif command_type == "stop":
                break
            else:
                raise ValueError("unknown command")
    finally:
        keyboard.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ready": False, "error": str(error)}), file=sys.stderr, flush=True)
        raise
