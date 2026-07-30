const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const CapsLockListener = require('../src/helpers/capsLockListener');
const {
  describeLinuxInputDevice,
  discoverNamedLinuxInputDevicePaths,
} = CapsLockListener;

test('treats Caps as a non-locking Right Shift hold key when configured', () => {
  const previous = process.env.CAPS_DICTATION_HOLD_KEY;
  process.env.CAPS_DICTATION_HOLD_KEY = 'caps as right shift';

  try {
    const listener = new CapsLockListener();
    assert.equal(listener.dictationKeyConfig.displayName, 'Caps as Right Shift');
    assert.equal(listener.dictationKeyConfig.uiohookName, 'CapsLock');
    assert.equal(listener.dictationKeyConfig.evdevCode, 58);
    assert.equal(listener.dictationKeyConfig.restoresCapsLock, false);
  } finally {
    if (previous === undefined) delete process.env.CAPS_DICTATION_HOLD_KEY;
    else process.env.CAPS_DICTATION_HOLD_KEY = previous;
  }
});

test('classifies the MiniJoy HID event source separately from a keyboard', () => {
  const devices = `I: Bus=0005 Vendor=0000 Product=0000 Version=0000
N: Name="VibeStick MiniJoy"
P: Phys=AA:BB:CC:DD:EE:FF
U: Uniq=11:22:33:44:55:66
H: Handlers=sysrq kbd event17

I: Bus=0003 Vendor=1234 Product=5678 Version=0001
N: Name="USB Keyboard"
H: Handlers=sysrq kbd event6
`;

  assert.equal(
    describeLinuxInputDevice(devices, '/dev/input/event17').trigger_id,
    'minijoy_bt:112233445566'
  );
  assert.equal(
    describeLinuxInputDevice(devices, '/dev/input/event6').trigger_id,
    'keyboard'
  );
});

test('discovers MiniJoy mouse event nodes by device name', () => {
  const devices = `I: Bus=0005 Vendor=0000 Product=0000 Version=0000
N: Name="VibeStick MiniJoy Keyboard"
H: Handlers=sysrq kbd event17

I: Bus=0005 Vendor=0000 Product=0000 Version=0000
N: Name="VibeStick MiniJoy Mouse"
H: Handlers=mouse2 event18
`;

  assert.deepEqual(
    discoverNamedLinuxInputDevicePaths(devices, [
      'VibeStick MiniJoy Keyboard',
      'VibeStick MiniJoy Mouse',
    ]),
    ['/dev/input/event17', '/dev/input/event18']
  );
});

test('routes the MiniJoy mouse middle button to dictation callbacks', () => {
  const listener = new CapsLockListener();
  listener.minHoldMs = 0;
  listener._inputBuffers.set('/dev/input/event18', Buffer.alloc(0));
  listener._inputDeviceInfo.set('/dev/input/event18', {
    trigger_id: 'minijoy_bt:112233445566',
    device_path: '/dev/input/event18',
    device_name: 'VibeStick MiniJoy Mouse',
    backend: 'evdev'
  });
  const events = [];
  listener.setOnCapsLockDown((payload) => events.push(['down', payload.trigger_id]));
  listener.setOnCapsLockUp((payload) => events.push(['up', payload.trigger_id]));

  const inputEvent = (value) => {
    const event = Buffer.alloc(24);
    event.writeUInt16LE(1, 16);
    event.writeUInt16LE(274, 18);
    event.writeInt32LE(value, 20);
    return event;
  };
  listener._onInputEventData('/dev/input/event18', inputEvent(1));
  listener._onInputEventData('/dev/input/event18', inputEvent(0));

  assert.deepEqual(events, [
    ['down', 'minijoy_bt:112233445566'],
    ['up', 'minijoy_bt:112233445566']
  ]);
});

test('routes MiniJoy Right Shift exactly like the physical dictation key', () => {
  const listener = new CapsLockListener();
  listener.minHoldMs = 0;
  const devicePath = '/dev/input/event257';
  listener._inputBuffers.set(devicePath, Buffer.alloc(0));
  listener._inputDeviceInfo.set(devicePath, {
    trigger_id: 'minijoy_bt:14080852f962',
    device_path: devicePath,
    device_name: 'VibeStick MiniJoy Keyboard',
    backend: 'evdev',
  });
  const events = [];
  listener.setOnCapsLockDown((payload) => events.push(['down', payload.trigger_id]));
  listener.setOnCapsLockUp((payload) => events.push(['up', payload.trigger_id]));
  const inputEvent = (value) => {
    const event = Buffer.alloc(24);
    event.writeUInt16LE(1, 16);
    event.writeUInt16LE(54, 18);
    event.writeInt32LE(value, 20);
    return event;
  };

  listener._onInputEventData(devicePath, inputEvent(1));
  listener._onInputEventData(devicePath, inputEvent(2));
  listener._onInputEventData(devicePath, inputEvent(0));

  assert.deepEqual(events, [
    ['down', 'minijoy_bt:14080852f962'],
    ['up', 'minijoy_bt:14080852f962'],
  ]);
});

test('routes the PocketTerm35 physical Shift key as dictation without changing other keyboards', () => {
  const listener = new CapsLockListener();
  listener.minHoldMs = 0;
  const devicePath = '/dev/input/event0';
  listener._inputBuffers.set(devicePath, Buffer.alloc(0));
  listener._inputDeviceInfo.set(devicePath, {
    trigger_id: 'keyboard',
    device_path: devicePath,
    device_name: 'My Company My Custom Pico Keyboard',
    backend: 'evdev',
  });
  const events = [];
  listener.setOnCapsLockDown((payload) => events.push(['down', payload.trigger_id]));
  listener.setOnCapsLockUp((payload) => events.push(['up', payload.trigger_id]));
  const inputEvent = (value) => {
    const event = Buffer.alloc(24);
    event.writeUInt16LE(1, 16);
    event.writeUInt16LE(42, 18);
    event.writeInt32LE(value, 20);
    return event;
  };

  listener._onInputEventData(devicePath, inputEvent(1));
  listener._onInputEventData(devicePath, inputEvent(0));

  assert.deepEqual(events, [
    ['down', 'keyboard'],
    ['up', 'keyboard'],
  ]);
});

test('ignores close events from a replaced input stream generation', () => {
  const listener = new CapsLockListener();
  const devicePath = '/dev/input/event257';
  const oldStream = { destroyed: true };
  const newStream = { destroyed: false, destroy() { this.destroyed = true; } };
  listener._inputDeviceHandles.set(devicePath, { stream: newStream });
  listener._inputDeviceInfo.set(devicePath, { trigger_id: 'minijoy_bt:14080852f962' });
  listener._inputBuffers.set(devicePath, Buffer.alloc(0));

  listener._closeLinuxInputDevice(devicePath, oldStream, 'stale_close');

  assert.equal(listener._inputDeviceHandles.get(devicePath).stream, newStream);
  assert.equal(listener._inputDeviceInfo.get(devicePath).trigger_id, 'minijoy_bt:14080852f962');
});

test('polls MiniJoy evdev without relying on fs.ReadStream', () => {
  const listener = new CapsLockListener();
  listener.minHoldMs = 0;
  const devicePath = '/dev/input/event257';
  const event = Buffer.alloc(24);
  event.writeUInt16LE(1, 16);
  event.writeUInt16LE(54, 18);
  event.writeInt32LE(1, 20);
  listener._inputDeviceHandles.set(devicePath, {
    devicePath,
    fd: 123,
    pollMiniJoy: true,
    readBuffer: Buffer.alloc(24 * 32),
  });
  listener._inputBuffers.set(devicePath, Buffer.alloc(0));
  listener._inputDeviceInfo.set(devicePath, {
    trigger_id: 'minijoy_bt:14080852f962',
    device_path: devicePath,
    backend: 'evdev',
  });
  const received = [];
  listener.setOnCapsLockDown((payload) => received.push(payload.trigger_id));
  const originalReadSync = fs.readSync;
  let reads = 0;
  fs.readSync = (_fd, buffer) => {
    if (reads++ === 0) {
      event.copy(buffer);
      return event.length;
    }
    const error = new Error('try again');
    error.code = 'EAGAIN';
    throw error;
  };
  try {
    listener._pollMiniJoyInputDevices();
  } finally {
    fs.readSync = originalReadSync;
  }

  assert.deepEqual(received, ['minijoy_bt:14080852f962']);
});

test('tracks same-name MiniJoy hold keys independently and releases a disconnected device', () => {
  const listener = new CapsLockListener();
  listener.minHoldMs = 0;
  const events = [];
  listener.setOnCapsLockDown((payload) => events.push(['down', payload.trigger_id, payload.reason || '']));
  listener.setOnCapsLockUp((payload) => events.push(['up', payload.trigger_id, payload.reason || '']));

  const first = {
    trigger_id: 'minijoy_bt:112233445566',
    device_path: '/dev/input/event17',
    backend: 'evdev',
  };
  const second = {
    trigger_id: 'minijoy_bt:aabbccddeeff',
    device_path: '/dev/input/event19',
    backend: 'evdev',
  };
  listener._handleHoldKeyDown('dictation', listener.dictationKeyConfig, 54, first);
  listener._handleHoldKeyDown('dictation', listener.dictationKeyConfig, 54, second);
  listener._releaseEvdevHoldsForDevice(first.device_path);
  listener._handleHoldKeyUp('dictation', listener.dictationKeyConfig, 54, second);

  assert.deepEqual(events, [
    ['down', first.trigger_id, ''],
    ['down', second.trigger_id, ''],
    ['up', first.trigger_id, 'input_device_closed'],
    ['up', second.trigger_id, 'key_released'],
  ]);
});
