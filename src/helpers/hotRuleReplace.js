/**
 * 自定义替换规则（移植自旧 CapsWriter 的 util/hot_sub_rule.py）
 *
 * 规则文件格式：每行一条，左边正则模式，右边替换式，中间用「 = 」隔开。
 * 以 # 开头的行是注释。
 *
 * 例：
 *   毫安时     =      mAh
 *   (艾特)\s*(QQ)\s*点\s*   =   @qq.
 *
 * 与 Python 版的差异：Python re.sub 的反向引用写作 \1 \2，
 * JS 里必须写成 $1 $2，这里自动转换，旧规则文件可直接复用。
 */

const RULE_SEPARATOR = ' = ';

function convertBackreference(replacement) {
  // Python 风格 \1 \g<1> → JS 风格 $1
  return String(replacement)
    .replace(/\\g<(\d+)>/g, '$$$1')
    .replace(/\\(\d+)/g, '$$$1');
}

function parseRules(ruleText) {
  const rules = [];
  for (const rawLine of String(ruleText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // 优先按「空格=空格」切分；兼容单个等号
    let parts = line.split(RULE_SEPARATOR);
    if (parts.length !== 2) {
      parts = line.split('=');
    }
    if (parts.length !== 2) continue;

    const pattern = parts[0].trim();
    const replacement = parts[1].trim();
    if (!pattern) continue;

    try {
      new RegExp(pattern);
      rules.push({ pattern, replacement: convertBackreference(replacement) });
    } catch {
      // 非法正则直接跳过，不能因为一条坏规则让整个替换挂掉
    }
  }
  return rules;
}

class HotRuleReplacer {
  constructor({ filePath, fs = null, logger = null } = {}) {
    this.filePath = filePath;
    this.fs = fs;
    this.logger = logger;
    this.rules = [];
    this.loadedAt = 0;
    this.mtimeMs = 0;
  }

  load(ruleText) {
    this.rules = parseRules(ruleText);
    this.loadedAt = Date.now();
    return this.rules.length;
  }

  /** 从磁盘读取；文件不存在或无有效规则时返回 0，调用方应据此跳过替换。 */
  loadFromFile() {
    if (!this.filePath || !this.fs) return 0;
    try {
      const stat = this.fs.statSync(this.filePath);
      if (stat.mtimeMs === this.mtimeMs && this.rules.length) {
        return this.rules.length;
      }
      const text = this.fs.readFileSync(this.filePath, 'utf8');
      const count = this.load(text);
      this.mtimeMs = stat.mtimeMs;
      return count;
    } catch (error) {
      this.logger?.('debug', 'Hot rule file unavailable', {
        path: this.filePath,
        error: error?.message || String(error),
      });
      this.rules = [];
      return 0;
    }
  }

  /**
   * 依次应用规则。任何一条规则抛错都跳过它，不影响后续规则与最终结果。
   * 返回 { text, applied: [规则下标], error }
   */
  apply(text) {
    if (typeof text !== 'string' || !text) {
      return { text: text || '', applied: [], error: null };
    }
    if (!this.rules.length) {
      return { text, applied: [], error: null };
    }

    let result = text;
    const applied = [];
    let error = null;

    for (let i = 0; i < this.rules.length; i += 1) {
      const { pattern, replacement } = this.rules[i];
      try {
        const next = result.replace(new RegExp(pattern, 'g'), replacement);
        if (next !== result) applied.push(i);
        result = next;
      } catch (err) {
        // 运行时报错（如灾难性回溯）：跳过该规则，保留当前结果
        error = err?.message || String(err);
        this.logger?.('warn', 'Hot rule failed, skipped', {
          index: i,
          pattern,
          error,
        });
      }
    }

    return { text: result, applied, error };
  }
}

module.exports = { HotRuleReplacer, parseRules, convertBackreference };
