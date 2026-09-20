/**
 * ASR 热词表管理（主进程侧）
 *
 * 腾讯 ASR 支持热词（hotword_list），格式为「词|权重」，权重 1-11，最多 128 个词。
 * 真实 A/B 实验（34 条真实音频同样本对照）结论：
 *   无热词 50% → 9词@权重5 59% → 9词@权重11 68% → 128词@分级权重 71%
 * 即：权重越高越好，词越多越好（在 128 上限内）。
 *
 * 这里负责把用户维护的 hot-words.txt 读出来，提供给录音链路随每次请求发出。
 */

const path = require("path");
const fs = require("fs");

const PROJECT_ROOT = path.join(__dirname, "..", "..", "..");
const BUNDLED_FILE = path.join(PROJECT_ROOT, "assets", "hot-words.txt");
const FILE_NAME = "hot-words.txt";
const MAX_TERMS = 128; // 腾讯硬上限
const DEFAULT_WEIGHT = 11;

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
function parseHotWords(text, { maxTerms = MAX_TERMS, defaultWeight = DEFAULT_WEIGHT } = {}) {
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
    this.entries = [];
    this.load();
  }

  /** 从磁盘载入词表，返回词条数。失败返回 0 且不清空已有内容之外的数据。 */
  load() {
    try {
      const text = this.fs.readFileSync(this.filePath, "utf8");
      this.entries = parseHotWords(text);
      return this.entries.length;
    } catch (error) {
      // 文件不存在是首次运行的正常情况，不算错误
      this.entries = [];
      this.logger?.("debug", "热词表不可用", { path: this.filePath, error: error?.message || String(error) });
      return 0;
    }
  }

  /** 渲染进程用：拿到纯词条数组（不含权重）。 */
  list() {
    return this.entries.map((e) => e.term);
  }

  /** 渲染进程用：拿到可直接传给腾讯的字符串 "词|权重,词|权重"。 */
  toHotwordString() {
    return this.entries.map((e) => `${e.term}|${e.weight}`).join(",");
  }

  /**
   * 追加词条（来自剪贴板学习等）。去重后写回文件，超过 128 个按序截断。
   * 返回 { added, total, persisted }
   */
  add(terms, { weight = DEFAULT_WEIGHT } = {}) {
    const incoming = Array.isArray(terms) ? terms : [terms];
    const existingKeys = new Set(this.entries.map((e) => e.term.toLowerCase()));
    const fresh = [];
    for (const raw of incoming) {
      const term = String(raw || "").trim().replace(/\|/g, "");
      if (!term) continue;
      const key = term.toLowerCase();
      if (existingKeys.has(key)) continue;
      existingKeys.add(key); // 同一批里也去重
      fresh.push({ term, weight });
    }
    // 词表按频次降序，尾部是最低频的；满了就一次性从尾部淘汰旧词，
    // 保证本次新学到的词全部进得来（逐条 pop 会淘汰掉同批刚加的词）
    const overflow = this.entries.length + fresh.length - MAX_TERMS;
    if (overflow > 0) {
      this.entries.splice(Math.max(0, this.entries.length - overflow), overflow);
    }
    if (fresh.length) this.entries.push(...fresh);
    const added = fresh.length;
    let persisted = false;
    if (added > 0) persisted = this.persist();
    return { added, total: this.entries.length, persisted };
  }

  /** 写回磁盘。失败不抛，返回 false。绝不写内置文件，避免污染随包资源。 */
  persist() {
    try {
      // 内置词表是只读模板：复制失败时 filePath 会指向它，此时禁止回写
      if (!this.filePath || this.filePath === BUNDLED_FILE) {
        this.logger?.("warn", "热词表路径不可写，跳过持久化", { path: this.filePath });
        return false;
      }
      const body = this.entries.map((e) => `${e.term}|${e.weight}`).join("\n") + "\n";
      this.fs.writeFileSync(this.filePath, body, "utf8");
      return true;
    } catch (error) {
      this.logger?.("warn", "热词表写入失败", { path: this.filePath, error: error?.message || String(error) });
      return false;
    }
  }
}

module.exports = { HotWordsStore, parseHotWords, resolveHotWordsPath, MAX_TERMS };
