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

/**
 * 后端配置。
 *
 * 2026-09-20 实测决定了默认后端是 AMD 而不是本机：
 *
 *   本机 qwen2.5:3b 在"分段"上没有能力。它只会把 ASR 给的句号机械换成
 *   换行（183 字 → 7~9 行），同一条输入跑 5 次会出现 3 种不同切法。
 *   改 prompt 能压住"切碎"，但它在中英混排的长文本上会崩成
 *   "AMD 没 部署 ，"这种逐词加空格的输出（实测空格率 66%）。
 *
 *   AMD 上的 Qwen3.8-Flash-Next（MoE 27B）在完全相同的输入上：
 *   3/3 输出一致、把 ASR 误断的句子正确接回、分成 3 段、保真校验 PASS。
 *   代价是延迟 2.2~3.4 秒（本机 3B 约 1.0 秒）且依赖 AMD 在线。
 *
 * 两个 provider 都是 HTTP 接口，差别只在请求/响应形状：
 *   openai —— AMD 网关 18106，OpenAI 兼容
 *   ollama —— 本机 11434，原生 API（保留作可切换的备选）
 * 用 CAPS_LONG_TEXT_PROVIDER 切换，默认 openai。
 */
const PROVIDERS = {
  openai: {
    defaultEndpoint: "http://100.90.114.26:18106/v1",
    defaultModel: "Qwen/Qwen3.8-Flash-Next-ROCmFP4-FAST-imatrix-MTP",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    listModels: (data) => (data?.data || []).map((m) => String(m?.id || "")),
    buildBody: ({ model, prompt, maxTokens }) => ({
      model,
      messages: [{ role: "user", content: prompt }],
      // 整理是确定性任务，温度必须压低，否则同一条输入会漂移
      temperature: 0.1,
      max_tokens: maxTokens,
      stream: false,
    }),
    parseContent: (data) => data?.choices?.[0]?.message?.content,
    parseReasoning: (data) => data?.choices?.[0]?.message?.reasoning_content,
  },
  ollama: {
    defaultEndpoint: "http://127.0.0.1:11434",
    defaultModel: "qwen2.5:3b",
    chatPath: "/api/chat",
    modelsPath: "/api/tags",
    listModels: (data) => (data?.models || []).map((m) => String(m?.name || "")),
    buildBody: ({ model, prompt, maxTokens, keepAlive }) => ({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      keep_alive: keepAlive,
      // 刻意不传 think：目标模型（Qwen2.5）架构上就没有思考模式，
      // 传 think:false 反而在 Qwen3 上实测出过"思考内容污染正文"的问题。
      options: { temperature: 0.1, num_predict: maxTokens },
    }),
    parseContent: (data) => data?.message?.content,
    parseReasoning: () => "",
  },
};

const DEFAULT_PROVIDER = "openai";

// AMD 实测 2.2~3.4 秒（含跨 Tailscale 的往返）。超时留到 8 秒：
// 这是"不能让用户干等"的上限，不是预期值 —— 正常 2~3 秒就回来了。
const DEFAULT_TIMEOUT_MS = 8000;

// ollama 默认只把模型驻留 5 分钟。口述之间隔几分钟是很正常的事，
// 那样每次都要重新加载（实测冷启动 3.1 秒 vs 稳态 1.3 秒），
// 3 秒的等待会落在"说完话等粘贴"这段最敏感的时间上。
// 驻留 30 分钟的代价是占住约 2.5GB 显存。openai 端点忽略这个值。
const DEFAULT_KEEP_ALIVE = "30m";

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

// 只有断在这些符号后面的换行才算真分段。模型（尤其 3B）经常在逗号处
// 硬换行，把一句话切成好几行——那不是分段，是噪声，得并回去。
const SENTENCE_END = /[。！？!?…][”"』」）)】]*$/;

// 中文标点前后不该有空格。模型在英文词后面接中文标点时爱加一个空格，
// 真实回放里出现过"知道了 sessionID ，其实"这种输出。
const SPACE_BEFORE_PUNCT = /\s+([，。！？；：、）】」』”’])/g;
const SPACE_AFTER_OPEN = /([（【「『“‘])\s+/g;

/**
 * prompt 的形态是实测出来的，改动前先看这段历史：
 *
 * v1.0.24 初版让模型"按意思分成几段"，示例写成"原文两句 / 整理后两行"。
 * 结果 3B 把示例的**形态**学走了 —— 它把 ASR 的每个句号直接换成换行，
 * 183 字输出 7~9 行、每行一个短句。用户原话："感觉他现在断句还有问题"。
 * 教训：小模型模仿示例的字面形态，胜过理解指令的意图。别给它坏样例。
 *
 * 现在这版把重点从"分段"挪到"修断句"，因为真实语料里 ASR 会把句子
 * 从中间切断（全量 3814 条统计：8.75% 的句子句末落在连词/介词上，
 * 例如"…是靠启动日志和。接线校验确认的"）。第 3 条明确要求接回，
 * 并给一个具体例子说明什么叫"被错误切开"。
 *
 * 同时把"禁止替换同义词"写死：AMD 27B 在宽松指令下会把
 * "没走真人麦克风的一次"改写成"本次未使用真人麦克风"，双字组覆盖率
 * 掉到 0.72 被保真校验拦掉。加上这条约束后覆盖率回到 1.000。
 *
 * 长度刻意控制在 400 字符以内（有测试钉住）：给 3B 一份长规则清单，
 * 它会开始复述要求本身。
 */
const PROMPT_TEMPLATE = `整理下面这段语音转写。只允许做三件事：
1. 删掉口头语（呃、嗯、那个、就是说）
2. 改掉明显的错别字
3. 把被错误切开的句子接回完整（比如"靠日志和。接线确认的"要接成"靠日志和接线确认的"）

禁止：替换同义词、调整语序、改写句子、增删内容。保持原文用词，一个字都不要多改。
按意思分段（用换行），不要输出其他任何内容。

原文：${"${text}"}

整理后：`;

/**
 * "逐词加空格"劣化检测。
 *
 * 本机 3B 在中英混排的长文本上会崩成 "AMD 没 部署 ， 按 你说 的 ，"
 * 这种输出（实测汉字被空格切开的比例达 66%）。这类输出**能骗过长度比和
 * 双字组覆盖率**——去标点后字一个不少，覆盖率还有 0.98——但粘贴出来
 * 完全不可用。所以单独加一道关。
 *
 * 只统计"汉字 空格 汉字"这一种模式。"用 AMD 的 handle 层"里中英之间的
 * 空格是**正常排版**，不该算劣化；崩坏的特征是空格插在汉字与汉字之间。
 */
const MAX_SPACEY_RATIO = 0.15;
function spaceyRatio(text) {
  const s = String(text || "");
  const han = s.match(/[\u4e00-\u9fa5]/g);
  if (!han || !han.length) return 0;
  const broken = s.match(/[\u4e00-\u9fa5][ \t](?=[\u4e00-\u9fa5])/g);
  return (broken ? broken.length : 0) / han.length;
}

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
  constructor({ provider, endpoint, model, logger = null, timeoutMs, keepAlive } = {}) {
    const providerKey = PROVIDERS[provider] ? provider : DEFAULT_PROVIDER;
    this.api = PROVIDERS[providerKey];
    this.provider = providerKey;
    this.endpoint = String(endpoint || this.api.defaultEndpoint).replace(/\/+$/, "");
    this.model = String(model || this.api.defaultModel);
    this.logger = logger;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.keepAlive = keepAlive || DEFAULT_KEEP_ALIVE;
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
   * 把模型输出的换行规整成"像人写的段落"。
   *
   * 两步，都是确定性规则，不靠模型自觉：
   *   1. 丢空行、统一换行符
   *   2. 上一行没断在句末标点 → 说明是在逗号处硬换行，并回上一段
   * 最后把段落之间统一成空行（`\n\n`）。
   *
   * 为什么不让模型自己来：真实回放里同一条 prompt，模型既会 222 字
   * 一段不分，也会把 135 字切成 6 行、每行断在逗号上。规则兜底之后
   * 至少不会出现"一句话被切成三行"这种明显劣化。
   *
   * 为什么段落之间用空行而不是单换行：粘贴目标多是聊天窗口和编辑器，
   * 单换行在那里经常被当成软换行直接合并 —— 段就白分了。空行是跨平台
   * 都认的段落分隔。（终端另说：那里整体跳过整理，见 terminalFocus.js。）
   *
   * 刻意**不做**"短段落合并"：试过按字数往后并，结果把两句话的短文本
   * 并回成一段，分段能力整个失效。逗号硬换行才是真问题，第二步已经解决。
   */
  normalizeParagraphs(text) {
    const lines = String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const merged = [];
    for (const line of lines) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && !SENTENCE_END.test(prev)) {
        // 中英混排时，两个 ASCII 词之间补一个空格，避免粘成一个词
        const needsSpace = /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(line);
        merged[merged.length - 1] = needsSpace ? `${prev} ${line}` : `${prev}${line}`;
      } else {
        merged.push(line);
      }
    }
    return merged
      .join("\n\n")
      .replace(SPACE_BEFORE_PUNCT, "$1")
      .replace(SPACE_AFTER_OPEN, "$1");
  }

  /**
   * 保真校验。三道关：
   *   1. 长度比——抓大幅增删（总结、复述要求）
   *   2. 逐词空格——抓 3B 在中英混排上的崩坏输出（字都在，但每字后加空格）
   *   3. 双字组覆盖率——抓等长改写（同义替换），长度比看不见这类
   * 返回 { ok, reason, ratio, coverage, spacey }
   */
  validate(original, formatted) {
    const strip = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "");
    const a = strip(original);
    const b = strip(formatted);
    if (!b) return { ok: false, reason: "empty_output", ratio: 0, coverage: 0, spacey: 0 };
    if (!a) return { ok: false, reason: "empty_input", ratio: 1, coverage: 1, spacey: 0 };

    const ratio = b.length / a.length;
    const coverage = bigramCoverage(a, b);
    const spacey = spaceyRatio(formatted);
    const threshold = a.length >= BIGRAM_STRICT_MIN_CHARS
      ? MIN_BIGRAM_COVERAGE_LONG
      : MIN_BIGRAM_COVERAGE_SHORT;
    const detail = { ratio, coverage, threshold, spacey };

    if (ratio < MIN_RATIO) return { ok: false, reason: `too_short(${ratio.toFixed(2)})`, ...detail };
    if (ratio > MAX_RATIO) return { ok: false, reason: `too_long(${ratio.toFixed(2)})`, ...detail };
    if (spacey > MAX_SPACEY_RATIO) {
      return { ok: false, reason: `space_garbage(${spacey.toFixed(2)})`, ...detail };
    }
    if (coverage < threshold) {
      return { ok: false, reason: `rewritten(coverage=${coverage.toFixed(2)})`, ...detail };
    }
    return { ok: true, reason: null, ...detail };
  }

  /** 探测服务是否可用（客户端启动时跑一次，结果缓存）。 */
  async probe() {
    const started = Date.now();
    try {
      const response = await this.fetchWithTimeout(
        `${this.endpoint}${this.api.modelsPath}`,
        { method: "GET" },
        4000
      );
      if (!response.ok) {
        this.available = false;
        return { available: false, provider: this.provider, error: `HTTP ${response.status}` };
      }
      const data = await response.json();
      const names = this.api.listModels(data);
      const hasModel = names.some((n) => n === this.model || n.startsWith(this.model));
      this.available = hasModel;
      return {
        available: hasModel,
        provider: this.provider,
        model: this.model,
        installed: names.slice(0, 10),
        error: hasModel ? null : `model_not_found:${this.model}`,
        elapsed_ms: Date.now() - started,
      };
    } catch (error) {
      this.available = false;
      return { available: false, provider: this.provider, error: error?.message || String(error) };
    }
  }

  /**
   * 预热：赶在用户第一次录音之前把链路走通。
   *
   * 本机 ollama 需要它把模型加载进显存（冷启动实测 3.1 秒 vs 稳态 1.3 秒）。
   * AMD 那边的模型是常驻的，预热主要是为了提前建立连接、顺便验证可达性，
   * 免得第一次长口述才发现服务不通。失败不影响启动。
   */
  async warmup() {
    const started = Date.now();
    try {
      const response = await this.fetchWithTimeout(`${this.endpoint}${this.api.chatPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          this.api.buildBody({
            model: this.model,
            prompt: "你好",
            maxTokens: 8,
            keepAlive: this.keepAlive,
          })
        ),
      }, 60000);
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      await response.json();
      const elapsed = Date.now() - started;
      this.logger?.info("长文本整理服务预热完成", {
        provider: this.provider,
        model: this.model,
        elapsed_ms: elapsed,
      });
      return { ok: true, elapsed_ms: elapsed };
    } catch (error) {
      this.logger?.warn("长文本整理服务预热失败", {
        provider: this.provider,
        error: error?.message || String(error),
      });
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
      const response = await this.fetchWithTimeout(`${this.endpoint}${this.api.chatPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          this.api.buildBody({
            model: this.model,
            prompt: this.buildPrompt(original),
            // 输出长度和输入同量级（整理不改写内容），留三倍余量足够
            maxTokens: Math.max(512, original.length * 3),
            keepAlive: this.keepAlive,
          })
        ),
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
      const raw = this.api.parseContent(data) ?? "";
      // 有些模型（Qwen3 系列）把内容放进 reasoning 通道。正文空而思考链有
      // 内容，说明 token 被思考吃掉、答案根本没写出来 —— 视为失败回退原文，
      // 绝不能让空结果覆盖用户说的话。
      if (!String(raw).trim() && String(this.api.parseReasoning(data) || "").trim()) {
        return {
          text: original,
          changed: false,
          elapsed_ms: Date.now() - started,
          degraded: "reasoning_only",
        };
      }
      const cleaned = this.normalizeParagraphs(this.stripNoise(raw));

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
          coverage: Number(check.coverage?.toFixed(3)),
          spacey: Number((check.spacey || 0).toFixed(3)),
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
  spaceyRatio,
  PROMPT_TEMPLATE,
  PROVIDERS,
  MIN_RATIO,
  MAX_RATIO,
  MAX_SPACEY_RATIO,
  MIN_BIGRAM_COVERAGE_LONG,
  MIN_BIGRAM_COVERAGE_SHORT,
  BIGRAM_STRICT_MIN_CHARS,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_MS,
};
