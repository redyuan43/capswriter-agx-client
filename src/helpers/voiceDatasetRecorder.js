const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const DEFAULT_DATASET_FOLDER = "CapsWriter-Voice-Dataset";

function sanitizeFilenamePart(value, maxLength = 24) {
  const text = String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\\/:"*?<>|]/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  return text || "empty";
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLocalParts(date) {
  const year = String(date.getFullYear());
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const time = `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const isoLocal = `${year}-${month}-${day}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return { year, month, day, time, isoLocal };
}

function extensionFromMime(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  return "wav";
}

function toBuffer(audio) {
  if (!audio) return null;
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof ArrayBuffer) return Buffer.from(audio);
  if (ArrayBuffer.isView(audio)) {
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  return null;
}

function safeJsonValue(value, depth = 0) {
  if (depth > 6) return "[MaxDepth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 12000 ? `${value.slice(0, 12000)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map(item => safeJsonValue(item, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "audio" || key === "audioBuffer" || key === "audioData") continue;
      result[key] = safeJsonValue(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

class VoiceDatasetRecorder {
  constructor({ documentsDirectory, logger = null } = {}) {
    const configuredDir = String(process.env.CAPS_CLIENT_VOICE_DATASET_DIR || "").trim();
    const defaultDocumentsDir = documentsDirectory || path.join(os.homedir(), "Documents");
    this.rootDir = configuredDir || path.join(defaultDocumentsDir, DEFAULT_DATASET_FOLDER);
    this.logger = logger;
    this.enabled = !DISABLED_VALUES.has(String(process.env.CAPS_CLIENT_VOICE_DATASET_ENABLED || "1").trim().toLowerCase());
    this.queue = Promise.resolve();
  }

  record(sample = {}) {
    if (!this.enabled) {
      return Promise.resolve({ success: true, skipped: true, reason: "disabled" });
    }

    this.queue = this.queue
      .catch(() => {})
      .then(() => this.writeSample(sample));
    return this.queue;
  }

  async writeSample(sample) {
    const audioBuffer = toBuffer(sample.audio);
    if (!audioBuffer || audioBuffer.length === 0) {
      return { success: false, skipped: true, error: "empty_audio" };
    }

    const now = new Date();
    const { year, month, day, time, isoLocal } = formatLocalParts(now);
    const sampleId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
    const text = String(sample.text || sample.final_text || sample.raw_text || "").trim();
    const textPart = sanitizeFilenamePart(text);
    const shortId = sampleId.slice(0, 8);
    const ext = extensionFromMime(sample.audioMimeType);
    const monthDir = path.join(this.rootDir, year, month);
    const assetsDir = path.join(monthDir, "assets");
    const stem = `(${year}${month}${day}-${time})${textPart}-${shortId}`;
    const audioPath = path.join(assetsDir, `${stem}.${ext}`);
    const textPath = path.join(assetsDir, `${stem}.txt`);
    const metadataPath = path.join(this.rootDir, "metadata.jsonl");
    const dayMarkdownPath = path.join(monthDir, `${day}.md`);

    await fs.promises.mkdir(assetsDir, { recursive: true });
    await fs.promises.writeFile(audioPath, audioBuffer);
    await fs.promises.writeFile(textPath, `${text}\n`, "utf8");

    const metadata = {
      id: sampleId,
      created_at: isoLocal,
      source: sample.source || "client",
      mode: sample.mode || "transcribe",
      request_id: sample.request_id || null,
      audio_path: path.relative(this.rootDir, audioPath).split(path.sep).join("/"),
      text_path: path.relative(this.rootDir, textPath).split(path.sep).join("/"),
      audio_mime_type: sample.audioMimeType || null,
      file_size: audioBuffer.length,
      text,
      asr_text: sample.asr_text || "",
      raw_asr_text: sample.raw_asr_text || "",
      final_text: sample.final_text || text,
      duration: sample.duration || null,
      language: sample.language || null,
      confidence: sample.confidence || null,
      hotword: sample.hotword || "",
      translate_target: sample.translate_target || "",
      postprocess_mode: sample.postprocess_mode || "none",
      voice_command_applied: sample.voice_command_applied === true,
      voice_command_type: sample.voice_command_type || "",
      voice_intent_id: sample.voice_intent_id || "",
      local_audio_stats: safeJsonValue(sample.local_audio_stats || {}),
      server_audio_stats: safeJsonValue(sample.server_audio_stats || {}),
      result_payload: safeJsonValue(sample.result_payload || {}),
    };

    await fs.promises.appendFile(metadataPath, `${JSON.stringify(metadata, null, 0)}\n`, "utf8");
    if (!fs.existsSync(dayMarkdownPath)) {
      await fs.promises.writeFile(dayMarkdownPath, "# 客户端语音训练数据\n\n", "utf8");
    }
    const relAudio = path.relative(path.dirname(dayMarkdownPath), audioPath).split(path.sep).join("/").replace(/ /g, "%20");
    await fs.promises.appendFile(dayMarkdownPath, `[${isoLocal.slice(11)}](${relAudio}) ${text}\n\n`, "utf8");

    return {
      success: true,
      id: sampleId,
      audioPath,
      textPath,
      metadataPath,
    };
  }
}

module.exports = VoiceDatasetRecorder;
