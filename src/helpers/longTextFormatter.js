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
 * 2026-09-21 实测 qwen2.5:7b-instruct-q4_K_M（本机 3060，3827 条语料里挑的
 * 8 条真实长口述）：
 *   - 延迟 0.7~2.5s（预热后），与 AMD 27B 同量级，比 3B 快版本强
 *   - 保真校验 7/8 PASS（1 条中英混排 space_garbage 被第三道关拦下，回退正确）
 *   - 但**分段能力仍然为零**（8 条全 1 段，27B 能分 3~4 段）、
 *     **会吞逗号/问号**（"第一，怎么样？"→"第一怎么样"，会连带废掉
 *     normalizeEnumerations 的列举排版）、同一条输入两次输出不一致（3B 同款）
 *   结论：7B 不足以当默认后端，但远好于"AMD 挂了直接退原文"——
 *   所以做成 fallback：主后端连不上/超时/空响应时用 7B 兜底。
 *
 * 两个 provider 都是 HTTP 接口，差别只在请求/响应形状：
 *   ollama —— 本机 11434，原生 API（**默认主力**，qwen2.5:7b-instruct-q4_K_M）
 *   openai —— AMD 网关 18106，OpenAI 兼容（CAPS_LONG_TEXT_PROVIDER=openai 可切）
 * 默认后端沿革：v1.0.24/25 本机 3B → v1.0.26~29 AMD 27B（3B/7B 分段不行）→
 * v1.0.30 本机 7B（原哥拍板：7B 能解决就不需要 AMD；27B 质量更好但 AMD
 * 经常整晚挂掉，2026-09-20 晚挂一整晚导致整理整体失效）。
 * fallback 机制保留（构造参数可挂任意备用后端），默认不挂。
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
    defaultModel: "qwen2.5:7b-instruct-q4_K_M",
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

// 2026-09-21 原哥拍板：主力后端切本机 7B（"如果 7B 能解决，就不需要 AMD 了"）。
// AMD 降级为可选后端：CAPS_LONG_TEXT_PROVIDER=openai 可切回。
// 切换依据（8 条真实长口述实测）：7B 分段能力弱于 27B、会吞逗号问号，
// 但延迟同量级（0.7~2.5s）、保真 7/8 PASS，且不依赖一台经常挂的远程机器。
const DEFAULT_PROVIDER = "ollama";

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

// 兜底后端（本机 ollama 7B）专用。模型常驻靠 keep_alive + 启动预热；但 ollama
// 重启或闲置卸载后冷启动实测 ~25s，超时必须放宽——兜底场景里"慢"总比"整理失败
// 退回原文"强（原文 = 用户抱怨的"标点断句一塌糊涂"）。
const FALLBACK_TIMEOUT_MS = 35000;
const FALLBACK_KEEP_ALIVE = "2h";

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
 * 口述里的序号列举。
 *
 * 用户说"第一…第二…第三…"时期望看到分行的列表，而不是挤成一整段。
 * 这件事**不需要语义理解**——序号本身就是结构信号——所以用确定性规则做，
 * 模型（3B 也好 27B 也好）不参与。这样即使整理服务不可用，排版照样生效。
 *
 * 防误伤的核心是"至少两个不同的序号"：只出现一个"第一"时，它多半是
 * "第一次/第一版/第一台"这类普通词，而不是一个列表的开头。序号后面还
 * 必须是标点或列举量词（条/点/项/款），"第一次""第三方"因此天然被排除。
 */
const CJK_ORDINAL_CHARS = "一二三四五六七八九十";
const CJK_DIGIT_VALUES = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function cjkOrdinalValue(token) {
  const s = String(token || "");
  if (!s) return 0;
  if (s.length === 1) return CJK_DIGIT_VALUES[s] || 0;
  const tenIndex = s.indexOf("十");
  if (tenIndex === -1) return 0;
  const tens = tenIndex === 0 ? 1 : (CJK_DIGIT_VALUES[s[0]] || 0);
  const rest = s.slice(tenIndex + 1);
  const ones = rest ? (CJK_DIGIT_VALUES[rest[0]] || 0) : 0;
  return tens * 10 + ones;
}

/**
 * 找出文本里所有"列举序号"的位置。
 *
 * 三种形态：
 *   中文序数    第一，/ 第二、/ 第一条，/ 第二点。
 *   中文"X是"   一是…/ 二是…（前面必须不是汉字，"统一是"不算）
 *   阿拉伯数字  1. / 2、/ 3)（前面必须是句读或行首，"1.5 倍"不算）
 *
 * 边界是拿 3819 条真实口述语料量出来的，改之前先看这组数：
 *   「第X + 句读标点」        30 次   ← 主战场（第一，×20 / 第二，×7）
 *   「第X + 条点项款 + 句读」   2 次   ← 保留（第一条，/ 第二点，）
 *   「第X + 条点项款 + 别的东西」 6 次   ← 全是同句引用，必须排除：
 *        "选择第二条路"、"第四项或者第五项里面切换"
 *        否则"第四条和第五条都要改一下"会被劈成两行
 *   「第X + 其他」（第二天/第一次/第三方） 103 次 ← 一个都不能切
 *
 * 所以量词后面也必须跟句读标点（或到行尾）才算列举项开头。
 */
const CLAUSE_PUNCT = "[，,、；;：:。！？!?]";

function findEnumerationMarkers(text) {
  const src = String(text || "");
  const markers = [];

  const cjkPattern = new RegExp(
    `第([${CJK_ORDINAL_CHARS}]{1,3})(?=${CLAUSE_PUNCT}|[条点项款](?:${CLAUSE_PUNCT}|$))`,
    "g",
  );
  for (const match of src.matchAll(cjkPattern)) {
    markers.push({
      index: match.index,
      length: match[0].length,
      ordinal: cjkOrdinalValue(match[1]),
      token: match[0],
    });
  }

  // "X是"：用 lookbehind 而不是吃掉前缀字符，省掉 index 补偿。
  // 条件是"前面不是汉字"——这样行首、标点、空白、英文数字都能起头。
  const listPattern = new RegExp(
    `(?<![\\u4e00-\\u9fff])([${CJK_ORDINAL_CHARS}])(?=是)`,
    "g",
  );
  for (const match of src.matchAll(listPattern)) {
    markers.push({
      index: match.index,
      length: match[1].length,
      ordinal: cjkOrdinalValue(match[1]),
      token: match[1],
      kind: "list",
    });
  }

  // (?<!\d) 是必要的：不然 "2026." 里的 "26." 会被当成第 26 项
  const numberPattern = /(?<!\d)(\d{1,2})\s*[、.．)）](?!\d)/g;
  for (const match of src.matchAll(numberPattern)) {
    markers.push({
      index: match.index,
      length: match[0].length,
      ordinal: Number(match[1]) || 0,
      token: match[0],
    });
  }

  return markers
    .filter((marker) => marker.ordinal > 0)
    .sort((a, b) => a.index - b.index);
}

/**
 * 把序号列举排成分行的列表。
 *
 * 只加换行，一个字符都不改——不重排语序、不改标点、不改用词。
 * 已经独立成行的序号（原文或上游已经分好段）不再重复插换行。
 */
function normalizeEnumerations(text) {
  const src = String(text || "");
  const markers = findEnumerationMarkers(src).filter((marker) => {
    // 序号前面是逗号/顿号时跳过：那说明它嵌在同一句话里
    // （"第十条讲的是缓存，第十一条讲的是并发"），不是列表项的开头。
    // 宁可少切，也不要把一句话从中间劈开——和终端避让同一个取舍。
    // "一是/二是"例外：它前面必须不是汉字（"统一是"不匹配），本身就已经
    // 是纯列举信号，不受这条约束。
    if (marker.kind === "list") return true;
    const prev = src[marker.index - 1] || "";
    return !/[，,、]/.test(prev);
  });
  if (markers.length < 2) return src;
  // 同一个序数出现两次（"第一个…第一个…"）不构成列举
  if (new Set(markers.map((marker) => marker.ordinal)).size < 2) return src;

  const parts = [];
  let cursor = 0;
  for (const marker of markers) {
    const before = src.slice(cursor, marker.index).replace(/\s+$/, "");
    parts.push(before);
    if (before !== "" && !before.endsWith("\n")) {
      parts.push("\n\n");
    }
    parts.push(src.slice(marker.index, marker.index + marker.length));
    cursor = marker.index + marker.length;
  }
  parts.push(src.slice(cursor));
  return parts.join("");
}

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
  constructor({ provider, endpoint, model, logger = null, timeoutMs, keepAlive, fallback } = {}) {
    const providerKey = PROVIDERS[provider] ? provider : DEFAULT_PROVIDER;
    this.api = PROVIDERS[providerKey];
    this.provider = providerKey;
    this.endpoint = String(endpoint || this.api.defaultEndpoint).replace(/\/+$/, "");
    this.model = String(model || this.api.defaultModel);
    this.logger = logger;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.keepAlive = keepAlive || DEFAULT_KEEP_ALIVE;
    this.available = null; // null=未探测, true/false=上次探测结果
    // 本机兜底后端：主后端"连不上/超时/HTTP 错误/空响应"时再试一次，避免
    // "AMD 一挂，长文本整理整体失效"（2026-09-20 晚实测挂了一整晚，用户看到的
    // "标点断句一塌糊涂"其实就是没整理的原文）。传实例直接用；传配置对象就地
    // 构造；备胎内部不再嵌套 fallback（防无限链）。传 null/省略 = 无兜底。
    if (fallback && typeof fallback === "object" && typeof fallback.format === "function") {
      this.fallback = fallback;
    } else if (fallback && typeof fallback === "object") {
      this.fallback = new LongTextFormatter({
        provider: fallback.provider,
        endpoint: fallback.endpoint,
        model: fallback.model,
        timeoutMs: Number(fallback.timeoutMs) > 0 ? Number(fallback.timeoutMs) : FALLBACK_TIMEOUT_MS,
        keepAlive: fallback.keepAlive || FALLBACK_KEEP_ALIVE,
        logger,
      });
    } else {
      this.fallback = null;
    }
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
    const primary = await this._warmupOnce();
    // 兜底后端一起预热：把 7B 拉进显存常驻（keep_alive 2h），别等第一次
    // failover 才付 25 秒冷启动。兜底预热失败不影响主流程。
    if (this.fallback) {
      try {
        await this.fallback.warmup();
      } catch {
        // 兜底预热失败只影响下次 failover 的首请求延迟，不阻断启动
      }
    }
    return primary;
  }

  async _warmupOnce() {
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
        return this._tryFallback(original, {
          text: original,
          changed: false,
          elapsed_ms: Date.now() - started,
          degraded: `http_${response.status}${detail ? `:${detail.slice(0, 120)}` : ""}`,
        });
      }

      const data = await response.json();
      const raw = this.api.parseContent(data) ?? "";
      // 有些模型（Qwen3 系列）把内容放进 reasoning 通道。正文空而思考链有
      // 内容，说明 token 被思考吃掉、答案根本没写出来 —— 视为失败回退原文，
      // 绝不能让空结果覆盖用户说的话。
      if (!String(raw).trim() && String(this.api.parseReasoning(data) || "").trim()) {
        return this._tryFallback(original, {
          text: original,
          changed: false,
          elapsed_ms: Date.now() - started,
          degraded: "reasoning_only",
        });
      }
      const cleaned = this.normalizeParagraphs(this.stripNoise(raw));

      if (!cleaned) {
        return this._tryFallback(original, {
          text: original,
          changed: false,
          elapsed_ms: Date.now() - started,
          degraded: "empty_response",
        });
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
      return this._tryFallback(original, {
        text: original,
        changed: false,
        elapsed_ms: Date.now() - started,
        degraded: message,
      });
    }
  }

  /**
   * 主后端不可用时用兜底后端再试一次。
   *
   * 只兜"后端不可用"：连不上、超时、HTTP 错误、空响应、思考污染——这些情况下
   * 主后端根本没产出内容。保真校验失败**不**走兜底：那说明主后端活着且输出了
   * 完整结果，只是内容漂移，换备胎重试是拿双倍延迟赌运气。
   *
   * 兜底成功 → 结果带 backend:"fallback" 与 primary_degraded（哪类失败触发的）。
   * 兜底也失败 → 返回主后端的失败结果，附加 fallback_degraded 供诊断。
   */
  async _tryFallback(original, primaryResult) {
    if (!this.fallback) return primaryResult;
    let fb;
    try {
      fb = await this.fallback.format(original);
    } catch (error) {
      return primaryResult;
    }
    if (fb.changed || (fb.degraded === null && typeof fb.text === "string")) {
      // changed=true：兜底整理出了可用结果。
      // changed=false 且 degraded=null：兜底后端活着、判定无需改动——同样
      // 优于"回退失败"，因为至少证明了兜底链路是通的。
      const result = {
        text: fb.text,
        changed: fb.changed,
        elapsed_ms: (primaryResult.elapsed_ms || 0) + (fb.elapsed_ms || 0),
        degraded: null,
        backend: "fallback",
        primary_degraded: primaryResult.degraded,
      };
      if (fb.ratio !== undefined) result.ratio = fb.ratio;
      return result;
    }
    return { ...primaryResult, fallback_degraded: fb.degraded };
  }
}

module.exports = {
  LongTextFormatter,
  bigramCoverage,
  spaceyRatio,
  normalizeEnumerations,
  findEnumerationMarkers,
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
