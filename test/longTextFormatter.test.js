/**
 * 长文本整理回归测试
 *
 * 背景：本机实测踩到的两个坑，用测试钉住：
 *  1. Qwen3-4B 在 think:false 下会把思考内容倒进正文，输出长度涨到原文 6 倍。
 *     如果当时没有保真校验，这种输出会直接替换掉用户原文。所以
 *     validate() 的行为必须被测试覆盖——它是最后一道防线。
 *  2. 任何一环出错都必须回退原文。用户说的是他的话，不能被"整理"弄丢。
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  LongTextFormatter,
  bigramCoverage,
  spaceyRatio,
  normalizeEnumerations,
  findEnumerationMarkers,
  PROMPT_TEMPLATE,
  PROVIDERS,
  DEFAULT_PROVIDER,
  MAX_SPACEY_RATIO,
  MIN_RATIO,
  MAX_RATIO,
} = require("../src/helpers/longTextFormatter");

const SAMPLE = "然后那个，我觉得这个方案可以。呃，但是它太慢了。";

/**
 * 默认构造走 ollama —— 这条路径的响应形状简单（message.content），
 * 适合测整理逻辑本身。AMD（openai）路径另有专门的形状测试。
 */
function makeFormatter(overrides = {}) {
  return new LongTextFormatter({
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen2.5:3b",
    timeoutMs: 5000,
    ...overrides,
  });
}

/** 线上默认后端：AMD 的 OpenAI 兼容端点。 */
function makeAmdFormatter(overrides = {}) {
  return new LongTextFormatter({
    provider: "openai",
    endpoint: "http://100.90.114.26:18106/v1",
    model: "Qwen/Qwen3.8-Flash-Next-ROCmFP4-FAST-imatrix-MTP",
    timeoutMs: 8000,
    ...overrides,
  });
}

/** 用固定响应替换全局 fetch，返回还原函数。 */
function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = original;
  };
}

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ *
 * 保真校验——最后一道防线
 * ------------------------------------------------------------------ */

test("validate 接受正常整理结果（删口头语、分段后长度略变）", () => {
  const f = makeFormatter();
  const result = f.validate(SAMPLE, "我觉得这个方案可以。\n\n但是它太慢了。");
  assert.equal(result.ok, true, `应通过，实际 ${result.reason}`);
});

test("validate 拦住逐词加空格的崩坏输出（3B 在中英混排上的失效模式）", () => {
  const f = makeFormatter();
  // 实测本机 3B 的真实输出：字一个不少、覆盖率还有 0.98，但空格插在汉字之间
  const garbage = "AMD 没 部署 ， 按 你说 的 ， 本机 先 验证 有效 。";
  const r = f.validate(SAMPLE, garbage);
  assert.equal(r.ok, false);
  assert.ok(/space_garbage/.test(r.reason), `实际 ${r.reason}`);
});

test("spaceyRatio 不把中英之间的正常空格算作劣化", () => {
  assert.equal(spaceyRatio("这是一段正常的中文文本，没有任何多余空格。"), 0);
  assert.equal(
    spaceyRatio("用 AMD 的 handle 层做校验"),
    0,
    "中英相邻的空格是正常排版，不能误判成崩坏"
  );
  assert.ok(spaceyRatio("这 是 崩 坏 的 输 出") > MAX_SPACEY_RATIO);
});

test("PROMPT_TEMPLATE 明确禁止替换同义词（否则 AMD 27B 会被保真校验拦掉）", () => {
  // 实测：不加这条，27B 会把"没走真人麦克风的一次"改写成"本次未使用真人麦克风"，
  // 双字组覆盖率掉到 0.72，整条被保真校验拒绝。
  assert.ok(/禁止：替换同义词/.test(PROMPT_TEMPLATE), "少了这条约束，27B 会改写措辞");
  assert.ok(/接回完整/.test(PROMPT_TEMPLATE), "修 ASR 误断句是本版的核心目标");
});

test("validate 拒绝被改写成 6 倍长度的输出（Qwen3 实测故障形态）", () => {
  const f = makeFormatter();
  const garbage = "首先，用户要求我整理一段语音转写。只做三件事：".repeat(20);
  const result = f.validate(SAMPLE, garbage);
  assert.equal(result.ok, false);
  assert.match(result.reason, /^too_long/);
});

test("validate 拒绝被总结成一句话的输出", () => {
  const f = makeFormatter();
  const long =
    "现在手机界面的交互界面还是有问题。第一个就是你下载到手机上，如果是在下载过程中能看到状态的变化，" +
    "下载完了也能看到状态的。上同步也需要看到服务器上的变化，也需要看到手机上服务器同步时候的锁定状态。";
  const result = f.validate(long, "下载状态同步");
  assert.equal(result.ok, false);
  assert.match(result.reason, /^too_short/);
});

test("validate 拒绝空输出", () => {
  const f = makeFormatter();
  const result = f.validate(SAMPLE, "   \n  ");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_output");
});

test("validate 阈值边界符合常量定义", () => {
  const f = makeFormatter();
  // 无标点的纯净文本，方便精确控制长度比
  const base = "一二三四五六七八九十".repeat(4); // 40 字
  const atMin = "一二三四五六七八九十".repeat(3).slice(0, Math.floor(40 * MIN_RATIO));
  assert.equal(f.validate(base, atMin).ok, true, "恰好在下界应通过");
  const belowMin = atMin.slice(0, -1);
  assert.equal(f.validate(base, belowMin).ok, false, "低于下界应拒绝");
});

/**
 * 双字组覆盖率：抓"等长改写"。
 * 长度比看不出来——把原句换个说法，字数几乎不变，但已经不是用户说的话了。
 */
test("validate 拒绝同义改写（长度比正常但用词被换掉）", () => {
  const f = makeFormatter();
  const original =
    "现在手机界面的交互界面还是有问题。第一个就是你下载到手机上，如果是在下载过程中能看到状态的变化，" +
    "下载完了也能看到状态的。上同步也需要看到服务器上的变化，也需要看到手机上服务器同步时候的锁定状态以及。" +
    "及服务器同步完了之后的状态。同理，在服务器端也要能看到实时同步的状态，这样才合理。";
  const rewritten =
    "现在手机界面的交互存在问题。第一个问题就是下载到手机上时，如果在下载过程中能看见状态的变化，" +
    "在下载完成后也能看到状态的变化。同步也需要能看到服务器上的变化，以及在服务器同步过程中和同步完成后的状态。" +
    "同理，在服务器端也要能看到实时同步的状态，这样才合理。";
  const result = f.validate(original, rewritten);
  assert.equal(result.ok, false, "同义改写必须被拒绝");
  assert.match(result.reason, /^rewritten/);
});

test("validate 接受只加分段的忠实整理", () => {
  const f = makeFormatter();
  const original =
    "现在手机界面的交互界面还是有问题。第一个就是你下载到手机上，如果是在下载过程中能看到状态的变化，" +
    "下载完了也能看到状态的。上同步也需要看到服务器上的变化。";
  const segmented = original.replace(/。(?=第|上)/g, "。\n\n");
  assert.ok(segmented.includes("\n"), "该用例应确实插入了换行");
  const result = f.validate(original, segmented);
  assert.equal(result.ok, true, `分段不该影响覆盖率，实际 ${result.reason}`);
});

test("validate 接受修错别字（只动几个字不该被判成改写）", () => {
  const f = makeFormatter();
  const original = "也需要看到手机上服务器同步时候的楼定状态以及。及服务器同步完了之后的状态。";
  const fixed = "也需要看到手机上服务器同步时候的锁定状态以及服务器同步完了之后的状态。";
  const result = f.validate(original, fixed);
  assert.equal(result.ok, true, `改错别字不该被拒，实际 ${result.reason}`);
});

test("bigramCoverage 对完全相同文本返回 1", () => {
  assert.equal(bigramCoverage("一二三四五六七八", "一二三四五六七八"), 1);
});

test("bigramCoverage 对完全无关文本返回 0", () => {
  assert.equal(bigramCoverage("一二三四五六七八", "甲乙丙丁戊己庚辛"), 0);
});

/* ------------------------------------------------------------------ *
 * 触发决策——终端必须避让，短句不该白等一次推理
 * ------------------------------------------------------------------ */

test("shouldRunLongFormat 对终端场景一律拒绝（换行会被当成回车执行）", () => {
  const { TextPolisher } = require("../src/platform/electron/textPolish");
  const polisher = new TextPolisher({ dataDirectory: null, logger: null });
  const longText = "这".repeat(200);
  const decision = polisher.shouldRunLongFormat(longText, { isTerminal: true, minChars: 40 });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "terminal");
});

test("shouldRunLongFormat 对短句跳过（分段没有意义）", () => {
  const { TextPolisher } = require("../src/platform/electron/textPolish");
  const polisher = new TextPolisher({ dataDirectory: null, logger: null });
  const short = "提交 commit，然后提交到 GitHub 上去。";
  const decision = polisher.shouldRunLongFormat(short, { isTerminal: false, minChars: 40 });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "below_min_chars");
});

test("shouldRunLongFormat 对长句放行，且字符数不计标点", () => {
  const { TextPolisher } = require("../src/platform/electron/textPolish");
  const polisher = new TextPolisher({ dataDirectory: null, logger: null });
  const longText = "现在手机界面的交互界面还是有问题，第一个就是下载到手机上的时候。".repeat(3);
  const decision = polisher.shouldRunLongFormat(longText, { isTerminal: false, minChars: 40 });
  assert.equal(decision.run, true);
  assert.ok(decision.contentChars < longText.length, "标点不该计入字数");
});

test("shouldRunLongFormat 在窗口未知时也拒绝——整理是危险动作，判不出来就不能做", () => {
  // 2026-09-20 端到端回放抓到的方向性错误：原来读不到窗口就返回 false
  // （= 不是终端），于是照样排版。终端里换行等于回车执行，代价太大。
  const { TextPolisher } = require("../src/platform/electron/textPolish");
  const polisher = new TextPolisher({ dataDirectory: null, logger: null });
  const longText = "这".repeat(200);
  for (const isTerminal of [undefined, null]) {
    const decision = polisher.shouldRunLongFormat(longText, { isTerminal, minChars: 40 });
    assert.equal(decision.run, false, `isTerminal=${isTerminal} 时不该整理`);
    assert.equal(decision.reason, "unknown_window");
  }
  // 不传 isTerminal 整体也不能放行
  assert.equal(polisher.shouldRunLongFormat(longText, { minChars: 40 }).run, false);
});

/* ------------------------------------------------------------------ *
 * 输出清洗——模型偶尔会加围栏或前缀
 * ------------------------------------------------------------------ */

test("stripNoise 剥掉 markdown 代码围栏", () => {
  const f = makeFormatter();
  assert.equal(f.stripNoise("```\n我觉得这个方案可以。\n```"), "我觉得这个方案可以。");
});

test("stripNoise 剥掉模型自加的前缀", () => {
  const f = makeFormatter();
  assert.equal(f.stripNoise("整理后：我觉得这个方案可以。"), "我觉得这个方案可以。");
  assert.equal(f.stripNoise("以下是整理后的文本\n我觉得这个方案可以。"), "我觉得这个方案可以。");
});

test("stripNoise 对干净输入不做改动", () => {
  const f = makeFormatter();
  assert.equal(f.stripNoise("  我觉得这个方案可以。  "), "我觉得这个方案可以。");
});

/* ------------------------------------------------------------------ *
 * 段落规整——模型会在逗号处硬换行，那是噪声不是分段
 * ------------------------------------------------------------------ */

test("normalizeParagraphs 把断在逗号上的换行并回上一段", () => {
  // 真实回放的输出：135 字被切成 6 行，每行断在逗号上
  const f = makeFormatter();
  const messy = [
    "把下指令实现了，",
    "就是既然知道了sessionID，其实就可以用 Codex ACP 继续给这个对话下指令。",
    "所以说下面可以增加一个对话框，",
    "可以增加一个输入按钮，",
    "实现在 Checkbox 的session context 里面就能继续的发指令。",
  ].join("\n");
  const out = f.normalizeParagraphs(messy);
  const lines = out.split(/\n+/);
  assert.equal(lines.length, 2, `应并成 2 段，实际 ${lines.length} 段：${JSON.stringify(lines)}`);
  assert.ok(lines[0].endsWith("。"));
  assert.ok(lines[1].endsWith("。"));
  // 内容不能丢
  assert.ok(out.includes("把下指令实现了，就是既然知道了sessionID"));
});

test("normalizeParagraphs 保留按句号分好的段落", () => {
  const f = makeFormatter();
  const tidy = "我要实现对电脑进行 web coding，但是我的耳机是连在手机上的。\n然后我释放按键的时候，它就能把录音传到我指定的服务器上进行解码。";
  const out = f.normalizeParagraphs(tidy);
  assert.equal(out.split(/\n+/).length, 2, "本来就是好段落，不该被改动");
  // 段落之间统一成空行：单换行在聊天窗口里常被当软换行合并，段就白分了
  assert.equal(out, tidy.replace(/\n/g, "\n\n"));
});

test("normalizeParagraphs 把模型多打的空行规整成标准段间距", () => {
  const f = makeFormatter();
  const out = f.normalizeParagraphs("第一句话在这里。\n\n\n第二句话在这里。\n\n");
  assert.equal(out, "第一句话在这里。\n\n第二句话在这里。");
});

test("normalizeParagraphs 单段文本原样返回", () => {
  const f = makeFormatter();
  const single = "这句话没有换行也没有句末标点";
  assert.equal(f.normalizeParagraphs(single), single);
});

test("normalizeParagraphs 中英混排相邻时补空格，纯中文不补", () => {
  const f = makeFormatter();
  assert.equal(f.normalizeParagraphs("使用 Codex\nACP 继续。"), "使用 Codex ACP 继续。");
  assert.equal(f.normalizeParagraphs("使用这个，\n继续。"), "使用这个，继续。");
});

test("normalizeParagraphs 句末标点带引号/括号也算断句", () => {
  const f = makeFormatter();
  const out = f.normalizeParagraphs("他说“可以了。”\n那就这样办。");
  assert.equal(out.split(/\n+/).length, 2, "引号结尾仍算句末");
});

test("normalizeParagraphs 去掉中文标点前后的多余空格", () => {
  // 真实回放输出：知道了 sessionID ，其实
  const f = makeFormatter();
  assert.equal(
    f.normalizeParagraphs("就是既然知道了 sessionID ，其实就可以继续。"),
    "就是既然知道了 sessionID，其实就可以继续。"
  );
  assert.equal(f.normalizeParagraphs("参考（ 见上文 ）即可。"), "参考（见上文）即可。");
});

/* ------------------------------------------------------------------ *
 * prompt 构造
 * ------------------------------------------------------------------ */

test("buildPrompt 把原文插进去且不留占位符", () => {
  const f = makeFormatter();
  const prompt = f.buildPrompt(SAMPLE);
  assert.ok(prompt.includes(SAMPLE), "应包含原文");
  assert.ok(!prompt.includes("${text}"), "不应残留未替换的占位符");
});

test("PROMPT_TEMPLATE 保持简短——长规则清单会让小模型复述要求", () => {
  // 实测：给 Qwen3-4B 一份"角色+四规则+五禁止"的长 prompt，
  // 它会把要求本身当成待分析文本复述。这里设个上限防回退。
  assert.ok(
    PROMPT_TEMPLATE.length < 400,
    `prompt 过长（${PROMPT_TEMPLATE.length} 字符），小模型会复述要求而不是执行`
  );
});

/* ------------------------------------------------------------------ *
 * format 的失败回退
 * ------------------------------------------------------------------ */

test("format 在网络失败时回退原文", async () => {
  const f = makeFormatter();
  const restore = stubFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  try {
    const result = await f.format(SAMPLE);
    assert.equal(result.text, SAMPLE, "必须原样返回");
    assert.equal(result.changed, false);
    assert.ok(result.degraded, "应记录降级原因");
  } finally {
    restore();
  }
});

test("format 在输出未通过保真校验时回退原文", async () => {
  const f = makeFormatter();
  const restore = stubFetch(async () =>
    jsonResponse({ message: { content: "首先，用户要求我整理。".repeat(30) } })
  );
  try {
    const result = await f.format(SAMPLE);
    assert.equal(result.text, SAMPLE, "越界输出必须被丢弃");
    assert.equal(result.changed, false);
    assert.match(result.degraded, /^fidelity:/);
  } finally {
    restore();
  }
});

test("format 在 HTTP 非 200 时回退原文", async () => {
  const f = makeFormatter();
  const restore = stubFetch(async () => jsonResponse({ error: "model not found" }, false, 404));
  try {
    const result = await f.format(SAMPLE);
    assert.equal(result.text, SAMPLE);
    assert.match(result.degraded, /^http_404/);
  } finally {
    restore();
  }
});

test("format 空输入直接返回，不发起请求", async () => {
  const f = makeFormatter();
  let called = false;
  const restore = stubFetch(async () => {
    called = true;
    return jsonResponse({});
  });
  try {
    const result = await f.format("   ");
    assert.equal(result.text, "   ");
    assert.equal(called, false, "空输入不该浪费一次推理");
  } finally {
    restore();
  }
});

test("format 成功时返回整理结果（含段落规整）", async () => {
  const f = makeFormatter();
  // 模型给的是"句号后接两行、行尾逗号"的毛坯，返回前应被规整
  const rawFromModel = "我觉得这个方案可以，\n但是它太慢了。";
  const restore = stubFetch(async () => jsonResponse({ message: { content: rawFromModel } }));
  try {
    const result = await f.format(SAMPLE);
    assert.equal(result.text, "我觉得这个方案可以，但是它太慢了。");
    assert.equal(result.changed, true);
    assert.equal(result.degraded, null);
  } finally {
    restore();
  }
});

test("format 在模型原样返回时不标记 changed", async () => {
  const f = makeFormatter();
  const restore = stubFetch(async () => jsonResponse({ message: { content: SAMPLE } }));
  try {
    const result = await f.format(SAMPLE);
    assert.equal(result.changed, false, "没变化就不该报告变化");
    assert.equal(result.degraded, null, "没变化不算降级");
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * 驻留与预热——冷启动 3.1s 会吃掉 5s 超时的大半（ollama 路径）
 * ------------------------------------------------------------------ */

test("format 在 ollama 下带 keep_alive，避免每次口述都重新加载模型", async () => {
  const f = makeFormatter({ provider: "ollama" });
  let body = null;
  const restore = stubFetch(async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ message: { content: SAMPLE } });
  });
  try {
    await f.format(SAMPLE);
    assert.equal(body.keep_alive, "30m", "不带 keep_alive 就退回 ollama 默认的 5 分钟");
  } finally {
    restore();
  }
});

test("format 请求不带 think 参数（Qwen3 会因此把思考倒进正文）", async () => {
  const f = makeFormatter();
  let body = null;
  const restore = stubFetch(async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ message: { content: SAMPLE } });
  });
  try {
    await f.format(SAMPLE);
    assert.ok(!("think" in body), "传 think 会触发 Qwen3 的异常模式");
  } finally {
    restore();
  }
});

test("warmup 在 ollama 下带 keep_alive，否则刚加载完 5 分钟又被卸掉", async () => {
  const f = makeFormatter({ provider: "ollama" });
  let body = null;
  const restore = stubFetch(async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ done: true });
  });
  try {
    const result = await f.warmup();
    assert.equal(result.ok, true);
    assert.equal(body.keep_alive, "30m");
    assert.ok(body.options.num_predict > 0, "预热不该生成正文");
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * AMD（openai 兼容）路径——线上默认后端
 * ------------------------------------------------------------------ */

test("默认后端是 AMD 的 openai 端点", () => {
  assert.equal(DEFAULT_PROVIDER, "openai");
  assert.ok(PROVIDERS.openai.defaultEndpoint.startsWith("http"), "得有默认端点");
  const f = new LongTextFormatter({ logger: null });
  assert.equal(f.provider, "openai");
  assert.ok(f.endpoint.includes("18106"), "默认应指向 AMD 网关");
});

test("openai 路径打 /chat/completions，用 max_tokens 而不是 num_predict", async () => {
  const f = makeAmdFormatter();
  let url = null;
  let body = null;
  const restore = stubFetch(async (u, init) => {
    url = u;
    body = JSON.parse(init.body);
    return jsonResponse({ choices: [{ message: { content: SAMPLE } }] });
  });
  try {
    await f.format(SAMPLE);
    assert.ok(url.endsWith("/v1/chat/completions"), `实际打到 ${url}`);
    assert.ok(body.max_tokens > 0, "openai 协议用 max_tokens");
    assert.ok(!("options" in body), "openai 协议没有 options 字段");
    assert.ok(!("keep_alive" in body), "openai 端点不接受 keep_alive");
    assert.ok(body.temperature <= 0.2, "整理是确定性任务，温度必须压低");
  } finally {
    restore();
  }
});

test("openai 路径能从 choices[0].message.content 取到结果", async () => {
  const f = makeAmdFormatter();
  const polished = "我觉得这个方案可以。\n\n但是它太慢了。";
  const restore = stubFetch(async () =>
    jsonResponse({ choices: [{ message: { content: polished } }] })
  );
  try {
    const result = await f.format(SAMPLE);
    assert.equal(result.changed, true);
    assert.equal(result.text, polished);
    assert.equal(result.degraded, null);
  } finally {
    restore();
  }
});

test("模型只在思考通道出内容时回退原文，不留空结果", async () => {
  const f = makeAmdFormatter();
  const restore = stubFetch(async () =>
    jsonResponse({ choices: [{ message: { content: "", reasoning_content: "嗯，我先把这段话读一遍…" } }] })
  );
  try {
    const result = await f.format(SAMPLE);
    assert.equal(result.text, SAMPLE, "不能拿空结果覆盖原文");
    assert.equal(result.changed, false);
    assert.ok(/reasoning_only/.test(result.degraded || ""), `实际 degraded=${result.degraded}`);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * 序号列举排版（normalizeEnumerations）
 *
 * 用户说"第一…第二…第三…"时期望看到分行的列表。这是纯规则，
 * 不依赖模型——所以边界必须钉死，尤其是"不要误伤普通词"这一侧。
 * ------------------------------------------------------------------ */

test("口述列举序号会被排成分行列表", () => {
  const text = "另外，我之前说了，你有些回复。第一，怎么样？第二，怎么样？第三，怎么样的时候，你能把格式排好就已经不错了。";
  const out = normalizeEnumerations(text);
  const lines = out.split(/\n+/).filter(Boolean);
  assert.equal(lines.length, 4, `应切成 4 段（引言 + 3 项），实际 ${lines.length}`);
  assert.ok(lines[1].startsWith("第一，"));
  assert.ok(lines[2].startsWith("第二，"));
  assert.ok(lines[3].startsWith("第三，"));
});

test("列举排版只加换行，不增删任何字符", () => {
  const text = "我说三件事。第一，甲。第二，乙。";
  const out = normalizeEnumerations(text);
  const strip = (s) => s.replace(/\s/g, "");
  assert.equal(strip(out), strip(text), "除了空白，一个字符都不该变");
});

test("只出现一个序号时不算列举", () => {
  const text = "第一，这个事情我是这么想的，后面还有别的安排。";
  assert.equal(normalizeEnumerations(text), text);
});

test("第一次/第三方/第一版这类词不会被误判成列表", () => {
  for (const text of [
    "第一次做这个事的时候我还没想明白。",
    "这是第三方库，第一版的时候用的是旧的 API。",
    "他第一时间就通知我了，第一台机器也是他装的。",
  ]) {
    assert.equal(normalizeEnumerations(text), text, `不该改动：${text}`);
  }
});

test("阿拉伯数字列举会被切开", () => {
  const out = normalizeEnumerations("我准备了三件事1. 修客户端2. 加排版3. 提交部署");
  const lines = out.split(/\n+/).filter(Boolean);
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith("1."));
  assert.ok(lines[3].startsWith("3."));
});

test("一是/二是会被识别成列举", () => {
  const out = normalizeEnumerations("原因有两个，一是没接线，二是模型太小。");
  assert.equal(out.split(/\n+/).filter(Boolean).length, 3, `实际：${JSON.stringify(out)}`);
});

test("小数和年份不会被当成序号", () => {
  for (const text of [
    "速度提升到 1.5 倍左右，效果还可以。",
    "2026. 这一年我们做了很多事。",
  ]) {
    assert.equal(normalizeEnumerations(text), text, `不该改动：${text}`);
  }
});

test("序号嵌在同一句话里（前面是逗号）不切开", () => {
  const text = "第十条讲的是缓存，第十一条讲的是并发。";
  assert.equal(normalizeEnumerations(text), text, "逗号后面的序号是句子的一部分，不是列表项");
});

test("已经分好行的列举不会被重复插换行（幂等）", () => {
  const text = "第一，甲。\n\n第二，乙。";
  assert.equal(normalizeEnumerations(text), text);
  assert.equal(normalizeEnumerations(normalizeEnumerations(text)), text);
});

test("findEnumerationMarkers 能给出中文序数的数值", () => {
  const markers = findEnumerationMarkers("第三条讲缓存，第十一条讲并发。");
  assert.deepEqual(markers.map((m) => m.ordinal), [3, 11]);
});

test("textPolish 在整理服务不可用时也做列举排版", async () => {
  const { TextPolisher } = require("../src/platform/electron/textPolish");
  const polisher = new TextPolisher({ dataDirectory: null, logger: null });
  const text = "我说三件事。第一，甲。第二，乙。第三，丙。";
  const result = await polisher.polish(text, {
    longFormat: { enabled: true, minChars: 40, isTerminal: false },
  });
  assert.ok(
    result.stages.some((stage) => stage.stage === "enumeration_format"),
    `应记录 enumeration_format 阶段，实际 ${JSON.stringify(result.stages)}`
  );
  assert.equal(result.text.split(/\n+/).filter(Boolean).length, 4);
});

test("textPolish 在终端里连列举排版也不做（换行=回车）", async () => {
  const { TextPolisher } = require("../src/platform/electron/textPolish");
  const polisher = new TextPolisher({ dataDirectory: null, logger: null });
  const text = "我说三件事。第一，甲。第二，乙。第三，丙。";
  const result = await polisher.polish(text, {
    longFormat: { enabled: true, minChars: 40, isTerminal: true },
  });
  assert.equal(result.text, text, "终端里绝不能插换行");
  assert.equal(result.stages.some((stage) => stage.stage === "enumeration_format"), false);
});

test("textPolish 在窗口未知时也不排版", async () => {
  const { TextPolisher } = require("../src/platform/electron/textPolish");
  const polisher = new TextPolisher({ dataDirectory: null, logger: null });
  const text = "我说三件事。第一，甲。第二，乙。第三，丙。";
  const result = await polisher.polish(text, {
    longFormat: { enabled: true, minChars: 40, isTerminal: null },
  });
  assert.equal(result.text, text);
});
