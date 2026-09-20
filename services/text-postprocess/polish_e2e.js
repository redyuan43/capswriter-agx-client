#!/usr/bin/env node
/**
 * 端到端验证文本整理链路：加载真实的 TextPolisher（主进程实际使用的类）
 * + 真实的用户规则文件，跑几条真实转写文本，确认规则生效且不误伤。
 *
 * 不消耗 ASR 额度（不调用 ASR，只验证 ASR 之后的整理阶段）。
 * 用法: node services/text-postprocess/polish_e2e.js
 */
const os = require("os");
const path = require("path");
const { TextPolisher } = require("../../src/platform/electron/textPolish");

const DATA_DIR = path.join(os.homedir(), ".config", "语音转写");

const logs = [];
const logger = {
  info: (m, d) => logs.push(["info", m, d]),
  warn: (m, d) => logs.push(["warn", m, d]),
  error: (m, d) => logs.push(["error", m, d]),
  debug: () => {},
};

const CASES = [
  // 来自真实录音（metadata.jsonl），覆盖本次修复的两类问题
  "提交代码到github上去。然后把问题。发布到tcale的网络里面。",
  "设备上为什么有一个稳定在跑的？GPU的服务一直占着GPU在。",
  "所以现在到底是什么问题？Tailscale a webstick啊。Github啊，这些名词你都能说对吗？",
  "你上面说同样走线上TTS就pass了是什么意思？",
  // 负例：这些不该被改动
  "~/github/capswriter-agx-client 这个仓库",
  "https://github.com/redyuan43/capswriter-agx-client",
  "现在跑的是 v1.0.23 版本",
  "第2个 192.168.31.134 端口 18081",
];

(async () => {
  const polisher = new TextPolisher({ dataDirectory: DATA_DIR, logger });
  console.log(`规则文件: ${polisher.rulePath}`);
  console.log(`数据目录: ${DATA_DIR}\n`);

  let changed = 0;
  for (const raw of CASES) {
    const r = await polisher.polish(raw, { hotRule: true, punctuation: "off" });
    const mark = r.text === raw ? "不动" : "改动";
    if (r.text !== raw) changed += 1;
    console.log(`  ${mark} | ${raw}`);
    if (r.text !== raw) console.log(`       | -> ${r.text}`);
    if (r.degraded) console.log(`       | ! degraded: ${r.degraded}`);
  }

  console.log(`\n合计 ${CASES.length} 例，改动 ${changed}，不动 ${CASES.length - changed}`);
  console.log("\n--- 主进程日志（前 8 条）---");
  for (const [lv, m, d] of logs.slice(0, 8)) {
    console.log(`  [${lv}] ${m} ${d ? JSON.stringify(d) : ""}`);
  }
  const ruleLog = logs.find(([, m]) => String(m).includes("规则已更新"));
  console.log(
    `\n规则加载: ${ruleLog ? `OK ${JSON.stringify(ruleLog[2])}` : "未见「规则已更新」日志（规则数可能未变化）"}`,
  );

  polisher.dispose();
})();
