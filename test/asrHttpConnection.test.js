const test = require('node:test');
const assert = require('node:assert/strict');
const { AsrConnectionProfiles } = require('../src/helpers/asrConnectionProfiles');

test('Tencent profile supplies both transports without changing a legacy selection', async () => {
  const manager = new AsrConnectionProfiles({
    databaseManager: { getSetting: () => ({ activeProfileId: 'spark', profiles: [] }) },
    dataDirectory: '/unused', env: {},
  });
  manager.initialized = true;
  assert.equal(manager.getActiveConnection().id, 'spark');
  const profile = manager.list().profiles.find(p => p.id === 'tencent');
  const connection = manager.getConnectionForProfile(profile);
  const { resolveAsrHttpBaseURL } = await import('../src/helpers/asrHttpConnection.mjs');
  assert.equal(await resolveAsrHttpBaseURL(async () => connection, () => 'legacy'), profile.httpBaseUrl);
  assert.equal(await resolveAsrHttpBaseURL(async () => ({ url: 'ws://legacy/ws' }), () => 'legacy'), 'legacy');
});

test('invalid explicit HTTP routes and IPC failures do not silently send audio to a legacy server', async () => {
  const { resolveAsrHttpBaseURL } = await import('../src/helpers/asrHttpConnection.mjs');
  for (const httpBaseUrl of ['file:///tmp/audio', 'http://user:password@example.test', 'http://example.test?secret=x']) {
    await assert.rejects(resolveAsrHttpBaseURL(async () => ({ httpBaseUrl }), () => 'legacy'));
  }
  await assert.rejects(resolveAsrHttpBaseURL(async () => { throw new Error('IPC failed'); }, () => 'legacy'));
  assert.equal(await resolveAsrHttpBaseURL(null, () => 'legacy'), 'legacy');
});
