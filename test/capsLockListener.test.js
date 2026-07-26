const assert = require('node:assert/strict');
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
    'minijoy_bt'
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
    trigger_id: 'minijoy_bt',
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
    ['down', 'minijoy_bt'],
    ['up', 'minijoy_bt']
  ]);
});
