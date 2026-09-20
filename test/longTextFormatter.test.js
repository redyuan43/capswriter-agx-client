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
  PROMPT_TEMPLATE,
  MIN_RATIO,
  MAX_RATIO,
} = require("../src/helpers/longTextFormatter");

const SAMPLE = "然后那个，我觉得这个方案可以。呃，但是它太慢了。";

function makeFormatter(overrides = {}) {
  return new LongTextFormatter({
    endpoint: "http://127.0.0.1:11434",
    model: "qwen2.5:3b",
    timeoutMs: 5000,
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
  const lines = out.split("\n");
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
  assert.equal(out.split("\n").length, 2, "本来就是好段落，不该被改动");
  assert.equal(out, tidy);
});

test("normalizeParagraphs 丢掉模型多打的空行", () => {
  const f = makeFormatter();
  const out = f.normalizeParagraphs("第一句话在这里。\n\n\n第二句话在这里。\n\n");
  assert.equal(out, "第一句话在这里。\n第二句话在这里。");
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
  assert.equal(out.split("\n").length, 2, "引号结尾仍算句末");
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
 * 驻留与预热——冷启动 3.1s 会吃掉 5s 超时的大半
 * ------------------------------------------------------------------ */

test("format 请求带 keep_alive，避免每次口述都重新加载模型", async () => {
  const f = makeFormatter();
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

test("warmup 也带 keep_alive，否则刚加载完 5 分钟又被卸掉", async () => {
  const f = makeFormatter();
  let body = null;
  const restore = stubFetch(async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ done: true });
  });
  try {
    const result = await f.warmup();
    assert.equal(result.ok, true);
    assert.equal(body.keep_alive, "30m");
    assert.equal(body.options.num_predict, 1, "预热不该生成正文");
  } finally {
    restore();
  }
});
