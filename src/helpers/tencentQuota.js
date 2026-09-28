const fs = require('fs');
const path = require('path');
const { STANDARD, MODEL2 } = require('./tencentProvider');
const RESERVE = 120;
const monthAt = (time) => new Date(time + 8 * 3600000).toISOString().slice(0, 7);

function freeSeconds(packages, now = Date.now()) {
  let found = false, total = 0;
  for (const p of packages) {
    if (p.SubProductCode !== 'sp_asr_realtime_prepay' || !String(p.Unit).startsWith('free|')) continue;
    const start = Date.parse(`${p.EffectiveTime.replace(' ', 'T')}+08:00`);
    const end = Date.parse(`${p.ExpiryTime.replace(' ', 'T')}+08:00`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('额度日期无效');
    if (now < start || now > end) continue;
    const remaining = Number(p.RestNumFloat ?? p.RestNum);
    const capacity = Number(p.TotalNumFloat ?? p.TotalNum);
    if (!Number.isFinite(remaining) || !Number.isFinite(capacity) || remaining < 0 || remaining > capacity) throw new Error('额度数据无效');
    found = true;
    total += remaining;
  }
  return found ? total : null;
}

class TencentQuota {
  constructor({ dataDirectory, clock = Date.now } = {}) {
    this.filePath = path.join(dataDirectory, 'tencent-usage.json');
    this.clock = clock;
    this.state = { credits: {}, sessions: {} };
    this.known = false;
    this.checkedAt = 0;
    try { this.state = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') this.invalid = true;
    }
    if (!this.state.credits || !this.state.sessions) { this.invalid = true; this.state = { credits: {}, sessions: {} }; }
    for (const s of Object.values(this.state.sessions)) if (s.state === 'active') { s.seconds = Math.max(RESERVE, s.seconds); s.state = 'interrupted'; }
  }

  persist() {
    if (this.invalid) throw new Error('本地额度账本损坏，请检查 tencent-usage.json');
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  total(month, engine = STANDARD) {
    return Object.values(this.state.sessions).filter((s) => s.month === month && s.engine === engine).reduce((v, s) => v + s.seconds, 0);
  }

  observe(seconds) {
    this.checkedAt = this.clock();
    this.checkedMonth = monthAt(this.checkedAt);
    this.known = Number.isFinite(seconds) && seconds >= 0;
    if (!this.known) return;
    const used = this.total(this.checkedMonth);
    const old = this.state.credits[this.checkedMonth];
    this.state.credits[this.checkedMonth] = { remaining: old ? Math.min(seconds, Math.max(0, old.remaining - (used - old.baseline))) : seconds,
      baseline: used, blocked: old?.blocked || false };
    this.persist();
  }

  status() {
    const month = monthAt(this.clock());
    const row = this.state.credits[month];
    const known = !!(this.known && this.checkedMonth === month && this.clock() - this.checkedAt <= 90000 && row);
    const remaining = known ? row.blocked ? 0 : Math.max(0, row.remaining - (this.total(month) - row.baseline)) : null;
    const reserved = Object.values(this.state.sessions).filter((s) => s.month === month && s.engine === STANDARD && s.state === 'active')
      .reduce((v, s) => v + Math.max(0, RESERVE - s.seconds), 0);
    const engine = known && remaining - reserved >= RESERVE ? STANDARD : MODEL2;
    return { engine, quota: { known, remaining_seconds: remaining, checked_at: this.checkedAt / 1000, month,
      message: known ? `免费余量约 ${Math.floor(remaining)} 秒${engine === MODEL2 ? '，使用 2.0' : ''}` : '未确认免费额度，使用 2.0', reserve_seconds: RESERVE },
      usage_seconds: { standard: this.total(month), model2: this.total(month, MODEL2), flash: this.total(month, 'flash_16k_zh') } };
  }

  // 选引擎和预留在同一个同步操作内完成，不能跨过握手 await。
  begin(id, engine) {
    const selected = engine || this.status().engine;
    this.state.sessions[id] = { month: monthAt(this.clock()), engine: selected, seconds: 0, state: 'active' };
    this.persist();
    return selected;
  }

  record(id, seconds, state = 'active') {
    const s = this.state.sessions[id];
    if (!s) return;
    s.seconds = Math.max(s.seconds, Math.ceil(seconds)); s.state = state;
    this.persist();
  }

  exhausted() {
    const month = monthAt(this.clock());
    this.state.credits[month] = { remaining: 0, baseline: this.total(month), blocked: true };
    this.persist();
  }
}

module.exports = { TencentQuota, freeSeconds, monthAt };
