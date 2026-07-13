const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { once } = require("node:events");

const M5VoiceBridge = require("../src/helpers/m5VoiceBridge");

function request(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/health",
      headers,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("health requires the configured token and returns bridge identity", async (t) => {
  const env = {
    M5_VOICE_BRIDGE_PORT: process.env.M5_VOICE_BRIDGE_PORT,
    M5_VOICE_BRIDGE_TOKEN: process.env.M5_VOICE_BRIDGE_TOKEN,
    M5_VOICE_BRIDGE_ID: process.env.M5_VOICE_BRIDGE_ID,
    M5_VOICE_BRIDGE_LABEL: process.env.M5_VOICE_BRIDGE_LABEL,
  };
  process.env.M5_VOICE_BRIDGE_PORT = "0";
  process.env.M5_VOICE_BRIDGE_TOKEN = "test-bridge-token";
  process.env.M5_VOICE_BRIDGE_ID = "desk-a";
  process.env.M5_VOICE_BRIDGE_LABEL = "Desk A";
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const bridge = new M5VoiceBridge({
    logger: { warn() {}, error() {}, info() {} },
    windowManager: {},
    clipboardManager: {},
    sendToRenderer() {},
  });
  bridge.start();
  await once(bridge.server, "listening");
  t.after(() => bridge.stop());
  const port = bridge.server.address().port;

  const unauthorized = await request(port);
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await request(port, { "X-Vibe-Stick-Token": "test-bridge-token" });
  assert.equal(authorized.statusCode, 200);
  assert.deepEqual(JSON.parse(authorized.body), {
    ok: true,
    bridge_id: "desk-a",
    bridge_label: "Desk A",
    bridge_name: "capswriter-m5-voice-bridge",
    bridge_version: "1.0.0",
    token_required: true,
  });
});
