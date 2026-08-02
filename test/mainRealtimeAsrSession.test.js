const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { MainRealtimeAsrSession } = require("../src/helpers/mainRealtimeAsrSession");

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url, protocols = []) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send(value) {
    this.sent.push(Buffer.isBuffer(value) ? Buffer.from(value) : value);
  }

  message(payload) {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }
}
FakeWebSocket.instances = [];

test("main ASR buffers PipeWire PCM until ready and returns final text", async () => {
  FakeWebSocket.instances = [];
  const events = [];
  const session = new MainRealtimeAsrSession({
    connectionProvider: async () => ({
      url: "ws://asr.example/realtime",
      token: "secret",
    }),
    onEvent: (event) => events.push(event),
    WebSocketClass: FakeWebSocket,
    connectTimeoutMs: 1000,
    finalTimeoutMs: 1000,
  });

  const start = session.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  session.sendPcm(Buffer.from([1, 2, 3, 4]));
  socket.open();
  assert.equal(JSON.parse(socket.sent[0]).type, "start");
  socket.message({ type: "ready" });
  await start;
  assert.deepEqual(socket.sent[1], Buffer.from([1, 2, 3, 4]));

  const finishing = session.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(socket.sent[2]).type, "finish");
  socket.message({ type: "partial", text: "主进" });
  socket.message({ type: "final", text: "主进程" });

  const result = await finishing;
  assert.equal(result.text, "主进程");
  assert.deepEqual(events.map((event) => event.type), ["ready", "partial", "final"]);
  assert.deepEqual(socket.protocols, ["qwen3-asr-v1", "auth.secret"]);
});

test("main ASR cancellation drops pending PCM and closes the socket", async () => {
  FakeWebSocket.instances = [];
  const session = new MainRealtimeAsrSession({
    connectionProvider: async () => ({ url: "ws://asr.example/realtime" }),
    WebSocketClass: FakeWebSocket,
    connectTimeoutMs: 1000,
  });
  session.start().catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  session.sendPcm(Buffer.from([5, 6]));
  session.cancel();

  assert.equal(session.pendingBytes, 0);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});
