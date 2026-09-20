/**
 * hot-rule 的中英混排空格与专名规范化回归测试。
 *
 * 背景：真实录音 3807 条的离线审计发现两类系统性问题——
 *   1. 中英混排缺空格（~20%），如「走线上TTS就pass了」
 *   2. 专名写法不统一（Tailscale 实测 16 条正确 vs 15 条错写）
 * 用规则修这两类问题，风险在于可能误伤路径/URL/版本号，因此这些用例是测试重点。
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { HotRuleReplacer } = require("../src/helpers/hotRuleReplace");

const ROOT = path.join(__dirname, "..");
const RULE_FILE = path.join(ROOT, "assets", "hot-rule.txt");

function makeReplacer(ruleFile = RULE_FILE) {
  const r = new HotRuleReplacer({ filePath: ruleFile, fs });
  r.load(fs.readFileSync(ruleFile, "utf8"));
  return r;
}

test("规则文件能正常解析，且新增规则已被加载", () => {
  const r = makeReplacer();
  assert.ok(r.rules.length >= 55, `规则条数应 >= 55，实际 ${r.rules.length}`);
  const patterns = r.rules.map((x) => x.pattern);
  assert.ok(
    patterns.some((p) => p.includes("\\u4e00-\\u9fff")),
    "应有中英混排空格规则",
  );
});

test("中英混排：汉字与拉丁字母相邻时补空格", () => {
  const r = makeReplacer();
  const cases = [
    ["走线上TTS就pass了", "走线上 TTS 就 pass 了"],
    ["分功能提交commit", "分功能提交 commit"],
    ["我当前没有Windows的设备", "我当前没有 Windows 的设备"],
    ["GPU的服务一直占着GPU在", "GPU 的服务一直占着 GPU 在"],
    ["本地模型离线时只禁用AI功能", "本地模型离线时只禁用 AI 功能"],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(r.apply(input).text, expected, `输入: ${input}`);
  }
});

test("中英混排：已经带空格的写法保持幂等，不重复插空格", () => {
  const r = makeReplacer();
  const cases = [
    "走线上 TTS 就 pass 了",
    "我当前没有 Windows 的设备",
    "提交 commit，然后提交到 GitHub 上去。",
  ];
  for (const input of cases) {
    assert.strictEqual(r.apply(input).text, input, `应保持不变: ${input}`);
  }
});

test("中英混排：不动数字，版本号与 IP 原样保留", () => {
  const r = makeReplacer();
  const cases = [
    "v1.0.22 版本",
    "第2个 192.168.31.134 端口 18081",
    "一百二十毫安",
  ];
  for (const input of cases) {
    assert.strictEqual(r.apply(input).text, input, `数字不应被改动: ${input}`);
  }
});

test("专名归一：Tailscale 的四种写法都收敛到 Tailscale", () => {
  const r = makeReplacer();
  const cases = [
    ["连 tailscale 的域名", "连 Tailscale 的域名"],
    ["用TailScale的路径", "用 Tailscale 的路径"],
    ["需要 Tail Scale 访问", "需要 Tailscale 访问"],
    ["TAILSCALE 账号", "Tailscale 账号"],
    ["发布到tcale的网络里面", "发布到 Tailscale 的网络里面"],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(r.apply(input).text, expected, `输入: ${input}`);
  }
});

test("专名归一：GitHub 的大小写变体统一", () => {
  const r = makeReplacer();
  const cases = [
    ["提交代码到github上去", "提交代码到 GitHub 上去"],
    ["发布到GITHUB", "发布到 GitHub"],
    ["Github啊，这些名词", "GitHub 啊，这些名词"],
    ["代码提交到 Git Hub 我自己的仓库", "代码提交到 GitHub 我自己的仓库"],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(r.apply(input).text, expected, `输入: ${input}`);
  }
});

test("保护路径与 URL：不得把 github/agx 改成大写", () => {
  const r = makeReplacer();
  const cases = [
    "~/github/capswriter-agx-client 仓库",
    "/home/ivan/github/capswriter-agx-client",
    "https://github.com/redyuan43/capswriter-agx-client",
    "github.com 打不开",
    "capswriter-agx-client 项目",
    "https://agx.local 这个地址",
  ];
  for (const input of cases) {
    assert.strictEqual(r.apply(input).text, input, `路径/URL 不应被改动: ${input}`);
  }
});

test("保护连写专名：GitHubDesktop 不被拆开", () => {
  const r = makeReplacer();
  const input = "GitHubDesktop 客户端";
  assert.strictEqual(r.apply(input).text, input);
});

test("规则可重复应用且结果稳定（幂等）", () => {
  const r = makeReplacer();
  const inputs = [
    "提交代码到github上去。然后把text的地址发给我。",
    "走线上TTS就pass了是什么意思？",
    "用TailScale的路径会快一些",
  ];
  for (const input of inputs) {
    const once = r.apply(input).text;
    const twice = r.apply(once).text;
    assert.strictEqual(twice, once, `第二次应用不应产生变化: ${input}`);
  }
});

test("空输入与非字符串输入不抛异常", () => {
  const r = makeReplacer();
  assert.doesNotThrow(() => r.apply(""));
  assert.doesNotThrow(() => r.apply(null));
  assert.doesNotThrow(() => r.apply(undefined));
  assert.strictEqual(r.apply("").text, "");
});

test("loadFromFile：规则文件被修改后能热重载，改回即恢复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotrule-"));
  const file = path.join(dir, "hot-rule.txt");
  try {
    fs.writeFileSync(file, "走线上TTS = 走线上语音合成\n", "utf8");
    const r = new HotRuleReplacer({ filePath: file, fs });
    assert.strictEqual(r.loadFromFile(), 1);

    // 模拟用户编辑文件（mtime 必须变化才触发重载）
    fs.writeFileSync(file, "github = GitHub\n", "utf8");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    assert.strictEqual(r.loadFromFile(), 1, "应重新读取到 1 条规则");
    assert.strictEqual(r.apply("github").text, "GitHub");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFromFile：文件读取失败时保留上次规则，不清空", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotrule-"));
  const file = path.join(dir, "hot-rule.txt");
  try {
    fs.writeFileSync(file, "github = GitHub\n", "utf8");
    const r = new HotRuleReplacer({ filePath: file, fs });
    assert.strictEqual(r.loadFromFile(), 1);

    // 文件被临时移走（编辑器改名 / 用户误删）
    fs.renameSync(file, `${file}.moved`);
    const count = r.loadFromFile();
    assert.strictEqual(count, 1, "读取失败应返回上次的规则条数");
    assert.strictEqual(r.apply("github").text, "GitHub", "上次的规则仍应生效");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
