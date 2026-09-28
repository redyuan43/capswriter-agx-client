const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes, randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { TencentProvider } = require('./tencentProvider');
const { TencentQuota, freeSeconds } = require('./tencentQuota');
const { relayTencent } = require('./tencentRealtimeRelay');
const MAX_UPLOAD = 100 * 1024 * 1024;

// 仅客户端内部使用的回环适配层，随应用退出。随机地址防止网页调用本机付费接口。
// 云端密钥不进入地址或 renderer；各入口继续使用同一套 PCM / multipart 协议。
class TencentDirectBridge {
  constructor({ dataDirectory, getCredentials, hotWordsStore, provider, quota } = {}) {
    this.provider = provider || new TencentProvider({ getCredentials });
    this.quota = quota || new TencentQuota({ dataDirectory });
    this.hotWordsStore = hotWordsStore;
    this.prefix = `/${randomBytes(32).toString('hex')}`;
    this.filesActive = 0;
    this.fileControllers = new Set();
    this.lastCheck = 0;
  }

  async refreshQuota() {
    if (this.refreshing) return this.refreshing;
    if (Date.now() - this.lastCheck < 60000) return;
    this.lastCheck = Date.now();
    this.refreshing = this.provider.resources().then((rows) => this.quota.observe(freeSeconds(rows)))
      .catch(() => { this.quota.known = false; }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  authorized(request) {
    const origin = request.headers.origin;
    // 打包后的 Electron 页面发出的 WebSocket Origin 为 file://，与 HTTP 的 null 不同。
    return request.url.startsWith(`${this.prefix}/`) && (!origin || origin === 'null' || origin === 'file://' || /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin));
  }

  async connection() {
    if (!this.starting) this.starting = this.start().catch((e) => { this.starting = null; throw e; });
    await this.starting;
    await this.refreshQuota();
    return { id: 'tencent-direct', name: '腾讯云 · 本机直连',
      url: `ws://127.0.0.1:${this.port}${this.prefix}/api/asr/realtime`,
      httpBaseUrl: `http://127.0.0.1:${this.port}${this.prefix}`, token: '' };
  }

  async start() {
    this.server = http.createServer((req, res) => { void this.handleHttp(req, res); });
    this.server.requestTimeout = 120000;
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: 320000 });
    this.server.on('upgrade', (req, socket, head) => {
      if (!this.authorized(req) || req.url !== `${this.prefix}/api/asr/realtime` || this.sockets.clients.size >= 2) { socket.destroy(); return; }
      this.sockets.handleUpgrade(req, socket, head, (client) => {
        // 不把异步额度查询插在 upgrade 与 message 监听之间，避免吞掉 start。
        relayTencent(client, { provider: this.provider, quota: this.quota, getSnapshot: () => this.hotWordsStore.snapshot() });
        void this.refreshQuota();
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    await this.refreshQuota();
  }

  async handleHttp(req, res) {
    if (!this.authorized(req)) { res.writeHead(403); res.end(); return; }
    if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept'); res.writeHead(204); res.end(); return;
    }
    const route = req.url.slice(this.prefix.length);
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && ['/health', '/api/health', '/api/status', '/api/asr/status'].includes(route)) {
      await this.refreshQuota();
      let ready = true;
      try { this.provider.credentials(); } catch { ready = false; }
      json(200, { status: ready ? 'ready' : 'not_configured', ready, asr_ready: ready, provider: 'tencent', ...this.quota.status(),
        capabilities: { asr: true, optimize: false, translate: false } }); return;
    }
    if (req.method !== 'POST' || !['/api/asr/transcribe', '/api/asr/transcribe-and-optimize', '/api/asr/transcribe-and-optimize-stream'].includes(route)) { json(404, { success: false, error: '接口不存在' }); return; }
    if (this.filesActive >= 2) { json(429, { success: false, error: '文件转写繁忙' }); return; }
    this.filesActive++;
    let heartbeat;
    const streaming = route.endsWith('-stream');
    if (streaming) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"stage":"processing"}\n\n');
      heartbeat = setInterval(() => { if (!res.destroyed) res.write('data: {"stage":"processing"}\n\n'); }, 5000);
    }
    const controller = new AbortController();
    this.fileControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 240000);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    let folder;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw new Error('上传文件不能超过 100 MB');
        chunks.push(chunk);
      }
      const form = await new Request('http://localhost', { method: 'POST', body: Buffer.concat(chunks),
        headers: { 'Content-Type': req.headers['content-type'] || '' } }).formData();
      const audio = form.get('audio');
      if ([...form].length > 20 || [...form].some(([name, value]) => name !== 'audio' && (typeof value !== 'string' || value.length > 32768))) throw new Error('上传表单字段无效或过长');
      if (!audio || typeof audio.arrayBuffer !== 'function' || !audio.size || form.getAll('audio').length !== 1) throw new Error('请选择一个非空音频文件');
      if (form.get('optimize_mode') === 'translate') throw new Error('腾讯直连不支持翻译');
      folder = fs.mkdtempSync(path.join(os.tmpdir(), 'capswriter-tencent-'));
      const source = path.join(folder, 'upload.bin'), target = path.join(folder, 'audio.mp3');
      fs.writeFileSync(source, Buffer.from(await audio.arrayBuffer()));
      await convertAudio(source, target, controller.signal);
      const bytes = fs.readFileSync(target);
      if (!bytes.length || bytes.length > 7200 * 8000 + 32768) throw new Error('文件时长不能超过两小时');
      const snapshot = this.hotWordsStore.snapshot();
      const id = randomUUID();
      this.quota.begin(id, 'flash_16k_zh');
      let result;
      try {
        result = await this.provider.flash(bytes, snapshot.hotword, controller.signal);
        this.quota.record(id, bytes.length / 8000, 'completed');
      } catch (e) { this.quota.record(id, bytes.length / 8000, 'failed'); throw e; }
      const text = (result.flash_result || []).map((s) => s.text || '').join('');
      const payload = { type: 'final', stage: 'done', success: true, text, asr_text: text, raw_text: text, final_text: text,
        provider: 'tencent', engine: '16k_zh', session_id: id, segments: result.flash_result || [],
        hotword: snapshot.hotword, dictionary_version: snapshot.version, postprocess_mode: 'none' };
      if (streaming) res.end(`data: ${JSON.stringify(payload)}\n\n`);
      else json(200, payload);
    } catch (e) {
      const failure = { stage: 'error', success: false, error: controller.signal.aborted ? '文件转写已取消或超时' :
        /^(?:上传|请选择|腾讯直连|文件时长)/.test(e.message) ? e.message : '文件识别失败，请检查凭据和音频格式' };
      if (!res.destroyed) {
        if (streaming) res.end(`data: ${JSON.stringify(failure)}\n\n`); else json(400, failure);
      }
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat); this.fileControllers.delete(controller); res.removeListener('close', cancel);
      if (folder) fs.rmSync(folder, { recursive: true, force: true });
      this.filesActive--;
    }
  }

  dispose() {
    for (const c of this.fileControllers) c.abort();
    for (const client of this.sockets?.clients || []) client.close();
    this.sockets?.close(); this.server?.close(); this.server?.closeAllConnections();
  }
}

function convertAudio(source, target, signal) {
  return new Promise((resolve, reject) => {
    const ffmpeg = require('./ffmpegExecutable').ffmpegExecutable();
    const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', 'wav,mp3,ogg,matroska,webm,mov,aac,amr,flac', '-i', source, '-t', '7201',
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', target], { stdio: 'ignore', signal });
    const timer = setTimeout(() => child.kill(), 120000);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('音频转换失败')); });
  });
}

module.exports = { TencentDirectBridge, convertAudio };
