import time
from pathlib import Path

import yaml

from knob_mapper import (
    ActionRunner,
    ButtonState,
    EvdevInput,
    HoldTapKeyState,
    RawHidConfig,
    RawHidInput,
    RawReportInput,
    ReleasePulseButtonState,
    build_inputs,
    normalize_chord,
    parse_uinput_key,
    shortcut_for_xdotool,
    wait_for_ready_fds,
)


def test_config_maps_single_knob_button_press_to_return():
    config_path = Path(__file__).resolve().parent / "config.yaml"
    config = yaml.safe_load(config_path.read_text())

    assert config["devices"]["button1_mode"] == "release_pulse"
    assert config["actions"]["button1.release_pulse"] == {"hotkey": "Return"}


def test_config_maps_iine_space_to_right_shift():
    config_path = Path(__file__).resolve().parent / "config.yaml"
    config = yaml.safe_load(config_path.read_text())

    assert "IINE_keyboard" not in config["devices"]["named_evdev"]
    assert "IINE_keyboard" in config["devices"]["passthrough_named_evdev"]
    assert config["passthrough_key_state_events"]["KEY_SPACE"] == "iine.right_shift"
    assert config["actions"]["iine.right_shift.press"] == {"uinput_key_down": "KEY_RIGHTSHIFT"}
    assert config["actions"]["iine.right_shift.release"] == {"uinput_key_up": "KEY_RIGHTSHIFT"}


def test_config_keeps_ulanzi_and_mini_keyboard_inputs():
    config_path = Path(__file__).resolve().parent / "config.yaml"
    config = yaml.safe_load(config_path.read_text())

    assert config["devices"]["named_evdev"] == ["Ulanzi Dial Keyboard", "MINI_KEYBOARD"]
    assert config["abs_axis_events"]["ABS_Y"]["positive"] == "knob2.ccw"
    assert config["abs_axis_events"]["ABS_Y"]["negative"] == "knob2.cw"


def test_shortcut_aliases():
    assert shortcut_for_xdotool("Ctrl+Alt+Right") == "ctrl+alt+Right"
    assert shortcut_for_xdotool("cmd+shift+p") == "Super+shift+p"


def test_parse_uinput_key_accepts_short_and_kernel_names():
    assert parse_uinput_key("F13") == parse_uinput_key("KEY_F13")


def test_normalize_chord_orders_modifiers_first():
    assert normalize_chord(["KEY_Z", "KEY_LEFTMETA", "KEY_LEFTSHIFT"]) == "KEY_LEFTSHIFT+KEY_LEFTMETA+KEY_Z"


def test_evdev_input_maps_chord_reports():
    events = []
    evdev = EvdevInput(
        [],
        False,
        lambda name, payload=None: events.append((name, payload or {})),
        chord_to_event={"KEY_LEFTMETA+KEY_C": "ulanzi.copy.press"},
    )
    evdev.pending_key_events = [("KEY_LEFTMETA", 1), ("KEY_C", 1)]
    evdev.handle_key_report()
    assert events == [("ulanzi.copy.press", {"source": "KEY_LEFTMETA+KEY_C"})]


def test_evdev_input_maps_chord_across_reports():
    events = []
    evdev = EvdevInput(
        [],
        False,
        lambda name, payload=None: events.append((name, payload or {})),
        chord_to_event={"KEY_LEFTMETA+KEY_C": "ulanzi.copy.press"},
    )
    evdev.pending_key_events = [("KEY_LEFTMETA", 1)]
    evdev.handle_key_report()
    evdev.pending_key_events = [("KEY_C", 1)]
    evdev.handle_key_report()
    evdev.pending_key_events = [("KEY_C", 0), ("KEY_LEFTMETA", 0)]
    evdev.handle_key_report()
    assert events == [("ulanzi.copy.press", {"source": "KEY_LEFTMETA+KEY_C"})]


def test_evdev_input_passthroughs_only_unmapped_keys():
    events = []
    passthrough = []
    evdev = EvdevInput(
        [],
        False,
        lambda name, payload=None: events.append((name, payload or {})),
        passthrough_unmapped=lambda key_name, value: passthrough.append((key_name, value)),
    )
    evdev.add_key_state_events("KEY_SPACE", "iine.right_shift.press", "iine.right_shift.release")

    evdev.handle_key_event("KEY_A", 1)
    evdev.handle_key_event("KEY_A", 2)
    evdev.handle_key_event("KEY_A", 0)
    evdev.handle_key_event("KEY_SPACE", 1)
    evdev.handle_key_event("KEY_SPACE", 2)
    evdev.handle_key_event("KEY_SPACE", 0)

    assert passthrough == [("KEY_A", 1), ("KEY_A", 2), ("KEY_A", 0)]
    assert [name for name, _payload in events] == ["iine.right_shift.press", "iine.right_shift.release"]


def test_evdev_input_closes_fd_on_read_error(monkeypatch):
    evdev = EvdevInput([], False, lambda _name, payload=None: None)
    evdev.fds[123456] = "/dev/input/eventX"

    def fail_read(_fd, _size):
        raise OSError(19, "No such device")

    monkeypatch.setattr("knob_mapper.os.read", fail_read)
    evdev.read_ready(123456)
    assert evdev.fds == {}


def test_evdev_input_releases_mapped_keys_when_device_disconnects():
    events = []
    evdev = EvdevInput([], False, lambda name, payload=None: events.append((name, payload or {})))
    evdev.add_key_state_events("KEY_SPACE", "iine.right_shift.press", "iine.right_shift.release")
    evdev.handle_key_event("KEY_SPACE", 1)

    evdev.release_pressed_keys("read_error")

    assert events == [
        ("iine.right_shift.press", {"source": "KEY_SPACE", "state": "pressed"}),
        ("iine.right_shift.release", {"source": "KEY_SPACE", "state": "released", "reason": "read_error"}),
    ]


def test_evdev_input_releases_button_keys_when_device_disconnects():
    events = []
    evdev = EvdevInput(
        [],
        False,
        lambda name, payload=None: events.append((name, payload or {})),
        passthrough_unmapped=lambda key_name, value: events.append(
            ("passthrough", {"key": key_name, "value": value})
        ),
    )
    evdev.add_button_key(
        "KEY_K",
        HoldTapKeyState(
            "doio.return",
            0.01,
            lambda name, payload=None: events.append((name, payload or {})),
        ),
    )
    evdev.handle_key_event("KEY_K", 1)
    time.sleep(0.02)
    evdev.tick()

    evdev.release_pressed_keys("read_error")

    assert [name for name, _payload in events] == ["doio.return.hold", "doio.return.hold_release"]


def test_evdev_input_reconnects_named_device(monkeypatch):
    opened = []
    resolver_calls = []
    paths_by_call = [[], ["/dev/input/event42"]]

    def resolve_paths():
        index = min(len(resolver_calls), len(paths_by_call) - 1)
        resolver_calls.append(index)
        return paths_by_call[index]

    evdev = EvdevInput(
        [],
        False,
        lambda _name, payload=None: None,
        path_resolver=resolve_paths,
        reconnect_seconds=0,
    )

    def fake_open(path, _flags):
        opened.append(path)
        return 42

    monkeypatch.setattr("knob_mapper.os.open", fake_open)
    monkeypatch.setattr("knob_mapper.os.path.realpath", lambda path: path)

    evdev.tick()
    evdev.tick()

    assert evdev.paths == ["/dev/input/event42"]
    assert opened == ["/dev/input/event42"]
    assert evdev.fds == {42: "/dev/input/event42"}


def test_button_hold_once():
    events = []

    def emit(name, payload=None):
        events.append(name)

    button = ButtonState("button1", 0.01, emit)
    button.set_pressed(True)
    time.sleep(0.02)
    button.tick()
    button.tick()
    button.set_pressed(False)
    assert events == ["button1.press", "button1.hold", "button1.hold_release", "button1.release"]


def test_release_pulse_button_emits_release_pulse():
    events = []

    def emit(name, payload=None):
        events.append((name, payload or {}))

    button = ReleasePulseButtonState("button1", emit)
    button.set_pressed(True)
    button.set_pressed(False)
    assert events[0][0] == "button1.pulse_start"
    assert events[1][0] == "button1.release_pulse"
    assert events[1][1]["state"] == "release_pulse"


def test_hold_tap_key_emits_tap_only_after_short_release():
    events = []

    def emit(name, payload=None):
        events.append((name, payload or {}))

    button = HoldTapKeyState("ulanzi.playpause", 1.0, emit)
    button.set_pressed(True)
    button.set_pressed(False)
    assert [name for name, _payload in events] == ["ulanzi.playpause.tap"]
    assert events[0][1]["state"] == "tapped"


def test_hold_tap_key_emits_hold_and_hold_release():
    events = []

    def emit(name, payload=None):
        events.append(name)

    button = HoldTapKeyState("ulanzi.playpause", 0.01, emit)
    button.set_pressed(True)
    time.sleep(0.02)
    button.tick()
    button.tick()
    button.set_pressed(False)
    assert events == ["ulanzi.playpause.hold", "ulanzi.playpause.hold_release"]


def test_raw_hid_classifies_vectors():
    events = []
    button = ButtonState("button2", 1.0, lambda name, payload=None: events.append(name))
    raw = RawHidInput([], RawHidConfig(min_reports=1, min_magnitude=1), button, lambda name, payload=None: events.append(name))
    raw.handle_report(bytes([1, 0, 10, 0, 0xF6, 0xFF, 0, 0]))
    raw.flush_burst()
    raw.handle_report(bytes([1, 0, 0xF6, 0xFF, 10, 0, 0, 0]))
    raw.flush_burst()
    assert events == ["knob2.cw", "knob2.ccw"]


def test_raw_hid_closes_fd_after_end_of_file(monkeypatch):
    raw = RawHidInput([], RawHidConfig(), ButtonState("button2", 1.0, lambda _name, payload=None: None), lambda _name, payload=None: None)
    raw.fds[123456] = "/dev/hidraw-test"

    monkeypatch.setattr("knob_mapper.os.read", lambda _fd, _size: b"")
    monkeypatch.setattr("knob_mapper.os.close", lambda _fd: None)

    raw.read_ready(123456)

    assert raw.fds == {}


def test_wait_for_ready_fds_sleeps_when_empty(monkeypatch):
    sleeps = []

    monkeypatch.setattr("knob_mapper.time.sleep", sleeps.append)
    monkeypatch.setattr(
        "knob_mapper.select.select",
        lambda *_args: (_ for _ in ()).throw(AssertionError("select called")),
    )

    assert wait_for_ready_fds([]) == []
    assert sleeps == [0.05]


def test_raw_report_input_maps_exact_reports():
    events = []
    raw = RawReportInput(
        [],
        {
            "01 10 00 00 00 00 00 00": "raw.button1.press",
            "01 08 00 00 00 00 00 00": "raw.button2.press",
        },
        lambda name, payload=None: events.append((name, payload or {})),
    )
    raw.handle_report(bytes.fromhex("01 10 00 00 00 00 00 00"), "/dev/hidraw11")
    raw.handle_report(bytes.fromhex("01 00 00"), "/dev/hidraw11")
    raw.handle_report(bytes.fromhex("01 08 00 00 00 00 00 00"), "/dev/hidraw11")
    assert [name for name, _payload in events] == ["raw.button1.press", "raw.button2.press"]
    assert events[0][1]["report"] == "01 10 00 00 00 00 00 00"


def test_raw_report_input_closes_fd_after_end_of_file(monkeypatch):
    raw = RawReportInput([], {}, lambda _name, payload=None: None)
    raw.fds[123456] = "/dev/hidraw-test"

    monkeypatch.setattr("knob_mapper.os.read", lambda _fd, _size: b"")
    monkeypatch.setattr("knob_mapper.os.close", lambda _fd: None)

    raw.read_ready(123456)

    assert raw.fds == {}


def test_config_uses_stable_raw_report_device_path():
    config_path = Path(__file__).resolve().parent / "config.yaml"
    config = yaml.safe_load(config_path.read_text())

    assert config["devices"]["raw_report_hidraw"] == ["/dev/knob-mapper-raw"]


def test_action_runner_supports_keydown_keyup(capsys):
    runner = ActionRunner(
        {
            "button1.hold": {"key_down": "Shift_R"},
            "button1.hold_release": {"key_up": "Shift_R"},
        },
        dry_run=True,
    )
    runner.emit("button1.hold")
    runner.emit("button1.hold_release")
    output = capsys.readouterr().out
    assert "xdotool keydown Shift_R" in output
    assert "xdotool keyup Shift_R" in output


def test_action_runner_supports_uinput_key(capsys):
    runner = ActionRunner({"ulanzi.play.press": {"uinput_key": "KEY_F14"}}, dry_run=True)
    runner.emit("ulanzi.play.press")
    output = capsys.readouterr().out
    assert "dry-run uinput click KEY_F14 event=ulanzi.play.press" in output


def test_action_runner_supports_uinput_key_down_up(capsys):
    runner = ActionRunner(
        {
            "ulanzi.caps.press": {"uinput_key_down": "KEY_CAPSLOCK"},
            "ulanzi.caps.release": {"uinput_key_up": "KEY_CAPSLOCK"},
        },
        dry_run=True,
    )
    runner.emit("ulanzi.caps.press")
    runner.emit("ulanzi.caps.release")
    output = capsys.readouterr().out
    assert "dry-run uinput keydown KEY_CAPSLOCK event=ulanzi.caps.press" in output
    assert "dry-run uinput keyup KEY_CAPSLOCK event=ulanzi.caps.release" in output


def test_action_runner_supports_uinput_sequence(capsys):
    runner = ActionRunner(
        {
            "knob2.cw": {
                "uinput_sequence": [
                    {"keydown": "Control_L"},
                    {"keydown": "Super_L"},
                    {"key": "Right"},
                    {"keyup": "Super_L"},
                    {"keyup": "Control_L"},
                ]
            }
        },
        dry_run=True,
    )

    runner.emit("knob2.cw")

    lines = [
        line.split("dry-run uinput ", 1)[1]
        for line in capsys.readouterr().out.splitlines()
        if "dry-run uinput " in line
    ]
    assert lines == [
        "keydown Control_L event=knob2.cw",
        "keydown Super_L event=knob2.cw",
        "click Right event=knob2.cw",
        "keyup Super_L event=knob2.cw",
        "keyup Control_L event=knob2.cw",
    ]


def test_action_runner_supports_passthrough_key(capsys):
    runner = ActionRunner({}, dry_run=True)
    runner.passthrough_key("KEY_A", 1)
    runner.passthrough_key("KEY_A", 2)
    runner.passthrough_key("KEY_A", 0)
    output = capsys.readouterr().out
    assert "dry-run uinput passthrough KEY_A value=1 event=passthrough" in output
    assert "dry-run uinput passthrough KEY_A value=2 event=passthrough" in output
    assert "dry-run uinput passthrough KEY_A value=0 event=passthrough" in output


def test_action_runner_supports_ydotool_key_down_up(capsys):
    runner = ActionRunner(
        {
            "ulanzi.shift.press": {"ydotool_key_down": "KEY_RIGHTSHIFT"},
            "ulanzi.shift.release": {"ydotool_key_up": "KEY_RIGHTSHIFT"},
        },
        dry_run=True,
    )
    runner.emit("ulanzi.shift.press")
    runner.emit("ulanzi.shift.release")
    output = capsys.readouterr().out
    assert "ydotool key --key-delay 25 54:1" in output
    assert "ydotool key --key-delay 25 54:0" in output


def test_action_runner_maps_doio_keys_to_super_return_and_shift(capsys):
    runner = ActionRunner(
        {
            "doio.key1.press": {"key_down": "Super_L"},
            "doio.key1.release": {"key_up": "Super_L"},
            "doio.key2.press": {"key_down": "Return"},
            "doio.key2.release": {"key_up": "Return"},
            "doio.key3.press": {"key_down": "Shift_R"},
            "doio.key3.release": {"key_up": "Shift_R"},
        },
        dry_run=True,
    )
    runner.emit("doio.key1.press")
    runner.emit("doio.key1.release")
    runner.emit("doio.key2.press")
    runner.emit("doio.key2.release")
    runner.emit("doio.key3.press")
    runner.emit("doio.key3.release")
    output = capsys.readouterr().out
    assert "xdotool keydown Super_L" in output
    assert "xdotool keyup Super_L" in output
    assert "xdotool keydown Return" in output
    assert "xdotool keyup Return" in output
    assert "xdotool keydown Shift_R" in output
    assert "xdotool keyup Shift_R" in output


def test_action_runner_supports_ordered_sequence(capsys):
    runner = ActionRunner(
        {
            "knob2.cw": {
                "sequence": [
                    {"keydown": "alt"},
                    {"key": "Escape"},
                    {"keyup": "alt"},
                ]
            }
        },
        dry_run=True,
    )
    runner.emit("knob2.cw")
    lines = [
        line.split("dry-run command=", 1)[1]
        for line in capsys.readouterr().out.splitlines()
        if "dry-run command=" in line
    ]
    assert lines == [
        "xdotool keydown alt",
        "xdotool key Escape",
        "xdotool keyup alt",
    ]


def test_action_runner_sends_workspace_sequence(capsys):
    runner = ActionRunner(
        {
            "knob2.cw": {
                "sequence": [
                    {"keydown": "Control_L"},
                    {"keydown": "Super_L"},
                    {"key": "Right"},
                    {"keyup": "Super_L"},
                    {"keyup": "Control_L"},
                ]
            }
        },
        dry_run=True,
    )
    runner.emit("knob2.cw")
    lines = [
        line.split("dry-run command=", 1)[1]
        for line in capsys.readouterr().out.splitlines()
        if "dry-run command=" in line
    ]
    assert lines == [
        "xdotool keydown Control_L",
        "xdotool keydown Super_L",
        "xdotool key Right",
        "xdotool keyup Super_L",
        "xdotool keyup Control_L",
    ]


def test_action_runner_window_cycle_holds_alt_until_timeout(capsys):
    runner = ActionRunner({"knob2.cw": {"window_cycle": "forward", "release_after_seconds": 0.01}}, dry_run=True)
    runner.emit("knob2.cw")
    runner.emit("knob2.cw")
    before = [
        line.split("dry-run uinput ", 1)[1]
        for line in capsys.readouterr().out.splitlines()
        if "dry-run uinput " in line
    ]
    assert before == [
        "keydown KEY_LEFTALT event=knob2.cw",
        "click KEY_ESC event=knob2.cw",
        "click KEY_ESC event=knob2.cw",
    ]
    time.sleep(0.02)
    runner.tick()
    after = capsys.readouterr().out
    assert "dry-run uinput keyup KEY_LEFTALT event=window_cycle.timeout" in after
    assert "window_cycle state=selected reason=timeout" in after


def test_action_runner_window_cycle_waits_after_alt_before_escape(capsys):
    runner = ActionRunner({"knob2.cw": {"window_cycle": "forward", "release_after_seconds": 1.0}}, dry_run=True)
    runner.emit("knob2.cw")
    lines = capsys.readouterr().out.splitlines()
    alt_index = next(index for index, line in enumerate(lines) if "dry-run uinput keydown KEY_LEFTALT" in line)
    sleep_index = next(index for index, line in enumerate(lines) if "dry-run sleep=0.030s" in line)
    esc_index = next(index for index, line in enumerate(lines) if "dry-run uinput click KEY_ESC" in line)
    assert alt_index < sleep_index < esc_index


def test_action_runner_window_cycle_switches_direction(capsys):
    runner = ActionRunner(
        {
            "knob2.cw": {"window_cycle": "forward", "release_after_seconds": 1.0},
            "knob2.ccw": {"window_cycle": "backward", "release_after_seconds": 1.0},
        },
        dry_run=True,
    )
    runner.emit("knob2.cw")
    capsys.readouterr()
    runner.emit("knob2.ccw")
    lines = [
        line.split("dry-run uinput ", 1)[1]
        for line in capsys.readouterr().out.splitlines()
        if "dry-run uinput " in line
    ]
    assert lines == [
        "keydown KEY_LEFTSHIFT event=knob2.ccw",
        "click KEY_ESC event=knob2.ccw",
    ]


def test_action_runner_window_cycle_switches_back_without_releasing_alt(capsys):
    runner = ActionRunner(
        {
            "knob2.cw": {"window_cycle": "forward", "release_after_seconds": 1.0},
            "knob2.ccw": {"window_cycle": "backward", "release_after_seconds": 1.0},
        },
        dry_run=True,
    )
    runner.emit("knob2.ccw")
    capsys.readouterr()
    runner.emit("knob2.cw")
    lines = [
        line.split("dry-run uinput ", 1)[1]
        for line in capsys.readouterr().out.splitlines()
        if "dry-run uinput " in line
    ]
    assert lines == [
        "keyup KEY_LEFTSHIFT event=knob2.cw",
        "click KEY_ESC event=knob2.cw",
    ]


def test_action_runner_supports_toggle_key(capsys):
    runner = ActionRunner({"button1.press": {"toggle_key": "Shift_R"}}, dry_run=True)
    runner.emit("button1.press")
    runner.emit("button1.press")
    output = capsys.readouterr().out
    assert "xdotool keydown Shift_R" in output
    assert "toggle=Shift_R state=on" in output
    assert "xdotool keyup Shift_R" in output
    assert "toggle=Shift_R state=off" in output


def test_action_runner_supports_scroll(capsys):
    runner = ActionRunner({"knob1.chord_cw": {"scroll": "up"}, "knob1.chord_ccw": {"scroll": "down"}}, dry_run=True)
    runner.emit("knob1.chord_cw")
    runner.emit("knob1.chord_ccw")
    output = capsys.readouterr().out
    assert "xdotool getwindowfocus" in output
    assert "xdotool getmouselocation --shell" in output
    assert "xdotool getwindowgeometry --shell ACTIVE_WINDOW" in output
    assert "xdotool mousemove 500 500" in output
    assert "xdotool click 4" in output
    assert "xdotool click 5" in output
    assert "xdotool mousemove 10 20" in output


def test_cleanup_always_releases_emergency_keys(capsys):
    runner = ActionRunner({}, dry_run=True)
    runner.cleanup()
    output = capsys.readouterr().out
    assert "dry-run emergency command=xdotool keyup alt event=cleanup" in output
    assert "dry-run emergency command=xdotool keyup Escape event=cleanup" in output


def test_action_runner_supports_pulse_hold(capsys):
    runner = ActionRunner({"button1.press": {"pulse_hold_key": "Shift_R", "pulse_hold_seconds": 0.01}}, dry_run=True)
    runner.emit("button1.press")
    time.sleep(0.02)
    runner.tick()
    output = capsys.readouterr().out
    assert "xdotool keydown Shift_R" in output
    assert "pulse_hold=Shift_R state=on" in output
    assert "xdotool keyup Shift_R" in output
    assert "pulse_hold=Shift_R state=off reason=timeout" in output


def test_action_runner_supports_deferred_keyup(capsys):
    runner = ActionRunner({"button1.release": {"key_up": "Shift_R", "min_hold_seconds": 0.01}}, dry_run=True)
    runner.emit("button1.release")
    before = capsys.readouterr().out
    assert "defer_keyup=Shift_R deadline_in=0.010s" in before
    assert "xdotool keyup Shift_R" not in before
    time.sleep(0.02)
    runner.tick()
    after = capsys.readouterr().out
    assert "xdotool keyup Shift_R" in after
    assert "defer_keyup=Shift_R state=sent" in after


def test_action_runner_supports_deferred_hotkey(capsys):
    runner = ActionRunner({"button1.release": {"hotkey": "Shift_R", "delay_seconds": 0.01}}, dry_run=True)
    runner.emit("button1.release")
    before = capsys.readouterr().out
    assert "defer_hotkey=Shift_R deadline_in=0.010s" in before
    assert "xdotool key --clearmodifiers Shift_R" not in before
    time.sleep(0.02)
    runner.tick()
    after = capsys.readouterr().out
    assert "xdotool key --clearmodifiers Shift_R" in after
    assert "defer_hotkey=Shift_R state=sent" in after


def test_action_runner_supports_every_n_gate(capsys):
    runner = ActionRunner({"knob1.chord_cw": {"hotkey": "shift+super+Right", "every_n": 3}}, dry_run=True)
    runner.emit("knob1.chord_cw")
    runner.emit("knob1.chord_cw")
    before = capsys.readouterr().out
    assert "gated count=1/3" in before
    assert "gated count=2/3" in before
    assert "xdotool key --clearmodifiers shift+Super+Right" not in before
    runner.emit("knob1.chord_cw")
    after = capsys.readouterr().out
    assert "gated count=3/3 fire=true" in after
    assert "xdotool key --clearmodifiers shift+Super+Right" in after


def test_build_inputs_maps_chord_knob_keys():
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {
                "knob1_evdev": ["/dev/null"],
                "knob1_chord_cw_key": "KEY_NEXTSONG",
                "knob1_chord_ccw_key": "KEY_PREVIOUSSONG",
            }
        },
        runner,
    )
    assert inputs[0].key_to_event["KEY_NEXTSONG"] == "knob1.chord_cw"
    assert inputs[0].key_to_event["KEY_PREVIOUSSONG"] == "knob1.chord_ccw"


def test_build_inputs_maps_second_knob_chord_keys_when_configured():
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {
                "knob1_evdev": ["/dev/null"],
                "knob2_chord_cw_key": "KEY_4",
                "knob2_chord_ccw_key": "KEY_5",
            }
        },
        runner,
    )
    assert inputs[0].key_to_event["KEY_4"] == "knob2.chord_cw"
    assert inputs[0].key_to_event["KEY_5"] == "knob2.chord_ccw"


def test_build_inputs_maps_doio_key_state_events():
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {
                "doio_evdev": ["/dev/null"],
                "doio_key1": "KEY_J",
                "doio_key2": "KEY_K",
                "doio_key3": "KEY_L",
                "doio_up_key": "KEY_UP",
                "doio_down_key": "KEY_DOWN",
                "doio_left_key": "KEY_LEFT",
                "doio_right_key": "KEY_RIGHT",
                "doio_enter_key": "KEY_ENTER",
            }
        },
        runner,
    )
    assert inputs[0].key_state_events["KEY_J"] == ("doio.key1.press", "doio.key1.release")
    assert inputs[0].key_state_events["KEY_K"] == ("doio.key2.press", "doio.key2.release")
    assert inputs[0].key_state_events["KEY_L"] == ("doio.key3.press", "doio.key3.release")
    assert inputs[0].key_state_events["KEY_UP"] == ("doio.up.press", "doio.up.release")
    assert inputs[0].key_state_events["KEY_DOWN"] == ("doio.down.press", "doio.down.release")
    assert inputs[0].key_state_events["KEY_LEFT"] == ("doio.left.press", "doio.left.release")
    assert inputs[0].key_state_events["KEY_RIGHT"] == ("doio.right.press", "doio.right.release")
    assert inputs[0].key_state_events["KEY_ENTER"] == ("doio.enter.press", "doio.enter.release")
    assert inputs[0].chorded_key_state_events["KEY_UP"] == (
        "KEY_J",
        "doio.super_up.press",
        "doio.super_up.release",
    )
    assert inputs[0].chorded_key_state_events["KEY_DOWN"] == (
        "KEY_J",
        "doio.super_down.press",
        "doio.super_down.release",
    )
    assert inputs[0].chorded_key_state_events["KEY_LEFT"] == (
        "KEY_J",
        "doio.super_left.press",
        "doio.super_left.release",
    )
    assert inputs[0].chorded_key_state_events["KEY_RIGHT"] == (
        "KEY_J",
        "doio.super_right.press",
        "doio.super_right.release",
    )


def test_doio_direction_without_super_uses_original_event():
    events = []
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {
                "doio_evdev": ["/dev/null"],
                "doio_key1": "KEY_J",
                "doio_up_key": "KEY_UP",
            }
        },
        runner,
    )
    inputs[0].emit = lambda name, payload=None: events.append((name, payload or {}))
    inputs[0].handle_key_event("KEY_UP", 1)
    inputs[0].handle_key_event("KEY_UP", 0)
    assert [name for name, _payload in events] == ["doio.up.press", "doio.up.release"]


def test_doio_direction_with_super_uses_chorded_event_and_ignores_repeat():
    events = []
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {
                "doio_evdev": ["/dev/null"],
                "doio_key1": "KEY_J",
                "doio_up_key": "KEY_UP",
            }
        },
        runner,
    )
    inputs[0].emit = lambda name, payload=None: events.append((name, payload or {}))
    inputs[0].handle_key_event("KEY_J", 1)
    inputs[0].handle_key_event("KEY_UP", 1)
    inputs[0].handle_key_event("KEY_UP", 2)
    inputs[0].handle_key_event("KEY_UP", 0)
    inputs[0].handle_key_event("KEY_J", 0)
    assert [name for name, _payload in events] == [
        "doio.key1.press",
        "doio.super_up.press",
        "doio.super_up.release",
        "doio.key1.release",
    ]


def test_build_inputs_maps_named_key_state_events(monkeypatch):
    monkeypatch.setattr("knob_mapper.find_evdev_by_name", lambda queries: ["/dev/null"])
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {"named_evdev": ["Ulanzi Dial Keyboard"]},
            "key_state_events": {"KEY_PREVIOUSSONG": "ulanzi.caps"},
        },
        runner,
    )
    assert inputs[0].key_state_events["KEY_PREVIOUSSONG"] == ("ulanzi.caps.press", "ulanzi.caps.release")


def test_evdev_input_maps_abs_y_gestures():
    events = []
    evdev = EvdevInput([], False, lambda name, payload=None: events.append((name, payload or {})))
    evdev.add_abs_axis_event("ABS_Y", "knob2.ccw", "knob2.cw", min_delta=500)

    evdev.handle_abs_touch_key("BTN_TOUCH", True)
    for value in (1012, 1600, 2500, 3200):
        evdev.handle_abs_event("ABS_Y", value)
    evdev.handle_abs_touch_key("BTN_TOUCH", False)

    evdev.handle_abs_touch_key("BTN_TOUCH", True)
    for value in (3200, 2500, 1600, 500):
        evdev.handle_abs_event("ABS_Y", value)
    evdev.handle_abs_touch_key("BTN_TOUCH", False)

    assert events == [
        ("knob2.ccw", {"source": "ABS_Y", "start": 1012, "last": 3200, "delta": 2188}),
        ("knob2.cw", {"source": "ABS_Y", "start": 3200, "last": 500, "delta": -2700}),
    ]


def test_build_inputs_maps_named_abs_axis_events(monkeypatch):
    monkeypatch.setattr("knob_mapper.find_evdev_by_name", lambda _queries: ["/dev/null"])
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {"named_evdev": ["MINI_KEYBOARD"]},
            "abs_axis_events": {
                "ABS_Y": {
                    "touch_key": "BTN_TOUCH",
                    "positive": "knob2.ccw",
                    "negative": "knob2.cw",
                    "min_delta": 500,
                }
            },
        },
        runner,
    )

    assert inputs[0].abs_axis_events["ABS_Y"]["positive_event"] == "knob2.ccw"
    assert inputs[0].abs_axis_events["ABS_Y"]["negative_event"] == "knob2.cw"


def test_build_inputs_maps_passthrough_named_key_state_events(monkeypatch):
    monkeypatch.setattr(
        "knob_mapper.find_evdev_by_name",
        lambda queries: ["/dev/iine"] if queries == ["IINE_keyboard"] else [],
    )
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {"passthrough_named_evdev": ["IINE_keyboard"]},
            "passthrough_key_state_events": {"KEY_SPACE": "iine.right_shift"},
        },
        runner,
    )
    assert inputs[0].paths == ["/dev/iine"]
    assert inputs[0].passthrough_unmapped == runner.passthrough_key
    assert inputs[0].key_state_events["KEY_SPACE"] == ("iine.right_shift.press", "iine.right_shift.release")


def test_build_inputs_keeps_passthrough_named_input_when_device_is_absent(monkeypatch):
    monkeypatch.setattr("knob_mapper.find_evdev_by_name", lambda _queries: [])
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {"passthrough_named_evdev": ["IINE_keyboard"]},
            "passthrough_key_state_events": {"KEY_SPACE": "iine.right_shift"},
        },
        runner,
    )
    assert inputs[0].paths == []
    assert inputs[0].path_resolver is not None
    assert inputs[0].key_state_events["KEY_SPACE"] == ("iine.right_shift.press", "iine.right_shift.release")


def test_build_inputs_maps_named_hold_tap_events(monkeypatch):
    monkeypatch.setattr("knob_mapper.find_evdev_by_name", lambda queries: ["/dev/null"])
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {"named_evdev": ["Ulanzi Dial Keyboard"]},
            "hold_tap_events": {"KEY_PLAYPAUSE": "ulanzi.playpause"},
        },
        runner,
    )
    assert isinstance(inputs[0].button_keys["KEY_PLAYPAUSE"], HoldTapKeyState)


def test_doio_key_state_events_ignore_repeat():
    events = []
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {
                "doio_evdev": ["/dev/null"],
                "doio_key2": "KEY_K",
            }
        },
        runner,
    )
    inputs[0].emit = lambda name, payload=None: events.append((name, payload or {}))
    inputs[0].handle_key_event("KEY_K", 1)
    inputs[0].handle_key_event("KEY_K", 2)
    inputs[0].handle_key_event("KEY_K", 0)
    assert [name for name, _payload in events] == ["doio.key2.press", "doio.key2.release"]


def test_build_inputs_maps_raw_report_hidraw():
    runner = ActionRunner({}, dry_run=True)
    inputs, _buttons = build_inputs(
        {
            "devices": {
                "raw_report_hidraw": ["/dev/null"],
            },
            "raw_report_map": {
                "01 08 00 00 00 00 00 00": "raw.button2.press",
            },
        },
        runner,
    )
    raw_inputs = [item for item in inputs if isinstance(item, RawReportInput)]
    assert raw_inputs
    assert raw_inputs[0].report_to_event["01 08 00 00 00 00 00 00"] == "raw.button2.press"
