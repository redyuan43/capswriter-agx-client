const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertSettingWritable,
  getRuntimeSettingDefault,
  readSetting,
  sanitizeStoredSettings,
} = require('../src/platform/electron/runtimeSettings');

test('runtime ASR settings come from non-Vite process environment', () => {
  const env = {
    CAPSWRITER_REALTIME_ASR_URL: 'wss://asr.example/realtime',
    CAPSWRITER_REALTIME_ASR_TOKEN: 'runtime-only-token',
    CAPSWRITER_REALTIME_ASR_FALLBACK_URL: 'ws://agx.example/realtime',
  };
  assert.equal(getRuntimeSettingDefault('realtime_asr_url', '', env), env.CAPSWRITER_REALTIME_ASR_URL);
  assert.equal(getRuntimeSettingDefault('realtime_asr_token', '', env), env.CAPSWRITER_REALTIME_ASR_TOKEN);
  assert.equal(getRuntimeSettingDefault('realtime_asr_fallback_url', '', env), env.CAPSWRITER_REALTIME_ASR_FALLBACK_URL);
});

test('runtime defaults never invent an ASR token', () => {
  assert.equal(getRuntimeSettingDefault('realtime_asr_token', '', {}), '');
});

test('stored ASR tokens never override the runtime environment', () => {
  const databaseManager = {
    getSetting() {
      return 'stale-database-token';
    },
  };
  assert.equal(
    readSetting(databaseManager, 'realtime_asr_token', '', {
      CAPSWRITER_REALTIME_ASR_TOKEN: 'current-runtime-token',
    }),
    'current-runtime-token',
  );
});

test('ASR token cannot be written or returned by bulk settings reads', () => {
  assert.throws(() => assertSettingWritable('realtime_asr_token'), /runtime-only/);
  assert.doesNotThrow(() => assertSettingWritable('realtime_asr_url'));
  assert.deepEqual(
    sanitizeStoredSettings({ realtime_asr_token: 'stale', backend_url: 'http://backend' }),
    { backend_url: 'http://backend' },
  );
});
