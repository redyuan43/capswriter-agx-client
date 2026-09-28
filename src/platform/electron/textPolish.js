/**
 * 转写整理编排：保留原文 → 隔离运行规则 → 明确别名 → GLM → 列举排版。
 * 各阶段记录版本与耗时；异常保留上一阶段文本，终端安全交付由粘贴入口处理。
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const { HotRuleReplacer } = require("../../helpers/hotRuleReplace");
const { normalizeEnumerations } = require("../../helpers/longTextFormatter");

// __dirname = src/platform/electron，需上溯三级才到项目根（打包后即 app.asar 根）
const PROJECT_ROOT = path.join(__dirname, "..", "..", "..");
const BUNDLED_RULE_FILE = path.join(PROJECT_ROOT, "assets", "hot-rule.txt");
const RULE_FILE_NAME = "hot-rule.txt";

/**
 * 决定规则文件来源，优先级从高到低：
 *   1. 环境变量 CAPS_HOT_RULE_FILE（调试/临时覆盖）
 *   2. 用户数据目录 ~/.config/语音转写/hot-rule.txt（用户日常维护的位置）
 *   3. 旧 CapsWriter 安装目录（向后兼容，用户可能还在那里改）
 *   4. 随包内置的 assets/hot-rule.txt
 * 若 2 不存在而 3/4 存在，会把找到的那份复制到 2，让用户只需维护一处。
 */
function resolveRulePath(dataDirectory, fsImpl) {
  const override = process.env.CAPS_HOT_RULE_FILE;
  if (override) return override;

  const userPath = dataDirectory ? path.join(dataDirectory, RULE_FILE_NAME) : "";
  const legacyPaths = [
    path.join(os.homedir(), "github", "CapsWriter-Offline-Windows-64bit", RULE_FILE_NAME),
  ];

  if (userPath && fsImpl.existsSync(userPath)) return userPath;

  const source = [...legacyPaths, BUNDLED_RULE_FILE].find((p) => {
    try {
      return fsImpl.existsSync(p);
    } catch {
      return false;
    }
  });

  if (source && userPath) {
    try {
      fsImpl.copyFileSync(source, userPath);
      return userPath;
    } catch {
      // 复制失败不影响使用，退回读源文件
    }
  }
  return source || userPath;
}

class TextPolisher {
  constructor({ dataDirectory, logger = null, longFormatter = null, hotWordsStore = null } = {}) {
    this.logger = logger;
    this.longFormatter = longFormatter;
    this.hotWordsStore = hotWordsStore;
    this.rulePath = resolveRulePath(dataDirectory, fs);
    this.replacer = new HotRuleReplacer({ filePath: this.rulePath, fs, logger });
    this.active = new Set();
  }

  loadRules() { return this.replacer.loadFromFile(); }

  async polish(rawText, options = {}) {
    const started = Date.now();
    const raw = typeof rawText === 'string' ? rawText : '';
    const mode = options.mode === 'prompt' ? 'prompt' : 'light';
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    this.active.add(controller);
    const result = { text: raw, raw_text: raw, corrected_text: raw, final_text: raw,
      changed: false, stages: [], degraded: null, mode, ruleCount: 0 };
    try {
      if (!raw.trim()) return result;
      const snapshot = this.hotWordsStore?.snapshot();
      result.dictionary_version = options.dictionaryVersion || snapshot?.version || null;
      let current = raw;
      if (options.hotRule !== false) {
        result.ruleCount = this.loadRules();
        result.rules_version = this.replacer.version;
        const applied = await this.replacer.applyAsync(current, { signal: controller.signal });
        current = applied.text;
        result.stages.push({ stage: 'hot_rule', elapsed_ms: Date.now() - started, applied_rules: applied.applied });
        result.degraded = applied.error;
        const entries = this.hotWordsStore?.entriesForVersion(result.dictionary_version);
        const aliased = require('../../helpers/protectedText').applyAliases(current, entries || []);
        current = aliased.text;
        result.stages.push({ stage: 'aliases', matches: aliased.matches });
      }
      result.corrected_text = current;
      // CT-Punc 曾破坏代码、英文和已有标点；统一保留腾讯原生标点。
      if (options.punctuation === 'full') result.stages.push({ stage: 'punctuation', skipped: 'disabled' });
      const useModel = mode === 'prompt' || options.longFormat?.enabled !== false;
      if (useModel && this.longFormatter && !controller.signal.aborted) {
        const applied = await this.longFormatter.format(current, { mode, signal: controller.signal,
          timeoutMs: mode === 'prompt' ? 30000 - (Date.now() - started) : 2000 - (Date.now() - started) });
        current = applied.text;
        result.stages.push({ stage: mode, elapsed_ms: applied.elapsed_ms, applied: applied.changed, degraded: applied.degraded });
        result.degraded = applied.degraded || result.degraded;
        result.model = applied.model;
        result.thinking = applied.thinking;
        result.prompt_version = applied.prompt_version;
      }
      if (mode === 'light') {
        const enumerated = normalizeEnumerations(current);
        if (enumerated !== current) result.stages.push({ stage: 'enumeration_format', elapsed_ms: 0, applied: true });
        current = enumerated;
      }
      if (controller.signal.aborted) result.degraded = 'cancelled';
      result.text = result.final_text = current;
      result.changed = current !== raw;
      result.copyOnly = /[\r\n]/.test(current) && options.longFormat?.isTerminal !== false;
      return result;
    } finally {
      this.active.delete(controller);
      options.signal?.removeEventListener('abort', abort);
      result.total_ms = Date.now() - started;
    }
  }

  shouldRunLongFormat(text, { minChars = 0 } = {}) {
    const contentChars = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').length;
    return { run: contentChars >= minChars, reason: contentChars < minChars ? 'below_min_chars' : null, contentChars };
  }

  dispose() {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}

module.exports = { TextPolisher };
