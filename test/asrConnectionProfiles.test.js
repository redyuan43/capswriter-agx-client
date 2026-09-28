const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AsrConnectionProfiles } = require("../src/helpers/asrConnectionProfiles");

function createDatabase(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getSetting(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    setSetting(key, value) { values.set(key, value); },
  };
}

function createSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
}

function createManager({ settings, env = {} } = {}) {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "capswriter-asr-profiles-"));
  const manager = new AsrConnectionProfiles({
    databaseManager: createDatabase(settings),
    dataDirectory,
    safeStorage: createSafeStorage(),
    env,
  });
  return { manager, dataDirectory };
}

test("seeds the editable presets and encrypts a migrated public token", () => {
  const { manager, dataDirectory } = createManager({
    env: {
      CAPSWRITER_REALTIME_ASR_URL: "wss://asr.yuanspaces.com/api/asr/realtime",
      CAPSWRITER_REALTIME_ASR_TOKEN: "runtime-token",
    },
  });
  const list = manager.list();
  assert.equal(list.activeProfileId, "public");
  assert.deepEqual(list.profiles.map((item) => item.id), ["tencent-direct", "firered2-local", "tencent", "spark", "public", "agx"]);
  assert.equal(list.profiles.find((item) => item.id === "public").hasToken, true);
  assert.equal(JSON.stringify(list).includes("runtime-token"), false);
  assert.equal(manager.getActiveConnection().token, "runtime-token");
  const secrets = fs.readFileSync(path.join(dataDirectory, "asr-connection-secrets.json"), "utf8");
  assert.equal(secrets.includes("runtime-token"), false);
  assert.equal(fs.statSync(path.join(dataDirectory, "asr-connection-secrets.json")).mode & 0o777, 0o600);
});

test("keeps preset names while allowing endpoint edits and supports token-auth custom profiles", () => {
  const { manager } = createManager();
  manager.save({ id: "spark", name: "changed", url: "wss://spark.example/realtime", auth: "token" });
  const spark = manager.list().profiles.find((item) => item.id === "spark");
  assert.deepEqual(spark, {
    id: "spark", name: "Spark", url: "wss://spark.example/realtime", auth: "none", preset: true, hasToken: false,
  });
  manager.save({ id: "custom-a", name: "远程网关", url: "wss://gateway.example/realtime", auth: "token" }, { token: "custom-token" });
  manager.activate("custom-a");
  assert.equal(manager.getActiveConnection().token, "custom-token");
  assert.equal(JSON.stringify(manager.list()).includes("custom-token"), false);
});

test("migrates an unknown legacy route as a custom profile", () => {
  const { manager } = createManager({ env: { CAPSWRITER_REALTIME_ASR_URL: "ws://legacy.example/realtime" } });
  const list = manager.list();
  assert.equal(list.activeProfileId, "migrated");
  assert.deepEqual(list.profiles.find((item) => item.id === "migrated"), {
    id: "migrated", name: "迁移的 ASR 路由", url: "ws://legacy.example/realtime", auth: "token", preset: false, hasToken: false,
  });
});

test("does not permit deleting presets or invalid websocket URLs", () => {
  const { manager } = createManager();
  assert.throws(() => manager.remove("spark"), /不能删除/);
  assert.throws(
    () => manager.save({ id: "custom-a", name: "无效", url: "https://example.com", auth: "none" }),
    /ws:\/\//,
  );
});

test("explicit token clearing suppresses a legacy runtime token", () => {
  const { manager } = createManager({ env: { CAPSWRITER_REALTIME_ASR_TOKEN: "runtime-token" } });
  manager.save({ id: "public", name: "公网", url: "wss://asr.yuanspaces.com/api/asr/realtime", auth: "token" }, { clearToken: true });
  assert.equal(manager.getActiveConnection().token, "");
  assert.equal(manager.list().profiles.find((item) => item.id === "public").hasToken, false);
});

test("adds local FireRed2 to saved profiles without changing the active provider", () => {
  const { manager } = createManager({ settings: { asr_connection_profiles_v1: {
    version: 1, activeProfileId: 'tencent-direct', profiles: [
      { id: 'tencent-direct', name: '腾讯云 · 本机直连', url: 'ws://127.0.0.1', auth: 'none' },
      { id: 'custom-existing', name: '现有服务', url: 'ws://existing.example/realtime', auth: 'none' },
    ],
  } } });
  assert.equal(manager.list().activeProfileId, 'tencent-direct');
  assert.ok(manager.list().profiles.some(profile => profile.id === 'custom-existing'));
  manager.activate('firered2-local');
  assert.deepEqual(manager.getActiveConnection(), {
    id: 'firered2-local', name: 'FireRed2 · 本机',
    url: 'ws://127.0.0.1:18011/api/asr/realtime', token: '', httpBaseUrl: 'http://127.0.0.1:18011',
  });
  manager.activate('tencent-direct');
  assert.equal(manager.list().activeProfileId, 'tencent-direct');
});

test("readiness probe cancels after ready without sending audio", async () => {
  const { probeAsrConnection } = await import('../src/helpers/asrConnectionProbe.mjs');
  const sent = [];
  class Socket {
    constructor() { queueMicrotask(() => this.onopen()); }
    send(value) {
      assert.equal(typeof value, 'string');
      const command = JSON.parse(value);
      sent.push(command.type);
      if (command.type === 'start') queueMicrotask(() => this.onmessage({ data: '{"type":"ready"}' }));
    }
    close() {}
  }
  const result = await probeAsrConnection({ url: 'ws://localhost' }, { WebSocketImpl: Socket, readinessOnly: true });
  assert.deepEqual(sent, ['start', 'cancel']);
  assert.equal(result.audioProcessingMs, undefined);
});
