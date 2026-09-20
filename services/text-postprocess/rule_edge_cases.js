#!/usr/bin/env node
/** 边界用例验证：确认规则只改该改的，不碰路径/URL/版本号。 */
const fs = require("fs");
const path = require("path");
const { HotRuleReplacer } = require("../../src/helpers/hotRuleReplace");

const F = path.join(__dirname, "..", "..", "assets", "hot-rule.txt");
const r = new HotRuleReplacer({ filePath: F, fs });
r.load(fs.readFileSync(F, "utf8"));

const cases = [
  ["~ 路径", "~/github/capswriter-agx-client 仓库"],
  ["绝对路径", "/home/ivan/github/capswriter-agx-client"],
  ["URL", "https://github.com/redyuan43/capswriter-agx-client"],
  ["域名", "github.com 打不开"],
  ["连写专名", "GitHubDesktop 客户端"],
  ["版本号", "v1.0.22 版本"],
  ["数字紧贴", "第2个 192.168.31.134 端口 18081"],
  ["自然语言小写", "提交代码到github上去"],
  ["驼峰错写", "用TailScale的路径"],
  ["拆开", "需要 Tail Scale 访问"],
  ["全大写", "发布到GITHUB"],
  ["agx 路径", "capswriter-agx-client 项目"],
  ["agx 主机名", "https://agx.local 这个地址"],
  ["agx 自然语言", "agx 那台设备"],
  ["中英混排", "走线上TTS就pass了"],
  ["已带空格", "走线上 TTS 就 pass 了"],
  ["英文标点", "Edge, LM Studio 运行不起来"],
  ["纯英文", "hello world"],
  ["空字符串", ""],
];

let same = 0;
let chg = 0;
for (const [n, s] of cases) {
  const o = r.apply(s).text;
  if (o === s) {
    same += 1;
    console.log(`  不动 | ${n.padEnd(12)} | ${s}`);
  } else {
    chg += 1;
    console.log(`  改动 | ${n.padEnd(12)} | ${s}`);
    console.log(`       |              -> ${o}`);
  }
}
console.log(`\n合计: ${cases.length} 例，改动 ${chg}，不动 ${same}`);
