const crypto = require('crypto');

const STANDARD = '16k_zh';
const MODEL2 = '16k_zh_en_2.0';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value, algorithm = 'sha256') => crypto.createHmac(algorithm, key).update(value).digest();
const query = (params) => Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');

function realtimeUrl(credentials, engine, voiceId, hotword = '', now = Math.floor(Date.now() / 1000), nonce = crypto.randomInt(1, 1000000000)) {
  const params = { engine_model_type: engine, expired: now + 600, secretid: credentials.tencentSecretId,
    timestamp: now, nonce, voice_id: voiceId, voice_format: 1, needvad: 1, sub_service_type: 1,
    convert_num_mode: 1, filter_dirty: 0, filter_modal: 0, filter_punc: 0 };
  if (engine === STANDARD) params.word_info = 2;
  if (hotword) params.hotword_list = hotword;
  const hostPath = `asr.cloud.tencent.com/asr/v2/${credentials.tencentAppId}`;
  const signature = hmac(credentials.tencentSecretKey, `${hostPath}?${query(params)}`, 'sha1').toString('base64');
  return `wss://${hostPath}?${new URLSearchParams({ ...params, signature })}`;
}

function cloudRequest(credentials, action, params, stamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(params);
  const date = new Date(stamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonical = `POST\n/\n\ncontent-type:${contentType}\nhost:asr.tencentcloudapi.com\n\ncontent-type;host\n${hash(body)}`;
  const scope = `${date}/asr/tc3_request`;
  let key = Buffer.from(`TC3${credentials.tencentSecretKey}`);
  for (const part of [date, 'asr', 'tc3_request']) key = hmac(key, part);
  const signature = hmac(key, `TC3-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`).toString('hex');
  return { body, headers: { 'Content-Type': contentType, 'X-TC-Action': action, 'X-TC-Version': '2019-06-14',
    'X-TC-Timestamp': String(stamp), 'X-TC-Region': 'ap-guangzhou',
    Authorization: `TC3-HMAC-SHA256 Credential=${credentials.tencentSecretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}` } };
}

async function readJson(fetchImpl, url, init, timeout = 4000) {
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) { await response.body?.cancel?.(); throw new Error(`腾讯请求失败 HTTP ${response.status}`); }
  return response.json();
}

class TencentProvider {
  constructor({ getCredentials, fetchImpl = globalThis.fetch } = {}) { this.getCredentials = getCredentials; this.fetch = fetchImpl; }

  credentials() {
    const c = this.getCredentials();
    if (!/^\d+$/.test(c.tencentAppId) || !c.tencentSecretId || !c.tencentSecretKey) throw new Error('请先配置腾讯 AppId、SecretId 和 SecretKey');
    return c;
  }

  realtimeUrl(engine, id, hotword) { return realtimeUrl(this.credentials(), engine, id, hotword); }

  async resources() {
    const rows = [];
    const deadline = Date.now() + 4000;
    for (let page = 1; page <= 20; page++) {
      const request = cloudRequest(this.credentials(), 'DescribePidOrders', { AvailableType: 0, Page: page, PageSize: 100 });
      const result = (await readJson(this.fetch, 'https://asr.tencentcloudapi.com', { method: 'POST', ...request }, Math.max(1, deadline - Date.now()))).Response;
      if (result?.Error || !Array.isArray(result?.PidOrders) || !Number.isFinite(result.TotalCount)) throw new Error('腾讯额度查询不可用');
      rows.push(...result.PidOrders);
      if (rows.length >= result.TotalCount) return rows;
      if (!result.PidOrders.length) break;
    }
    throw new Error('腾讯额度分页不完整');
  }

  async flash(audio, hotword, signal) {
    const c = this.credentials();
    const params = { engine_type: STANDARD, secretid: c.tencentSecretId, timestamp: Math.floor(Date.now() / 1000),
      voice_format: 'mp3', filter_punc: 0, convert_num_mode: 1 };
    if (hotword) params.hotword_list = hotword;
    const hostPath = `asr.cloud.tencent.com/asr/flash/v1/${c.tencentAppId}`;
    const authorization = hmac(c.tencentSecretKey, `POST${hostPath}?${query(params)}`, 'sha1').toString('base64');
    const response = await this.fetch(`https://${hostPath}?${new URLSearchParams(params)}`, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
      headers: { Authorization: authorization, 'Content-Type': 'application/octet-stream' }, body: audio,
    });
    if (!response.ok) { await response.body?.cancel?.(); throw new Error(`腾讯请求失败 HTTP ${response.status}`); }
    const data = await response.json();
    if (data.code !== 0) throw new Error(`腾讯文件识别失败（${Number(data.code) || 'unknown'}）`);
    return data;
  }
}

// 同时兼容经典 result 和实时 V2 sentences，保留原始时间戳和词边界。
function normalizeSegments(data) {
  const list = data.sentences?.sentence_list || [];
  const segments = list.map((s) => ({ id: Number(s.sentence_id), text: String(s.sentence || ''),
    isFinal: s.sentence_type === 1, startTime: s.start_time, endTime: s.end_time, words: s.word_list || [] }));
  const s = data.result;
  if (s && typeof s.voice_text_str === 'string') segments.push({ id: Number(s.index || 0), text: s.voice_text_str,
    isFinal: s.slice_type === 2, startTime: s.start_time, endTime: s.end_time, words: s.word_list || [] });
  return segments.filter((s) => Number.isInteger(s.id) && s.id >= 0);
}

function joinSegments(segments) {
  return segments.reduce((result, s) => result + (/[A-Za-z0-9,.!?;:)]$/.test(result) && /^[A-Za-z0-9]/.test(s.text) ? ' ' : '') + s.text, '');
}

module.exports = { TencentProvider, realtimeUrl, cloudRequest, normalizeSegments, joinSegments, STANDARD, MODEL2 };
