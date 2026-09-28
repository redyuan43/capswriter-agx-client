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
const { protectedSpans, overlaps } = require('./protectedText');
const { fork } = require('child_process');

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
    // 旧用户文件也禁用已经复现误伤的三条规则，保留文件原文供检查。
    if ((pattern === '二、' && replacement === '二') ||
        (pattern === '负一' && replacement === '-1') ||
        (pattern.includes('紫禁城') && replacement === '子进程')) continue;

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
    this.version = require('crypto').createHash('sha256').update(String(ruleText)).digest('hex').slice(0, 16);
    this.loadedAt = Date.now();
    return this.rules.length;
  }

  /**
   * 从磁盘读取；文件不存在或无有效规则时返回 0。
   * 已加载且文件 mtime 未变时直接复用（一次 statSync 的成本）。
   * 读取失败（文件被编辑器临时改名、权限瞬时异常）时**保留上一次的规则**，
   * 不清空——否则一次瞬时故障会让全部规则在本次会话内静默失效。
   */
  loadFromFile() {
    if (!this.filePath || !this.fs) return this.rules.length;
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
      this.logger?.debug('Hot rule file unavailable, keeping previous rules', {
        path: this.filePath,
        kept: this.rules.length,
        error: error?.message || String(error),
      });
      return this.rules.length;
    }
  }

  /**
   * 在原文上收集规则匹配，解决重叠后从尾到头替换，不级联改写。
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
    const spans = protectedSpans(text);
    const candidates = [];
    const spacing = [];

    for (let i = 0; i < this.rules.length; i += 1) {
      const { pattern, replacement } = this.rules[i];
      if (pattern.includes('\\u4e00-\\u9fff') && replacement === '$1 $2') {
        spacing.push({ pattern, replacement, index: i });
        continue;
      }
      try {
        for (const match of text.matchAll(new RegExp(pattern, 'g'))) {
          const start = match.index, end = start + match[0].length;
          if (!match[0] || overlaps(spans, start, end)) continue;
          const value = replacement.replace(/\$(\$|&|\d{1,2})/g, (_, key) => key === '$' ? '$' : key === '&' ? match[0] : (match[Number(key)] || ''));
          if (value !== match[0]) candidates.push({ start, end, value, index: i });
        }
      } catch (err) {
        // 语法/执行异常跳过；耗时回溯由 applyAsync 的子进程超时隔离。
        error = err?.message || String(err);
        this.logger?.warn('Hot rule failed, skipped', {
          index: i,
          pattern,
          error,
        });
      }
    }

    // 同一次匹配只读取原文；最长匹配优先，替换结果不会再触发其他规则。
    candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.index - b.index);
    const selected = [];
    for (const c of candidates) if (!overlaps(selected, c.start, c.end)) selected.push(c);
    for (const c of selected.sort((a, b) => b.start - a.start)) {
      result = result.slice(0, c.start) + c.value + result.slice(c.end);
      applied.push(c.index);
    }
    for (const rule of spacing) {
      const protectedRanges = protectedSpans(result);
      const next = result.replace(new RegExp(rule.pattern, 'g'), (match, a, b, offset) =>
        // 边界两侧可以补空格，但不能插进路径、URL 或标识符内部。
        protectedRanges.some((s) => offset + a.length > s.start && offset + a.length < s.end) ? match : `${a} ${b}`);
      if (next !== result) applied.push(rule.index);
      result = next;
    }

    return { text: result, applied, error };
  }

  applyAsync(text, { timeoutMs = 200, signal } = {}) {
    if (!this.rules.length || !text || signal?.aborted) return Promise.resolve({ text, applied: [], error: signal?.aborted ? 'cancelled' : null });
    const rules = this.rules;
    return new Promise((resolve) => {
      const worker = fork(__filename, ['--hot-rule-worker'], { windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=64'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        worker.kill('SIGKILL');
        resolve(result);
      };
      const cancel = () => finish({ text, applied: [], error: 'cancelled' });
      // Electron 子进程启动在 NX6 上可能超过 200 ms；执行期限从 ready 后算起。
      let timer = setTimeout(() => finish({ text, applied: [], error: 'rule_worker_start_timeout' }), 2000);
      signal?.addEventListener('abort', cancel, { once: true });
      worker.on('message', (message) => {
        if (done) return;
        if (message?.type === 'ready') {
          clearTimeout(timer);
          timer = setTimeout(() => finish({ text, applied: [], error: 'rule_timeout' }), timeoutMs);
          worker.send({ text, rules }, (error) => {
            if (error) finish({ text, applied: [], error: 'rule_worker_failed' });
          });
        } else finish(message);
      });
      worker.once('error', () => finish({ text, applied: [], error: 'rule_worker_failed' }));
      worker.once('exit', () => finish({ text, applied: [], error: 'rule_worker_exited' }));
    });
  }
}

module.exports = { HotRuleReplacer, parseRules, convertBackreference };
if (process.argv.includes('--hot-rule-worker')) {
  process.once('message', ({ text, rules }) => {
    const replacer = new HotRuleReplacer();
    replacer.rules = rules;
    process.send(replacer.apply(text));
  });
  process.send({ type: 'ready' });
}
