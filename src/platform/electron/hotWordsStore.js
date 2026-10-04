// 完整本地词库与单次腾讯热词快照分开管理。旧文本文件保留并按变更合并导入。
const path = require("path");
const fs = require("fs");

const PROJECT_ROOT = path.join(__dirname, "..", "..", "..");
const BUNDLED_FILE = path.join(PROJECT_ROOT, "assets", "hot-words.txt");
const FILE_NAME = "hot-words.txt";
const MAX_TERMS = 128; // 腾讯硬上限
const DEFAULT_WEIGHT = 5;
const GROUPS = { coding: ['GitHub', 'commit', 'release', 'API', 'skills', 'bug', 'AGENTS.md', 'Codex', 'Markdown', 'branch', 'worker', 'README', 'agent', 'Git', 'Qwen3', 'fallback', 'skill', 'subagent', 'upstream', 'ACP', 'DeepSeek', 'TUI', 'NPM', 'analysis', 'repo', 'token', 'SDK', 'context', 'clone', 'fork', 'CLI', 'OpenClaw'],
  hardware: ['ADB', 'APK', 'Nano', 'USB', 'TTS', 'Ubuntu', 'OTA', 'AGX', 'GUI', 'GPU', 'AMD', 'ASR', 'Linux', 'CPU', 'ESP', 'GPS', 'IMU', 'K20', 'VAD', 'ARM', 'nx1', 'nx2', 'nx3', 'nx4', 'nx5', 'nx6', 'nx7'],
  network: ['WiFi', 'Wi-Fi', 'SSH', 'VNC', 'VPN', 'Tailscale', 'server', 'CDP', 'VPS'],
  personal: ['Ivan', 'Hermes', 'iPhone', 'Windows', 'Mac', 'Chrome'] };
const GROUP_NAMES = { coding: '开发与模型', hardware: '设备与硬件', network: '网络', personal: '常用专名', general: '其他词' };
const defaultGroup = term => Object.keys(GROUPS).find(g => GROUPS[g].some(t => t.toLowerCase() === term.toLowerCase())) || 'general';

/**
 * 决定词表文件来源，优先级从高到低：
 *   1. 环境变量 CAPS_HOT_WORDS_FILE
 *   2. 用户数据目录 ~/.config/语音转写/hot-words.txt
 *   3. 随包内置的 assets/hot-words.txt
 * 若 2 不存在而 3 存在，复制到 2，让用户只需维护一处。
 */
function resolveHotWordsPath(dataDirectory, fsImpl = fs) {
  const override = process.env.CAPS_HOT_WORDS_FILE;
  if (override) return override;

  const userPath = dataDirectory ? path.join(dataDirectory, FILE_NAME) : "";
  if (userPath && fsImpl.existsSync(userPath)) return userPath;

  if (userPath && fsImpl.existsSync(BUNDLED_FILE)) {
    try {
      fsImpl.copyFileSync(BUNDLED_FILE, userPath);
      return userPath;
    } catch {
      // 复制失败退回读内置文件
    }
  }
  return fsImpl.existsSync(BUNDLED_FILE) ? BUNDLED_FILE : userPath;
}

/**
 * 解析词表文本。每行 `词` 或 `词|权重`，# 开头为注释。
 * 权重非法时回落到默认权重；词去空白、去重（保留首次写法）。
 */
function parseHotWords(text, { maxTerms = Infinity, defaultWeight = DEFAULT_WEIGHT } = {}) {
  const entries = [];
  const seen = new Set();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let term = line;
    let weight = defaultWeight;
    const idx = line.lastIndexOf("|");
    if (idx > 0) {
      const maybeWeight = line.slice(idx + 1).trim();
      if (/^\d+$/.test(maybeWeight) && Number(maybeWeight) >= 1 && Number(maybeWeight) <= 11) {
        term = line.slice(0, idx).trim();
        weight = Number(maybeWeight);
      } else {
        // 权重非法：仍按第一个分隔符取词，绝不能让 | 进入发给腾讯的字符串
        term = line.slice(0, line.indexOf("|")).trim();
      }
    }
    // 词本身不许含分隔符
    term = term.replace(/\|/g, "").trim();
    if (!term) continue;

    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ term, weight });
    if (entries.length >= maxTerms) break;
  }
  return entries;
}

class HotWordsStore {
  constructor({ dataDirectory, logger = null, fsImpl = fs } = {}) {
    this.logger = logger;
    this.fs = fsImpl;
    this.filePath = resolveHotWordsPath(dataDirectory, fsImpl);
    this.dictionaryPath = path.join(dataDirectory || path.dirname(this.filePath), 'hot-words.json');
    this.entries = [];
    this.candidates = [];
    this.sourceHash = '';
    this.snapshots = new Map();
    this.activeGroups = Object.keys(GROUP_NAMES);
    this.managedWeights = false;
    this.load();
  }

  /** 从磁盘载入词表，返回词条数。失败返回 0 且不清空已有内容之外的数据。 */
  load() {
    this.loadError = null;
    try {
      if (this.fs.existsSync(this.dictionaryPath)) {
        const saved = JSON.parse(this.fs.readFileSync(this.dictionaryPath, 'utf8'));
        this.entries = saved.entries.map(normalizeEntry);
        this.candidates = Array.isArray(saved.candidates) ? saved.candidates.filter((s) => typeof s === 'string' && !termError(s)) : [];
        this.sourceHash = saved.sourceHash || '';
        this.activeGroups = Array.isArray(saved.activeGroups) ? saved.activeGroups.filter(g => GROUP_NAMES[g]) : Object.keys(GROUP_NAMES);
        this.managedWeights = saved.managedWeights === true;
      }
      const text = this.fs.readFileSync(this.filePath, "utf8");
      const hash = require('crypto').createHash('sha256').update(text).digest('hex');
      // 旧文件保留原样；手动新增/修改的行在下次录音合并，不截断旧词库。
      if (hash !== this.sourceHash) {
        const byTerm = new Map(this.entries.map((entry) => [entry.term.toLowerCase(), entry]));
        for (const entry of parseHotWords(text)) {
          const key = entry.term.toLowerCase();
          const existing = byTerm.get(key);
          // GUI 编辑后的 JSON 词条优先；旧文件追加不能重置已调整的权重。
          if (existing?.updatedAt > 0) continue;
          byTerm.set(key, normalizeEntry({ ...existing, ...entry }));
        }
        this.entries = [...byTerm.values()];
        this.sourceHash = hash;
      }
      return this.entries.length;
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadError = 'dictionary_unreadable';
      // 文件不存在是首次运行的正常情况，不算错误
      this.logger?.debug("热词表不可用", { path: this.filePath, error: error?.message || String(error) });
      return this.entries.length;
    }
  }

  /** 渲染进程用：拿到纯词条数组（不含权重）。 */
  list() {
    return this.entries.map((e) => e.term);
  }

  /** 渲染进程用：拿到可直接传给腾讯的字符串 "词|权重,词|权重"。 */
  toHotwordString() {
    return this.snapshot().hotword;
  }

  snapshot(context = '') {
    this.load();
    const active = this.entries.filter((e) => e.enabled !== false && !termError(e.term) &&
      (this.activeGroups.includes(e.group) || (e.updatedAt && Date.now() - e.updatedAt < 3 * 86400000)));
    const ranked = active.map((entry, index) => ({ entry, index,
      score: (context && [entry.term, ...entry.aliases].some((s) => context.includes(s)) ? 100 : 0) + entry.weight +
        (entry.updatedAt && Date.now() - entry.updatedAt < 3 * 86400000 ? 8 : 0),
    })).sort((a, b) => b.score - a.score || (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0) || a.index - b.index);
    const selected = ranked.slice(0, MAX_TERMS).map(({ entry }) => ({ ...entry,
      weight: this.managedWeights ? (entry.strong ? 11 : 5) : entry.weight }));
    const version = require('crypto').createHash('sha256').update(JSON.stringify([this.entries, this.activeGroups, this.managedWeights])).digest('hex').slice(0, 16);
    this.snapshots.set(version, structuredClone(this.entries));
    if (this.snapshots.size > 20) this.snapshots.delete(this.snapshots.keys().next().value);
    return { entries: selected, terms: selected.map((e) => e.term),
      ...(this.loadError ? { degraded: this.loadError } : {}),
      hotword: selected.map((e) => `${e.term}|${e.weight}`).join(','), version,
      total: this.entries.length, selected: selected.length, groups: GROUP_NAMES, activeGroups: this.activeGroups, managedWeights: this.managedWeights,
      omitted: active.length - selected.length,
      invalid: this.entries.filter((e) => termError(e.term)).map((e) => ({ term: e.term, reason: termError(e.term) })),
    };
  }

  entriesForVersion(version) {
    return version ? this.snapshots.get(version) : this.entries;
  }

  configure({ activeGroups, managedWeights }) {
    this.load();
    const oldGroups = this.activeGroups, oldManaged = this.managedWeights;
    if (Array.isArray(activeGroups)) this.activeGroups = [...new Set(activeGroups.filter(g => GROUP_NAMES[g]))];
    if (typeof managedWeights === 'boolean') this.managedWeights = managedWeights;
    if (!this.persist()) { this.activeGroups = oldGroups; this.managedWeights = oldManaged; throw new Error('词组保存失败'); }
    return this.snapshot();
  }

  /**
   * 追加确认后的词条，去重并原子保存完整词库。
   * 返回 { added, total, persisted }
   */
  add(terms, { weight = DEFAULT_WEIGHT } = {}) {
    this.load();
    const incoming = Array.isArray(terms) ? terms : [terms];
    const existingKeys = new Set(this.entries.map((e) => e.term.toLowerCase()));
    const fresh = [];
    const updatedAt = Date.now();
    for (const raw of incoming) {
      const term = String(raw || "").trim();
      if (termError(term)) continue;
      const key = term.toLowerCase();
      if (existingKeys.has(key)) continue;
      existingKeys.add(key); // 同一批里也去重
      fresh.push(normalizeEntry({ term, weight, updatedAt }));
    }
    const previous = this.entries.slice();
    if (fresh.length) this.entries.push(...fresh);
    const added = fresh.length;
    let persisted = false;
    if (added > 0) persisted = this.persist();
    if (added > 0 && !persisted) this.entries = previous;
    return { added: persisted ? added : 0, total: this.entries.length, persisted,
      rejected: incoming.filter((s) => termError(String(s || '').trim())).map((term) => ({ term, reason: termError(String(term || '').trim()) })) };
  }

  update(entry) {
    this.load();
    const normalized = normalizeEntry({ ...entry, updatedAt: Date.now() });
    const error = termError(normalized.term);
    if (error) throw new Error(error);
    const previous = this.entries.slice();
    const previousCandidates = this.candidates.slice();
    const index = this.entries.findIndex((e) => e.term.toLowerCase() === normalized.term.toLowerCase());
    if (index < 0) this.entries.push(normalized); else this.entries[index] = normalized;
    this.candidates = this.candidates.filter((s) => s.toLowerCase() !== normalized.term.toLowerCase());
    if (!this.persist()) { this.entries = previous; this.candidates = previousCandidates; throw new Error('词库保存失败'); }
    return this.snapshot();
  }

  propose(terms) {
    this.load();
    const existing = new Set(this.entries.map((e) => e.term.toLowerCase()));
    const previous = this.candidates;
    this.candidates = [...new Set([...this.candidates, ...terms.filter((s) => typeof s === 'string' && !termError(s) && !existing.has(s.toLowerCase()))])].slice(0, 256);
    if (!this.persist()) { this.candidates = previous; throw new Error('候选词保存失败'); }
    return { count: this.candidates.length, candidates: this.candidates };
  }

  /** 写回磁盘。失败不抛，返回 false。绝不写内置文件，避免污染随包资源。 */
  persist() {
    try {
      if (this.loadError) return false;
      // 内置词表是只读模板：复制失败时 filePath 会指向它，此时禁止回写
      if (!this.dictionaryPath) {
        this.logger?.warn("热词表路径不可写，跳过持久化", { path: this.filePath });
        return false;
      }
      const body = JSON.stringify({ version: 3, sourceHash: this.sourceHash, entries: this.entries, candidates: this.candidates,
        activeGroups: this.activeGroups, managedWeights: this.managedWeights }, null, 2) + '\n';
      const temporary = `${this.dictionaryPath}.tmp`;
      this.fs.writeFileSync(temporary, body, 'utf8');
      this.fs.renameSync(temporary, this.dictionaryPath);
      return true;
    } catch (error) {
      this.logger?.warn("热词表写入失败", { path: this.filePath, error: error?.message || String(error) });
      return false;
    }
  }
}

function termError(term) {
  if (!term) return '词条为空';
  if (/[\s,|\x00-\x1f]/u.test(term)) return '词条不能含空格、逗号或分隔符';
  if ([...term].length > 30 || (term.match(/\p{Script=Han}/gu) || []).length > 10) return '词条最多 30 个字符、10 个汉字';
  return null;
}

function normalizeEntry(entry) {
  const strings = (items) => [...new Set((Array.isArray(items) ? items : []).map(String).map((s) => s.trim()).filter((s) => s && s.length <= 100))].slice(0, 32);
  return { term: String(entry.term || '').trim(),
    weight: Number.isInteger(Number(entry.weight)) && Number(entry.weight) >= 1 && Number(entry.weight) <= 11 ? Number(entry.weight) : DEFAULT_WEIGHT,
    enabled: entry.enabled !== false, aliases: strings(entry.aliases), exclusions: strings(entry.exclusions),
    group: GROUP_NAMES[entry.group] ? entry.group : defaultGroup(String(entry.term || '')), strong: entry.strong === true,
    updatedAt: Number.isFinite(entry.updatedAt) ? Math.max(0, entry.updatedAt) : 0 };
}

module.exports = { HotWordsStore, parseHotWords, resolveHotWordsPath, MAX_TERMS, termError, normalizeEntry };
