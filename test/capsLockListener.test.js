const assert = require('node:assert/strict');
const test = require('node:test');

const CapsLockListener = require('../src/helpers/capsLockListener');
const { describeLinuxInputDevice } = CapsLockListener;

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
