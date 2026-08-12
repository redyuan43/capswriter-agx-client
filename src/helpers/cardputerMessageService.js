const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createHash } = require("crypto");
const ffmpegPath = require("ffmpeg-static");

const MAX_MESSAGES = 100;
const MAX_SOURCE_AUDIO_BYTES = 16 * 1024 * 1024;
const FONT_SHA256 = "21b96a0377f067833a93af3082eb28d4ffab7a8cd46bfd513286f1d64b7b0949";
const NOTIFY_SOURCE_SHA256 = "a7e960d3318295d877485e60fecf25841a28f3912797cfddd12a3b8449211d29";
const DEFAULT_BUNDLED_RESOURCES = path.resolve(__dirname, "../../assets/cardputer");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function cleanMessageId(value) {
  const id = String(value || "").trim();
  return id && id.length <= 180 && /^[a-zA-Z0-9:._+-]+$/.test(id) ? id : "";
}

function cleanAudioId(value) {
  const id = String(value || "").trim();
  return id && id.length <= 160 && /^[a-zA-Z0-9:._-]+$/.test(id) ? id : "";
}

function atomicJson(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

async function responseBuffer(response, limit) {
  if (!response.ok) throw new Error(`source returned HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > limit) throw new Error("source payload size is invalid");
  return buffer;
}

class CardputerMessageService {
  constructor({
    dataDirectory,
    logger,
    sourceBaseUrl = process.env.CHECK_BOARDS_BASE_URL || "http://agx.taild500c8.ts.net:8788",
    integrationToken = process.env.CHECK_BOARDS_CARDPUTER_TOKEN,
    fetchImpl = globalThis.fetch,
    transcode = null,
    bundledResources = DEFAULT_BUNDLED_RESOURCES,
  } = {}) {
    this.logger = logger;
    this.fetch = fetchImpl;
    this.sourceBaseUrl = String(sourceBaseUrl || "").trim().replace(/\/+$/, "");
    this.integrationToken = String(integrationToken || "").trim();
    this.root = path.join(dataDirectory || process.env.ELECTRON_USER_DATA || process.cwd(), "cardputer-messages");
    this.audioDir = path.join(this.root, "audio");
    this.systemDir = path.join(this.root, "system");
    this.tmpDir = path.join(this.root, "tmp");
    this.indexPath = path.join(this.root, "index.json");
    this.bundledResources = bundledResources;
    this.transcode = transcode || ((inputs, output) => this.runFfmpeg(inputs, output));
    fs.mkdirSync(this.audioDir, { recursive: true });
    fs.mkdirSync(this.systemDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.index = this.loadIndex();
    this.resourcePromise = null;
  }

  loadIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      return {
        cursor: Math.max(0, Number(parsed.cursor) || 0),
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        acknowledgements: parsed.acknowledgements || {},
      };
    } catch {
      return { cursor: 0, messages: [], acknowledgements: {} };
    }
  }

  persist() {
    atomicJson(this.indexPath, this.index);
  }

  authenticateIntegration(req) {
    if (!this.integrationToken) {
      throw Object.assign(new Error("Check Boards integration token is not configured"), { statusCode: 503 });
    }
    if (String(req.headers["x-check-boards-token"] || "").trim() !== this.integrationToken) {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    }
  }

  assertCardputer(device) {
    if (!device?.device_id || device.board !== "cardputer_adv") {
      throw Object.assign(new Error("Cardputer device is required"), { statusCode: 403 });
    }
  }

  async ingest(payload) {
    const messageId = cleanMessageId(payload?.message_id);
    const audioIds = Array.isArray(payload?.audio_ids) ? payload.audio_ids.map(cleanAudioId) : [];
    if (!messageId || !audioIds.length || audioIds.some((id) => !id)) {
      throw Object.assign(new Error("invalid Check Boards message"), { statusCode: 400 });
    }
    const existing = this.index.messages.find((item) => item.message_id === messageId);
    if (existing) return { accepted: true, duplicate: true, cursor: existing.cursor };

    const key = sha256(Buffer.from(messageId)).slice(0, 24);
    const inputFiles = [];
    try {
      for (let index = 0; index < audioIds.length; index += 1) {
        const response = await this.fetch(`${this.sourceBaseUrl}/api/audio/${encodeURIComponent(audioIds[index])}`);
        const buffer = await responseBuffer(response, MAX_SOURCE_AUDIO_BYTES);
        const inputPath = path.join(this.tmpDir, `${key}-${index}.wav`);
        fs.writeFileSync(inputPath, buffer, { mode: 0o600 });
        inputFiles.push(inputPath);
      }
      const outputPath = path.join(this.audioDir, `${key}.wav`);
      await this.transcode(inputFiles, outputPath);
      const audio = fs.readFileSync(outputPath);
      const cursor = ++this.index.cursor;
      const message = {
        schema_version: 1,
        cursor,
        message_id: messageId,
        card_id: String(payload.card_id || "").slice(0, 180),
        title: String(payload.title || "消息").slice(0, 120),
        summary: String(payload.summary || "").slice(0, 600),
        status: String(payload.status || "").slice(0, 32),
        received_at: String(payload.received_at || "").slice(0, 40),
        generated_at: String(payload.generated_at || "").slice(0, 40),
        audio_id: key,
        audio_size: audio.length,
        audio_sha256: sha256(audio),
      };
      this.index.messages.push(message);
      while (this.index.messages.length > MAX_MESSAGES) {
        const removed = this.index.messages.shift();
        if (removed?.audio_id && !this.index.messages.some((item) => item.audio_id === removed.audio_id)) {
          fs.rmSync(path.join(this.audioDir, `${removed.audio_id}.wav`), { force: true });
        }
      }
      this.persist();
      return { accepted: true, duplicate: false, cursor };
    } finally {
      for (const input of inputFiles) fs.rmSync(input, { force: true });
    }
  }

  async ensureSystemResources() {
    if (!this.resourcePromise) {
      this.resourcePromise = this.prepareSystemResources().catch((error) => {
        this.resourcePromise = null;
        throw error;
      });
    }
    return this.resourcePromise;
  }

  async prepareSystemResources() {
    const fontPath = path.join(this.systemDir, "DroidSansFallback.ttf");
    this.ensureBundledResource("DroidSansFallback.ttf", FONT_SHA256, fontPath);
    const notifyPath = path.join(this.systemDir, "F1_New_SMS.wav");
    if (!fs.existsSync(notifyPath)) {
      const oggPath = path.join(this.tmpDir, "F1_New_SMS.ogg");
      this.ensureBundledResource("F1_New_SMS.ogg", NOTIFY_SOURCE_SHA256, oggPath);
      await this.transcode([oggPath], notifyPath);
      fs.rmSync(oggPath, { force: true });
    }
    return {
      font: this.resourceMeta("font", fontPath),
      notification: this.resourceMeta("notification", notifyPath),
    };
  }

  ensureBundledResource(name, expectedHash, outputPath) {
    try {
      const current = fs.readFileSync(outputPath);
      if (sha256(current) === expectedHash) return;
    } catch {}
    const source = fs.readFileSync(path.join(this.bundledResources, name));
    if (sha256(source) !== expectedHash) throw new Error("bundled AOSP resource hash mismatch");
    const tmp = `${outputPath}.tmp`;
    fs.writeFileSync(tmp, source, { mode: 0o600 });
    fs.renameSync(tmp, outputPath);
  }

  resourceMeta(kind, filePath) {
    const buffer = fs.readFileSync(filePath);
    return {
      kind,
      size: buffer.length,
      sha256: sha256(buffer),
      url: `/device/messages/resource?kind=${kind}`,
    };
  }

  async sync(device, after = 0, limit = 20) {
    this.assertCardputer(device);
    const resources = await this.ensureSystemResources();
    const safeAfter = Math.max(0, Number(after) || 0);
    const safeLimit = Math.max(1, Math.min(20, Number(limit) || 20));
    const messages = this.index.messages
      .filter((item) => item.cursor > safeAfter)
      .slice(0, safeLimit)
      .map((item) => ({ ...item, audio_url: `/device/messages/resource?kind=audio&id=${item.audio_id}` }));
    return { cursor: this.index.cursor, resources, messages, has_more: messages.length === safeLimit };
  }

  resource(device, kind, id) {
    this.assertCardputer(device);
    if (kind === "font") return path.join(this.systemDir, "DroidSansFallback.ttf");
    if (kind === "notification") return path.join(this.systemDir, "F1_New_SMS.wav");
    const audioId = String(id || "");
    if (kind === "audio" && this.index.messages.some((item) => item.audio_id === audioId)) {
      return path.join(this.audioDir, `${audioId}.wav`);
    }
    return "";
  }

  acknowledge(device, cursor) {
    this.assertCardputer(device);
    this.index.acknowledgements[device.device_id] = Math.max(0, Number(cursor) || 0);
    this.persist();
    return { success: true, cursor: this.index.acknowledgements[device.device_id] };
  }

  runFfmpeg(inputs, outputPath) {
    return new Promise((resolve, reject) => {
      const listPath = path.join(this.tmpDir, `concat-${Date.now()}-${process.pid}.txt`);
      fs.writeFileSync(listPath, inputs.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
      const child = spawn(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let errorText = "";
      child.stderr.on("data", (chunk) => { errorText += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        fs.rmSync(listPath, { force: true });
        if (code === 0) resolve();
        else reject(new Error(errorText.trim() || `ffmpeg exited with ${code}`));
      });
    });
  }
}

module.exports = CardputerMessageService;
module.exports.cleanMessageId = cleanMessageId;
module.exports.cleanAudioId = cleanAudioId;
module.exports.sha256 = sha256;
module.exports.FONT_SHA256 = FONT_SHA256;
module.exports.NOTIFY_SOURCE_SHA256 = NOTIFY_SOURCE_SHA256;
