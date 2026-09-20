/**
 * 长文本整理（主进程侧）
 *
 * 输入：腾讯 ASR 转写出来的长段口语文本。
 * 输出：去填充词、合并重复、修明显错别字，并按逻辑分段。
 *
 * 设计约束（都是实测定下来的，别改回去）：
 *   1. **必须用原生非思考的模型**。2026-09-20 实测 Qwen3-4B：
 *      - think:true  → 思考链写了 3781 字、30 秒仍未给出答案（num_predict 被吃光）
 *      - think:false → 思考行为没被抑制，只是思考内容全部倒进 content，
 *                      输出长度暴涨到原文 6 倍，正文被污染
 *      结论：Qwen3 小尺寸不适合这个任务，改用 Qwen2.5 这类架构上就没有
 *      thinking 的模型。因此**不要传 think 参数**——传了反而有触发异常模式的风险。
 *   2. **保真校验**。prompt 写得再严，小模型仍可能越界去"总结"。所以
 *      每一条结果都要过 validate()：去掉空白标点后，长度比必须落在
 *      [MIN_RATIO, MAX_RATIO]，越界就整条丢弃、回退原文。
 *   3. **失败即原文**。网络、超时、解析任何一环出错都返回原文本，
 *      绝不因为整理把用户说的话弄丢。
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5:3b";
// 实测本机 3B 处理 150 字约 0.9 秒。超时设 5 秒：服务挂着时不能让用户干等，
// 宁可回退原文。这个值是上限而不是预期。
const DEFAULT_TIMEOUT_MS = 5000;

// 去掉标点空白后，输出/原文的长度比允许区间。
// 下界：删填充词会变短，但不该短到 70% 以下（那基本是"总结"了）。
// 上界：稍有增补（补标点、拆句号）可接受，但超过 15% 就是加戏。
const MIN_RATIO = 0.7;
const MAX_RATIO = 1.15;

// 双字组覆盖率：输出里有多少比例的双字组在原文中出现过。
// 长度比抓不住"等长改写"——实测把"交互界面还是有问题"写成"交互存在问题"，
// 长度比 0.834 看着正常，覆盖率却掉到 0.784。
// 而单纯分段不会影响这个指标（实测忠实分段样本 1.000）。
// 2026-09-20 实测四类样本：忠实 0.991 / 过度分段 1.000 / 同义改写 0.784 / 总结 0.519。
//
// 阈值必须随文本长度放松：短句里删几个口头语（"所以""嘛""呢"），
// 覆盖率就掉到 0.83 —— 那是正常整理，不是改写。实测 37 字样本即被误伤。
// 长文本才有足够的统计量把"改写"和"删词"区分开。
const MIN_BIGRAM_COVERAGE_LONG = 0.9;   // 原文 >= 80 字
const MIN_BIGRAM_COVERAGE_SHORT = 0.75; // 原文 < 80 字
const BIGRAM_STRICT_MIN_CHARS = 80;

// 模型偶尔会自作主张加这类前缀，统一剥掉。
const LEADING_NOISE = /^\s*(?:整理后|整理结果|输出|结果|以下是整理后的文本)[:：\s]*/;

/**
 * prompt 刻意写得短。
 * 实测教训：给 Qwen3-4B 一份"角色 + 四条规则 + 五条禁止"的长 prompt，
 * 它会把要求本身当成待分析文本复述一遍。小模型对**简短指令 + 示例**
 * 的遵循度，明显高于对长规则清单的遵循度。
 */
const PROMPT_TEMPLATE = `把下面这段语音转写整理一下：删掉"呃、嗯、那个、就是说"这类口头语，改掉明显的错别字，按意思分段。其余一个字都不要改。不要总结，不要解释。

示例：
原文：然后那个，我觉得这个方案可以。呃，但是第二个问题就是说它太慢了。
整理后：我觉得这个方案可以。

但是第二个问题，它太慢了。

下面这段照上面的做法整理：
${"${text}"}

整理后：`;

/**
 * 输出里有多少比例的双字组在原文中出现过。
 * 入参应已去掉空白标点。中文按字符切分即可，无需分词。
 */
function bigramCoverage(strippedOriginal, strippedFormatted) {
  const A = new Set();
  for (let i = 0; i < strippedOriginal.length - 1; i += 1) {
    A.add(strippedOriginal.slice(i, i + 2));
  }
  if (!A.size || strippedFormatted.length < 2) return strippedFormatted.length < 2 ? 1 : 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i < strippedFormatted.length - 1; i += 1) {
    total += 1;
    if (A.has(strippedFormatted.slice(i, i + 2))) hit += 1;
  }
  return total ? hit / total : 0;
}

class LongTextFormatter {
  constructor({ endpoint, model, logger = null, timeoutMs } = {}) {
    this.endpoint = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.model = String(model || DEFAULT_MODEL);
    this.logger = logger;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.available = null; // null=未探测, true/false=上次探测结果
  }

  buildPrompt(text) {
    return PROMPT_TEMPLATE.replace("${text}", text);
  }

  /** 剥掉代码围栏与模型自加的前缀。 */
  stripNoise(raw) {
    let out = String(raw || "").trim();
    const fence = out.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
    if (fence) out = fence[1].trim();
    out = out.replace(LEADING_NOISE, "");
    return out.trim();
  }

  /**
   * 保真校验。两道关：
   *   1. 长度比——抓大幅增删（总结、复述要求）
   *   2. 双字组覆盖率——抓等长改写（同义替换），长度比看不见这类
   * 返回 { ok, reason, ratio, coverage }
   */
  validate(original, formatted) {
    const strip = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "");
    const a = strip(original);
    const b = strip(formatted);
    if (!b) return { ok: false, reason: "empty_output", ratio: 0, coverage: 0 };
    if (!a) return { ok: false, reason: "empty_input", ratio: 1, coverage: 1 };

    const ratio = b.length / a.length;
    const coverage = bigramCoverage(a, b);
    const threshold = a.length >= BIGRAM_STRICT_MIN_CHARS
      ? MIN_BIGRAM_COVERAGE_LONG
      : MIN_BIGRAM_COVERAGE_SHORT;
    const detail = { ratio, coverage, threshold };

    if (ratio < MIN_RATIO) return { ok: false, reason: `too_short(${ratio.toFixed(2)})`, ...detail };
    if (ratio > MAX_RATIO) return { ok: false, reason: `too_long(${ratio.toFixed(2)})`, ...detail };
    if (coverage < threshold) {
      return { ok: false, reason: `rewritten(coverage=${coverage.toFixed(2)})`, ...detail };
    }
    return { ok: true, reason: null, ...detail };
  }

  /** 探测服务是否可用（客户端启动时跑一次，结果缓存）。 */
  async probe() {
    const started = Date.now();
    try {
      const response = await this.fetchWithTimeout(`${this.endpoint}/api/tags`, {
        method: "GET",
      }, 3000);
      if (!response.ok) {
        this.available = false;
        return { available: false, error: `HTTP ${response.status}` };
      }
      const data = await response.json();
      const names = (data?.models || []).map((m) => m.name || "");
      const hasModel = names.some((n) => n === this.model || n.startsWith(`${this.model}:`));
      this.available = hasModel;
      return {
        available: hasModel,
        model: this.model,
        installed: names,
        error: hasModel ? null : `model_not_found:${this.model}`,
        elapsed_ms: Date.now() - started,
      };
    } catch (error) {
      this.available = false;
      return { available: false, error: error?.message || String(error) };
    }
  }

  /**
   * 预热：把模型加载进显存。冷启动实测可达数十秒，
   * 必须赶在用户第一次录音之前完成，否则那一次转写要干等。
   */
  async warmup() {
    const started = Date.now();
    try {
      const response = await this.fetchWithTimeout(`${this.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: "你好" }],
          stream: false,
          options: { num_predict: 1 },
        }),
      }, 120000);
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      await response.json();
      const elapsed = Date.now() - started;
      this.logger?.info("长文本整理服务预热完成", { model: this.model, elapsed_ms: elapsed });
      return { ok: true, elapsed_ms: elapsed };
    } catch (error) {
      this.logger?.warn("长文本整理服务预热失败", { error: error?.message || String(error) });
      return { ok: false, error: error?.message || String(error) };
    }
  }

  fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  /**
   * 整理文本。
   * 返回 { text, changed, elapsed_ms, degraded }
   * degraded 非空表示本次未采用模型结果（回退原文）。
   */
  async format(text) {
    const started = Date.now();
    const original = String(text || "");
    if (!original.trim()) {
      return { text: original, changed: false, elapsed_ms: 0, degraded: null };
    }

    try {
      const response = await this.fetchWithTimeout(`${this.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: this.buildPrompt(original) }],
          stream: false,
          // 刻意不传 think：目标模型（Qwen2.5）架构上就没有思考模式，
          // 传 think:false 反而在 Qwen3 上实测出过"思考内容污染正文"的问题。
          options: { temperature: 0.2, num_predict: Math.max(256, original.length * 2) },
        }),
      }, this.timeoutMs);

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return {
          text: original,
          changed: false,
          elapsed_ms: Date.now() - started,
          degraded: `http_${response.status}${detail ? `:${detail.slice(0, 120)}` : ""}`,
        };
      }

      const data = await response.json();
      // /api/chat 的思考内容在 message.thinking，正文在 message.content；
      // think:false 时 thinking 应为空，这里只取 content 以防万一。
      const raw = data?.message?.content ?? "";
      const cleaned = this.stripNoise(raw);

      if (!cleaned) {
        return {
          text: original,
          changed: false,
          elapsed_ms: Date.now() - started,
          degraded: "empty_response",
        };
      }

      if (cleaned === original.trim()) {
        return { text: original, changed: false, elapsed_ms: Date.now() - started, degraded: null };
      }

      const check = this.validate(original, cleaned);
      if (!check.ok) {
        this.logger?.warn("长文本整理未通过保真校验，已回退原文", {
          reason: check.reason,
          ratio: Number(check.ratio?.toFixed(3)),
          original_chars: original.length,
          formatted_chars: cleaned.length,
          preview: cleaned.slice(0, 80),
        });
        return {
          text: original,
          changed: false,
          elapsed_ms: Date.now() - started,
          degraded: `fidelity:${check.reason}`,
        };
      }

      this.available = true;
      return {
        text: cleaned,
        changed: true,
        elapsed_ms: Date.now() - started,
        degraded: null,
        ratio: Number(check.ratio.toFixed(3)),
      };
    } catch (error) {
      const message = error?.name === "AbortError"
        ? `timeout(${this.timeoutMs}ms)`
        : (error?.message || String(error));
      return {
        text: original,
        changed: false,
        elapsed_ms: Date.now() - started,
        degraded: message,
      };
    }
  }
}

module.exports = {
  LongTextFormatter,
  bigramCoverage,
  PROMPT_TEMPLATE,
  MIN_RATIO,
  MAX_RATIO,
  MIN_BIGRAM_COVERAGE_LONG,
  MIN_BIGRAM_COVERAGE_SHORT,
  BIGRAM_STRICT_MIN_CHARS,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
};
