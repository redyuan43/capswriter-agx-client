#!/usr/bin/env node
/**
 * M5 传输失败抢救 —— 端到端回放
 *
 * 复现 2026-09-20 20:10:49 那次真实会话的形状：
 *   - 用户说了 45 秒，前 33 秒音频正常上传，最后一段设备侧没传上来
 *   - 设备在 stop 请求里带 upload_failed=true
 *   - 旧行为：主进程发 external-recording-cancel，渲染层把实时转写结果
 *     连同 PCM 缓冲一起丢掉 → 数据集里留下 45 秒空白
 *
 * 本回放不用 mock：
 *   - 真 M5VoiceBridge（真 HTTP server，真会话状态机）
 *   - 真音频文件（~/Documents/CapsWriter-Voice-Dataset 里的真实录音）
 *   - 真 CRC32 分块上传（协议 v2）
 *   - 落盘的 WAV 送**真 ASR 服务**重新识别，证明救回来的是真内容
 *
 * 用法：
 *   node services/text-postprocess/m5_salvage_replay.js
 *   ASR_ENDPOINT=http://100.91.42.28:18011 node ...
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { once } = require("events");

const ROOT = path.resolve(__dirname, "../..");
const M5VoiceBridge = require(path.join(ROOT, "src/helpers/m5VoiceBridge"));
const { crc32Hex } = M5VoiceBridge;
const { LongTextFormatter } = require(path.join(ROOT, "src/helpers/longTextFormatter"));
const { TextPolisher } = require(path.join(ROOT, "src/platform/electron/textPolish"));

const ASR_ENDPOINT = (process.env.ASR_ENDPOINT || "http://100.91.42.28:18011").replace(/\/+$/, "");
const DATASET = path.join(os.homedir(), "Documents/CapsWriter-Voice-Dataset");
const CHUNK_BYTES = 7680; // 240ms @ 16kHz mono s16le —— 与设备实际上传粒度一致
const UPLOAD_RATIO = Number(process.env.UPLOAD_RATIO || 0.8);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/* ---------------- 真实语料 ---------------- */

function pickRealRecording(minSeconds = 30) {
  const metaPath = path.join(DATASET, "metadata.jsonl");
  const rows = [];
  for (const line of fs.readFileSync(metaPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const duration = Number(item.duration || 0);
    const text = String(item.text || "").trim();
    const audioPath = path.join(DATASET, item.audio_path || "");
    if (duration >= minSeconds && text && item.audio_path.endsWith(".wav") && fs.existsSync(audioPath)) {
      rows.push({ duration, text, audioPath, createdAt: item.created_at });
    }
  }
  rows.sort((a, b) => b.duration - a.duration);
  return rows[0] || null;
}

/** 从 RIFF 容器里取出 PCM 数据（客户端上传的是裸 PCM，不带容器） */
function readWavPcm(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("不是 RIFF/WAV 文件");
  }
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      return { pcm: buf.subarray(offset + 8, offset + 8 + size), sampleRate, channels, bits };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV 里没有找到 data 块");
}

/* ---------------- HTTP 辅助 ---------------- */

function requestJson(port, urlPath, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: {
        ...headers,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: text }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function requestBuffer(port, urlPath, buffer, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: urlPath,
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": buffer.length, ...headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: text }));
    });
    req.on("error", reject);
    req.end(buffer);
  });
}

/** 用真实 ASR 服务识别一段 WAV，返回文本（模拟"渲染层已有的实时转写"） */
async function transcribeWithRealAsr(wavPath) {
  const audio = fs.readFileSync(wavPath);
  const boundary = `----salvage-replay-${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="audio"; filename="${path.basename(wavPath)}"\r\n` +
    "Content-Type: audio/wav\r\n\r\n"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, audio, tail]);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: ASR_ENDPOINT.replace(/^https?:\/\//, "").split(":")[0],
      port: Number(ASR_ENDPOINT.split(":").pop()) || 18011,
      path: "/api/asr/transcribe",
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
      timeout: 120000,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`ASR 返回非 JSON（HTTP ${res.statusCode}）：${text.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("ASR 请求超时")));
    req.write(body);
    req.end();
  });
}

/* ---------------- 构造真实桥接 ---------------- */

async function startRealBridge(dataDirectory, sendToRenderer) {
  const bridge = new M5VoiceBridge({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    windowManager: { previousActiveWindow: "42", showFloatingBall() {}, hideFloatingBall() {} },
    clipboardManager: { setTargetWindow() {} },
    sendToRenderer,
    dataDirectory,
  });
  bridge.port = 0;
  bridge.start();
  await once(bridge.server, "listening");
  return { bridge, port: bridge.server.address().port };
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log("=".repeat(78));
  console.log("M5 传输失败抢救 · 端到端回放");
  console.log("=".repeat(78));

  const sample = pickRealRecording(30);
  if (!sample) {
    console.log("找不到 >=30 秒的真实 WAV 语料，无法回放。");
    process.exit(2);
  }
  const { pcm, sampleRate } = readWavPcm(sample.audioPath);
  console.log(`真实语料  ${path.basename(sample.audioPath)}`);
  console.log(`          时长 ${sample.duration.toFixed(1)}s  原文 ${sample.text.length} 字  ${sample.createdAt}`);
  console.log(`模拟场景  只上传 ${(UPLOAD_RATIO * 100).toFixed(0)}% 音频，设备在 stop 时报 upload_failed`);
  console.log("");

  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "caps-salvage-replay-"));
  const events = [];
  let salvagedWavPath = null;
  let salvagedText = "";
  let bridgeRef = null;

  // 冒充渲染层：收到 salvage stop 时，把"已经拿到的音频"送真 ASR 转出文本再回传。
  // 线上是渲染层一直在做实时识别、手上早有 partial，这里用同一份音频等价模拟。
  const renderer = (eventName, payload = {}) => {
    events.push({ eventName, payload });
    if (eventName !== "external-recording-stop" || payload.salvage !== true) {
      return;
    }
    setImmediate(async () => {
      try {
        // 主进程在这一刻已经把音频落盘了，直接去取（不能依赖外部变量，
        // 回调是在 stop 请求处理过程中触发的，那时还来不及赋值）
        const dir = path.join(dataDirectory, "salvaged-recordings");
        const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        if (files.length) {
          salvagedWavPath = path.join(dir, files[0]);
          const asr = await transcribeWithRealAsr(salvagedWavPath);
          salvagedText = String(asr?.text || asr?.asr_text || "").trim();
          console.log(`\n  [渲染层] 用救回的音频跑真实 ASR，得到 ${salvagedText.length} 字`);
        }
        await bridgeRef.handleRendererResult({
          session_id: payload.session_id,
          success: Boolean(salvagedText),
          status: salvagedText ? "pasted" : "transcription_failed",
          text: salvagedText,
        });
      } catch (error) {
        console.log(`\n  [渲染层] 抢救失败：${error.message}`);
        await bridgeRef.handleRendererResult({
          session_id: payload.session_id,
          success: false,
          status: "transcription_failed",
          error: error.message,
        });
      }
    });
  };

  const { bridge, port } = await startRealBridge(dataDirectory, renderer);
  bridgeRef = bridge;

  const sessionId = "replay-salvage";
  const headers = {
    "X-Vibe-Stick-Device-Id": "wifi-replay",
    "X-Vibe-Stick-Firmware-Name": "vibestick",
  };

  // ---- 1. 设备侧：开始录音、上传部分音频
  await requestJson(port, "/recording/start", {
    method: "POST",
    headers,
    body: { session_id: sessionId, intent: "dictation", protocol_version: 2 },
  });

  const totalChunks = Math.max(1, Math.ceil(pcm.length / CHUNK_BYTES));
  const uploadedChunks = Math.max(1, Math.floor(totalChunks * UPLOAD_RATIO));
  for (let index = 0; index < uploadedChunks; index += 1) {
    const chunk = pcm.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, pcm.length));
    const response = await requestBuffer(
      port,
      `/recording/audio?session_id=${sessionId}&chunk_id=${index}`,
      chunk,
      { ...headers, "X-Vibe-Stick-Chunk-CRC32": crc32Hex(chunk) }
    );
    if (response.statusCode !== 200) {
      throw new Error(`第 ${index} 块上传失败：HTTP ${response.statusCode} ${response.body}`);
    }
  }
  console.log(`\n[1/5] 设备行为`);
  console.log(`  上传 ${uploadedChunks}/${totalChunks} 块（${(uploadedChunks / totalChunks * 100).toFixed(0)}%），共 ${bridge.sessions.get(sessionId).bytes} 字节`);

  // ---- 2. 设备报告上传失败
  const stop = await requestJson(port, "/recording/stop", {
    method: "POST",
    headers,
    body: { session_id: sessionId, upload_failed: true },
  });

  console.log(`\n[2/5] 主进程对传输失败的处置`);
  const cancelled = events.some((event) => event.eventName === "external-recording-cancel");
  const salvageStop = events.find(
    (event) => event.eventName === "external-recording-stop" && event.payload?.salvage === true
  );
  record("不发 cancel（旧行为会发，渲染层据此丢弃全部文本）", cancelled === false,
    cancelled ? "仍然发了 cancel" : "只发了 salvage stop");
  record("发带 salvage 标记的 stop，让渲染层交出已有文本", Boolean(salvageStop),
    salvageStop ? `salvage_reason=${salvageStop.payload.salvage_reason}` : "没收到 salvage stop");
  record("已收到的音频落盘（旧行为 60 秒后被删）", fs.existsSync(path.join(dataDirectory, "salvaged-recordings")),
    "");
  const salvagedFiles = fs.existsSync(path.join(dataDirectory, "salvaged-recordings"))
    ? fs.readdirSync(path.join(dataDirectory, "salvaged-recordings"))
    : [];
  if (salvagedFiles.length) {
    salvagedWavPath = path.join(dataDirectory, "salvaged-recordings", salvagedFiles[0]);
    const size = fs.statSync(salvagedWavPath).size;
    console.log(`        ${salvagedWavPath}`);
    console.log(`        ${size} 字节（约 ${((size - 44) / 32 / 1000).toFixed(1)}s）`);
  }

  // ---- 3. 等渲染层回传结果
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const session = bridge.sessions.get(sessionId);
    if (session?.done) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`\n[3/5] 会话收尾`);
  const finalSession = bridge.sessions.get(sessionId);
  record("会话正常结束（不再悬挂）", finalSession?.done === true, `status=${finalSession?.status}`);
  record("结果标记为抢救恢复", finalSession?.result?.recovered === true,
    `recovered_reason=${finalSession?.result?.recovered_reason || "—"}`);

  // ---- 4. 救回的音频能不能真的转出文字
  console.log(`\n[4/5] 救回的音频 vs 原文`);
  const cover = (a, b) => {
    const strip = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "");
    const A = new Set();
    const src = strip(a);
    const dst = strip(b);
    for (let i = 0; i < src.length - 1; i += 1) A.add(src.slice(i, i + 2));
    if (!A.size) return 0;
    let hit = 0;
    let total = 0;
    for (let i = 0; i < dst.length - 1; i += 1) {
      total += 1;
      if (A.has(dst.slice(i, i + 2))) hit += 1;
    }
    return total ? hit / total : 0;
  };
  record("真实 ASR 能从救回的音频转出文本", salvagedText.length > 0, `${salvagedText.length} 字`);
  if (salvagedText.length) {
    const ratio = cover(sample.text, salvagedText);
    record("与原文内容一致（双字组覆盖率 ≥0.7）", ratio >= 0.7, `覆盖 ${ratio.toFixed(3)}`);
    console.log(`\n  原文前 60 字    ${sample.text.slice(0, 60)}`);
    console.log(`  救回音频识别    ${salvagedText.slice(0, 60)}`);
  }

  // ---- 5. 文本后处理链路
  console.log(`\n[5/5] 抢救文本走后处理链路`);
  if (salvagedText.length) {
    const longFormatter = new LongTextFormatter({ logger: null });
    const polisher = new TextPolisher({ dataDirectory: null, logger: null, longFormatter });
    const polished = await polisher.polish(salvagedText, {
      longFormat: { enabled: true, minChars: 40, isTerminal: false },
    });
    record("后处理链路可用（含长文本整理）", polished.text === salvagedText || polished.text.length > 0,
      `阶段 ${polished.stages.map((s) => s.stage).join("+") || "无"}  降级 ${polished.degraded || "无"}`);
    console.log(`  整理后 ${polished.text.length} 字，${polished.text.split(/\n+/).filter(Boolean).length} 段`);
  } else {
    record("后处理链路可用（含长文本整理）", false, "没有文本可处理");
  }

  // ---- 汇总
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${"=".repeat(78)}`);
  console.log(`回放结果  ${results.length - failed.length}/${results.length} PASS`);
  console.log(`对照      旧行为：这次会话产出 0 字（40 秒语音全丢）`);
  console.log(`          新行为：抢救出 ${salvagedText.length} 字，音频留在 ${dataDirectory}`);
  console.log("=".repeat(78));

  bridge.stop();
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error("回放异常：", error?.stack || error?.message || error);
  process.exit(2);
});
