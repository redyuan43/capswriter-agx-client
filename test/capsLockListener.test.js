const assert = require('node:assert/strict');
const test = require('node:test');

const CapsLockListener = require('../src/helpers/capsLockListener');

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
