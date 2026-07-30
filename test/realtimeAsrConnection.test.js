const test = require('node:test');
const assert = require('node:assert/strict');

test('runtime ASR settings create authenticated primary and unauthenticated fallback', async () => {
  const { resolveRealtimeAsrConnection } = await import('../src/helpers/realtimeAsrConnection.mjs');
  const values = {
    realtime_asr_url: 'wss://asr.yuanspaces.com/api/asr/realtime',
    realtime_asr_token: 'shared-secret-token',
    realtime_asr_fallback_url: 'ws://agx.tailnet.example:18011/api/asr/realtime',
  };
  const result = await resolveRealtimeAsrConnection({
    getSetting: (key, fallback) => values[key] ?? fallback,
    defaultUrl: 'ws://default.example/realtime',
    defaultFallbackUrl: 'ws://fallback.example/realtime',
  });
  assert.deepEqual(result.candidates, [
    {
      route: 'primary',
      url: values.realtime_asr_url,
      protocols: ['qwen3-asr-v1', 'auth.shared-secret-token'],
    },
    {
      route: 'fallback',
      url: values.realtime_asr_fallback_url,
      protocols: [],
    },
  ]);
  assert.equal(result.candidates.some((candidate) => candidate.url.includes('shared-secret-token')), false);
});

test('invalid runtime URLs fall back without duplicating the same route', async () => {
  const { resolveRealtimeAsrConnection } = await import('../src/helpers/realtimeAsrConnection.mjs');
  const result = await resolveRealtimeAsrConnection({
    getSetting: (key, fallback) => key === 'realtime_asr_url' ? 'https://not-websocket.example' : fallback,
    defaultUrl: 'ws://agx.example/realtime',
    defaultFallbackUrl: 'ws://agx.example/realtime',
  });
  assert.deepEqual(result.candidates, [
    { route: 'primary', url: 'ws://agx.example/realtime', protocols: [] },
  ]);
});

test('setting lookup failures safely retain defaults', async () => {
  const { resolveRealtimeAsrConnection } = await import('../src/helpers/realtimeAsrConnection.mjs');
  const result = await resolveRealtimeAsrConnection({
    getSetting: async () => { throw new Error('IPC unavailable'); },
    defaultUrl: 'ws://agx.example/realtime',
    defaultFallbackUrl: '',
  });
  assert.equal(result.primaryUrl, 'ws://agx.example/realtime');
  assert.equal(result.token, '');
});

test('fallback runs once only after a pre-ready primary failure', async () => {
  const { connectRealtimeAsrWithFallback } = await import('../src/helpers/realtimeAsrConnection.mjs');
  const attempts = [];
  const fallbackEvents = [];
  const result = await connectRealtimeAsrWithFallback(
    [
      { route: 'primary', url: 'wss://asr.example/realtime' },
      { route: 'fallback', url: 'ws://agx.example/realtime' },
    ],
    async (candidate) => {
      attempts.push(candidate.route);
      if (candidate.route === 'primary') throw new Error('closed before ready');
      return { type: 'ready' };
    },
    (event) => fallbackEvents.push(event),
  );
  assert.deepEqual(attempts, ['primary', 'fallback']);
  assert.deepEqual(fallbackEvents, [{ from: 'primary', to: 'fallback' }]);
  assert.equal(result.type, 'ready');
});

test('a successful primary never invokes fallback', async () => {
  const { connectRealtimeAsrWithFallback } = await import('../src/helpers/realtimeAsrConnection.mjs');
  const attempts = [];
  const result = await connectRealtimeAsrWithFallback(
    [
      { route: 'primary' },
      { route: 'fallback' },
    ],
    async (candidate) => {
      attempts.push(candidate.route);
      return { type: 'ready' };
    },
  );
  assert.deepEqual(attempts, ['primary']);
  assert.equal(result.type, 'ready');
});
