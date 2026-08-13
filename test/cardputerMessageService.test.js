const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const CardputerMessageService = require("../src/helpers/cardputerMessageService");
const { truncateUtf8 } = CardputerMessageService;
const { sha256, FONT_SHA256, NOTIFY_SOURCE_SHA256 } = CardputerMessageService;

function device() {
  return { device_id: "28:84:85:76:25:c0", board: "cardputer_adv" };
}

test("bundled AOSP font and notification keep their pinned hashes", () => {
  const resources = path.resolve(__dirname, "../assets/cardputer");
  assert.equal(sha256(fs.readFileSync(path.join(resources, "DroidSansFallback.ttf"))), FONT_SHA256);
  assert.equal(sha256(fs.readFileSync(path.join(resources, "F1_New_SMS.ogg"))), NOTIFY_SOURCE_SHA256);
});

test("ingest accepts fixed audio ids, transcodes once, and deduplicates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cardputer-message-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fetched = [];
  const service = new CardputerMessageService({
    dataDirectory: root,
    sourceBaseUrl: "http://check-boards:8788",
    integrationToken: "secret",
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("source wav") };
    },
    transcode: async (_inputs, output) => fs.writeFileSync(output, "converted wav"),
  });
  service.ensureSystemResources = async () => ({ font: {}, notification: {} });
  const payload = {
    message_id: "card-1:2026-08-12T10:00:00.000Z",
    card_id: "card-1",
    title: "标题",
    summary: "中文摘要",
    audio_ids: ["tts:one", "tts:two"],
  };
  const first = await service.ingest(payload);
  const second = await service.ingest(payload);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(fetched.length, 2);
  const sync = await service.sync(device(), 0, 20);
  assert.equal(sync.messages.length, 1);
  assert.equal(sync.messages[0].summary, "中文摘要");
  assert.match(sync.messages[0].audio_url, /^\/device\/messages\/resource/);
});

test("integration and device endpoints reject untrusted callers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cardputer-auth-"));
  const service = new CardputerMessageService({ dataDirectory: root, integrationToken: "secret" });
  assert.throws(() => service.authenticateIntegration({ headers: {} }), /unauthorized/);
  assert.throws(() => service.assertCardputer({ board: "sticks3" }), /Cardputer/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("empty devices bootstrap from only the latest messages", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cardputer-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new CardputerMessageService({ dataDirectory: root });
  service.ensureSystemResources = async () => ({ font: {}, notification: {} });
  service.ensureAudioPipeline = async () => {};
  service.index.cursor = 8;
  service.index.messages = Array.from({ length: 8 }, (_, index) => ({
    cursor: index + 1,
    audio_id: `audio-${index + 1}`,
  }));

  const first = await service.sync(device(), 0, 1, 4);
  const next = await service.sync(device(), first.messages[0].cursor, 1, 4);

  assert.equal(first.messages[0].cursor, 5);
  assert.equal(next.messages[0].cursor, 6);
});

test("duplicate delivery can backfill spoken text", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cardputer-spoken-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new CardputerMessageService({ dataDirectory: root });
  service.index.messages.push({ message_id: "message-1", cursor: 1 });

  const result = await service.ingest({
    message_id: "message-1",
    audio_ids: ["audio-1"],
    spoken_text: "设备 agx，目录 check_boards。处理完成。",
  });

  assert.equal(result.duplicate, true);
  assert.equal(service.index.messages[0].spoken_text, "设备 agx，目录 check_boards。处理完成。");
});

test("recent legacy audio is normalized once and versioned", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cardputer-audio-migrate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let transcodes = 0;
  const service = new CardputerMessageService({
    dataDirectory: root,
    transcode: async (inputs, output) => {
      transcodes += 1;
      fs.copyFileSync(inputs[0], output);
    },
  });
  fs.writeFileSync(path.join(service.audioDir, "legacy.wav"), "legacy-audio");
  service.index.messages.push({ audio_id: "legacy" });

  await service.ensureAudioPipeline();
  await service.ensureAudioPipeline();

  assert.equal(transcodes, 1);
  assert.equal(service.index.messages[0].audio_pipeline_version, "loudnorm-v1");
});

test("spoken text truncation preserves UTF-8 boundaries", () => {
  const text = truncateUtf8("中".repeat(400), 1024);
  assert.ok(Buffer.byteLength(text) <= 1024);
  assert.equal(text.includes("�"), false);
});
