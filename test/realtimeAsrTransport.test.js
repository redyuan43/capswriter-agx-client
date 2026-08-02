const test = require('node:test');
const assert = require('node:assert/strict');

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url, protocols = []) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    const handler = this.onclose;
    queueMicrotask(() => handler?.({ code: 1000, reason: '' }));
  }

  emitOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitError() {
    this.onerror?.(new Error('fake websocket error'));
  }

  emitClose(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  emitMessage(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

async function loadBackendApi(t) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: require('node:path').resolve(__dirname, '../src'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  t.after(() => vite.close());
  return vite.ssrLoadModule('/services/backendAPI.js');
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function runtimeWindow(values) {
  return {
    setTimeout,
    clearTimeout,
    electronAPI: {
      getSetting(key, fallback) {
        return values[key] ?? fallback;
      },
    },
  };
}

for (const search of ['?panel=control', '?page=links']) {
  test(`secondary window ${search} does not schedule an ASR startup preconnection`, async (t) => {
    FakeWebSocket.instances = [];
    global.WebSocket = FakeWebSocket;
    let idleCallbacks = 0;
    global.window = {
      ...runtimeWindow({
        realtime_asr_url: 'wss://asr.example/realtime',
        realtime_asr_token: 'runtime-token',
      }),
      location: { search },
      requestIdleCallback() {
        idleCallbacks += 1;
        return idleCallbacks;
      },
      cancelIdleCallback() {},
    };
    t.after(() => {
      delete global.WebSocket;
      delete global.window;
    });

    const { resetRealtimeAsrPreconnection } = await loadBackendApi(t);
    assert.equal(idleCallbacks, 0);
    assert.equal(FakeWebSocket.instances.length, 0);
    resetRealtimeAsrPreconnection();
  });
}

test('Linux renderer leaves realtime ASR connections to the main process', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  let idleCallbacks = 0;
  global.window = {
    ...runtimeWindow({
      realtime_asr_url: 'wss://asr.example/realtime',
      realtime_asr_token: 'runtime-token',
    }),
    location: { search: '' },
    electronAPI: {
      ...runtimeWindow({}).electronAPI,
      getPlatform: () => 'linux',
    },
    requestIdleCallback() {
      idleCallbacks += 1;
      return idleCallbacks;
    },
    cancelIdleCallback() {},
  };
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });

  const {
    resetRealtimeAsrPreconnection,
    warmRealtimeAsrConnection,
  } = await loadBackendApi(t);
  assert.equal(idleCallbacks, 0);
  assert.equal(await warmRealtimeAsrConnection(), false);
  assert.equal(FakeWebSocket.instances.length, 0);
  resetRealtimeAsrPreconnection();
});

test('late events from a failed primary cannot contaminate the fallback session', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  global.window = runtimeWindow({
    realtime_asr_url: 'wss://asr.example/realtime',
    realtime_asr_token: 'runtime-token',
    realtime_asr_fallback_url: 'ws://agx.example/realtime',
  });
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });

  const { PCMRealtimeSession, resetRealtimeAsrPreconnection } = await loadBackendApi(t);
  const events = [];
  const clientEvents = [];
  const session = new PCMRealtimeSession({
    onEvent: (event) => events.push(event),
    onClientEvent: (event) => clientEvents.push(event),
  });
  const started = session.start();
  await tick();
  const primary = FakeWebSocket.instances[0];
  assert.deepEqual(primary.protocols, ['qwen3-asr-v1', 'auth.runtime-token']);
  primary.emitError();
  await tick();

  const fallback = FakeWebSocket.instances[1];
  assert.ok(fallback);
  assert.deepEqual(fallback.protocols, []);
  primary.emitMessage({ type: 'ready', request_id: 'stale' });
  primary.emitMessage({ type: 'partial', text: 'stale partial' });
  primary.emitMessage({ type: 'final', text: 'stale final' });
  assert.equal(events.length, 0);
  assert.equal(session.latestTextPayload, null);

  fallback.emitOpen();
  await tick();
  fallback.emitMessage({ type: 'ready', request_id: 'current' });
  await started;
  assert.equal(session.activeRoute, 'fallback');
  assert.deepEqual(
    clientEvents.filter((event) => event.type === 'realtime_connection_fallback'),
    [{ type: 'realtime_connection_fallback', from: 'primary', to: 'fallback' }],
  );
  session.cancel();
  resetRealtimeAsrPreconnection();
});

test('an error after ready never opens a fallback candidate', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  global.window = runtimeWindow({
    realtime_asr_url: 'wss://asr.example/realtime',
    realtime_asr_token: 'runtime-token',
    realtime_asr_fallback_url: 'ws://agx.example/realtime',
  });
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });

  const { PCMRealtimeSession, resetRealtimeAsrPreconnection } = await loadBackendApi(t);
  const session = new PCMRealtimeSession();
  const started = session.start();
  await tick();
  const primary = FakeWebSocket.instances[0];
  primary.emitOpen();
  await tick();
  primary.emitMessage({ type: 'ready' });
  await started;
  primary.emitError();
  await tick();
  assert.equal(FakeWebSocket.instances.length, 1);
  session.cancel();
  resetRealtimeAsrPreconnection();
});

test('an authenticated gateway preconnection is reused without sending start early', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  global.window = runtimeWindow({
    realtime_asr_url: 'wss://asr.example/realtime',
    realtime_asr_token: 'runtime-token',
    realtime_asr_fallback_url: 'ws://agx.example/realtime',
  });
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });

  const {
    PCMRealtimeSession,
    resetRealtimeAsrPreconnection,
    warmRealtimeAsrConnection,
  } = await loadBackendApi(t);
  const warming = warmRealtimeAsrConnection();
  await tick();
  const preconnected = FakeWebSocket.instances[0];
  assert.ok(preconnected);
  assert.deepEqual(preconnected.protocols, ['qwen3-asr-v1', 'auth.runtime-token']);
  assert.deepEqual(preconnected.sent, []);
  preconnected.emitOpen();
  assert.equal(await warming, true);
  assert.deepEqual(preconnected.sent, []);

  const clientEvents = [];
  const session = new PCMRealtimeSession({ onClientEvent: (event) => clientEvents.push(event) });
  const started = session.start();
  await tick();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(JSON.parse(preconnected.sent[0]).type, 'start');
  preconnected.emitMessage({ type: 'ready', success: true });
  await started;
  const readyEvent = clientEvents.find((event) => event.type === 'realtime_transport_ready');
  assert.equal(readyEvent.preconnected, true);
  assert.equal(readyEvent.route, 'primary');
  session.cancel();
  resetRealtimeAsrPreconnection();
});

test('concurrent warm and session acquisition create only one public socket', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  let releaseSettings;
  const settingsReady = new Promise((resolve) => { releaseSettings = resolve; });
  const values = {
    realtime_asr_url: 'wss://asr.example/realtime',
    realtime_asr_token: 'runtime-token',
    realtime_asr_fallback_url: 'ws://agx.example/realtime',
  };
  global.window = {
    setTimeout,
    clearTimeout,
    electronAPI: {
      async getSetting(key, fallback) {
        await settingsReady;
        return values[key] ?? fallback;
      },
    },
  };
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });

  const {
    PCMRealtimeSession,
    resetRealtimeAsrPreconnection,
    warmRealtimeAsrConnection,
  } = await loadBackendApi(t);
  const warming = warmRealtimeAsrConnection();
  const session = new PCMRealtimeSession();
  const started = session.start();
  releaseSettings();
  await tick();
  await tick();
  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  socket.emitOpen();
  await tick();
  assert.equal(socket.sent.length, 1);
  assert.equal(JSON.parse(socket.sent[0]).type, 'start');
  socket.emitMessage({ type: 'ready', success: true });
  await started;
  await warming;
  session.cancel();
  resetRealtimeAsrPreconnection();
});

test('a changed candidate closes the old authenticated idle socket', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  const values = {
    realtime_asr_url: 'wss://old.example/realtime',
    realtime_asr_token: 'old-token',
    realtime_asr_fallback_url: 'ws://agx.example/realtime',
  };
  global.window = runtimeWindow(values);
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });
  const {
    PCMRealtimeSession,
    resetRealtimeAsrPreconnection,
    warmRealtimeAsrConnection,
  } = await loadBackendApi(t);
  const warming = warmRealtimeAsrConnection();
  await tick();
  const oldSocket = FakeWebSocket.instances[0];
  oldSocket.emitOpen();
  await warming;
  values.realtime_asr_url = 'wss://new.example/realtime';
  values.realtime_asr_token = 'new-token';
  const session = new PCMRealtimeSession();
  const started = session.start();
  await tick();
  assert.equal(oldSocket.readyState, FakeWebSocket.CLOSED);
  assert.equal(FakeWebSocket.instances.length, 2);
  const newSocket = FakeWebSocket.instances[1];
  newSocket.emitOpen();
  await tick();
  newSocket.emitMessage({ type: 'ready', success: true });
  await started;
  session.cancel();
  resetRealtimeAsrPreconnection();
});

test('cancel closes a connecting owned socket and permits a fresh warm connection', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  global.window = runtimeWindow({
    realtime_asr_url: 'wss://asr.example/realtime',
    realtime_asr_token: 'runtime-token',
    realtime_asr_fallback_url: '',
  });
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });
  const {
    PCMRealtimeSession,
    resetRealtimeAsrPreconnection,
    warmRealtimeAsrConnection,
  } = await loadBackendApi(t);
  const session = new PCMRealtimeSession();
  const started = session.start();
  await tick();
  const connecting = FakeWebSocket.instances[0];
  session.cancel();
  await assert.rejects(started, /cancelled|closed|unavailable/i);
  assert.equal(connecting.readyState, FakeWebSocket.CLOSED);
  const warming = warmRealtimeAsrConnection();
  await tick();
  assert.equal(FakeWebSocket.instances.length, 2);
  FakeWebSocket.instances[1].emitOpen();
  assert.equal(await warming, true);
  resetRealtimeAsrPreconnection();
});

test('an idle remote close is discarded before the next warm', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  global.window = runtimeWindow({
    realtime_asr_url: 'wss://asr.example/realtime',
    realtime_asr_token: 'runtime-token',
    realtime_asr_fallback_url: '',
  });
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });
  const { resetRealtimeAsrPreconnection, warmRealtimeAsrConnection } = await loadBackendApi(t);
  const firstWarm = warmRealtimeAsrConnection();
  await tick();
  const first = FakeWebSocket.instances[0];
  first.emitOpen();
  assert.equal(await firstWarm, true);
  first.emitClose(1001, 'gateway restart');
  const secondWarm = warmRealtimeAsrConnection();
  await tick();
  assert.equal(FakeWebSocket.instances.length, 2);
  FakeWebSocket.instances[1].emitOpen();
  assert.equal(await secondWarm, true);
  resetRealtimeAsrPreconnection();
});

test('reset invalidates a warm operation blocked on runtime settings', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  let releaseSettings;
  const settingsReady = new Promise((resolve) => { releaseSettings = resolve; });
  global.window = {
    setTimeout,
    clearTimeout,
    electronAPI: {
      async getSetting(key, fallback) {
        await settingsReady;
        const values = {
          realtime_asr_url: 'wss://asr.example/realtime',
          realtime_asr_token: 'runtime-token',
          realtime_asr_fallback_url: '',
        };
        return values[key] ?? fallback;
      },
    },
  };
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });
  const { resetRealtimeAsrPreconnection, warmRealtimeAsrConnection } = await loadBackendApi(t);
  const warming = warmRealtimeAsrConnection();
  await tick();
  resetRealtimeAsrPreconnection();
  releaseSettings();
  assert.equal(await warming, false);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('resetting an active socket never schedules a replacement', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  global.window = runtimeWindow({
    realtime_asr_url: 'wss://asr.example/realtime',
    realtime_asr_token: 'runtime-token',
    realtime_asr_fallback_url: '',
  });
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });
  const {
    PCMRealtimeSession,
    resetRealtimeAsrPreconnection,
    warmRealtimeAsrConnection,
  } = await loadBackendApi(t);
  const warming = warmRealtimeAsrConnection();
  await tick();
  const socket = FakeWebSocket.instances[0];
  socket.emitOpen();
  await warming;
  const session = new PCMRealtimeSession();
  const started = session.start();
  await tick();
  socket.emitMessage({ type: 'ready', success: true });
  await started;
  resetRealtimeAsrPreconnection();
  session.cancel();
  resetRealtimeAsrPreconnection();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('ASR profile invalidation keeps an active recording socket open', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  global.window = runtimeWindow({
    realtime_asr_url: 'wss://asr.example/realtime',
    realtime_asr_token: 'runtime-token',
    realtime_asr_fallback_url: '',
  });
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });
  const { PCMRealtimeSession, invalidateRealtimeAsrPreconnection, resetRealtimeAsrPreconnection } = await loadBackendApi(t);
  const session = new PCMRealtimeSession();
  const started = session.start();
  await tick();
  const socket = FakeWebSocket.instances[0];
  socket.emitOpen();
  await tick();
  socket.emitMessage({ type: 'ready', success: true });
  await started;
  invalidateRealtimeAsrPreconnection();
  assert.equal(socket.readyState, FakeWebSocket.OPEN);
  session.cancel();
  resetRealtimeAsrPreconnection();
});

test('reset cancels and invalidates the module startup idle callback', async (t) => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  let idleCallback = null;
  let cancelledId = null;
  global.window = {
    ...runtimeWindow({
      realtime_asr_url: 'wss://asr.example/realtime',
      realtime_asr_token: 'runtime-token',
      realtime_asr_fallback_url: '',
    }),
    requestIdleCallback(callback) {
      idleCallback = callback;
      return 42;
    },
    cancelIdleCallback(id) {
      cancelledId = id;
    },
  };
  t.after(() => {
    delete global.WebSocket;
    delete global.window;
  });
  const { resetRealtimeAsrPreconnection } = await loadBackendApi(t);
  assert.equal(typeof idleCallback, 'function');
  resetRealtimeAsrPreconnection();
  assert.equal(cancelledId, 42);
  idleCallback();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(FakeWebSocket.instances.length, 0);
});
