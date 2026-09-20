/**
 * 转写文本整理编排（主进程侧）
 *
 * 链路：腾讯 ASR 原文 → 自定义规则替换(hot-rule.txt) → [可选]标点恢复 → 最终文本
 *
 * 设计原则（对应接入方案的保守约束）：
 *   - 任一阶段异常都返回上一阶段通过校验的文本，绝不把文本弄丢。
 *   - 规则替换是同步的、毫秒级，默认开启，不构成延迟负担。
 *   - 标点恢复走独立 Python 进程，默认关闭；关闭时不启动进程、不占用显存/内存。
 *   - 返回修改记录与各阶段耗时，便于定位效果和回退。
 */

const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const fs = require("fs");
const { HotRuleReplacer } = require("../../helpers/hotRuleReplace");

const DEFAULT_PYTHON = process.env.CAPS_PUNC_PYTHON || "";
// __dirname = src/platform/electron，需上溯三级才到项目根（打包后即 app.asar 根）
const PROJECT_ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_SERVER = path.join(PROJECT_ROOT, "services", "text-postprocess", "punc_server.py");
const BUNDLED_RULE_FILE = path.join(PROJECT_ROOT, "assets", "hot-rule.txt");
const REQUEST_TIMEOUT_MS = 3000;
const RULE_FILE_NAME = "hot-rule.txt";

/**
 * 决定规则文件来源，优先级从高到低：
 *   1. 环境变量 CAPS_HOT_RULE_FILE（调试/临时覆盖）
 *   2. 用户数据目录 ~/.config/语音转写/hot-rule.txt（用户日常维护的位置）
 *   3. 旧 CapsWriter 安装目录（向后兼容，用户可能还在那里改）
 *   4. 随包内置的 assets/hot-rule.txt
 * 若 2 不存在而 3/4 存在，会把找到的那份复制到 2，让用户只需维护一处。
 */
function resolveRulePath(dataDirectory, fsImpl) {
  const override = process.env.CAPS_HOT_RULE_FILE;
  if (override) return override;

  const userPath = dataDirectory ? path.join(dataDirectory, RULE_FILE_NAME) : "";
  const legacyPaths = [
    path.join(os.homedir(), "github", "CapsWriter-Offline-Windows-64bit", RULE_FILE_NAME),
  ];

  if (userPath && fsImpl.existsSync(userPath)) return userPath;

  const source = [...legacyPaths, BUNDLED_RULE_FILE].find((p) => {
    try {
      return fsImpl.existsSync(p);
    } catch {
      return false;
    }
  });

  if (source && userPath) {
    try {
      fsImpl.copyFileSync(source, userPath);
      return userPath;
    } catch {
      // 复制失败不影响使用，退回读源文件
    }
  }
  return source || userPath;
}

class TextPolisher {
  constructor({ dataDirectory, logger = null, longFormatter = null } = {}) {
    this.logger = logger;
    // 长文本整理器（可选）：去口水词 + 分段。没注入时阶段三整体跳过。
    this.longFormatter = longFormatter;
    this.rulePath = resolveRulePath(dataDirectory, fs);
    this.replacer = new HotRuleReplacer({
      filePath: this.rulePath,
      fs,
      logger,
    });
    this.child = null;
    this.ready = false;
    this.seq = 0;
    this.pending = new Map();
    this.starting = null;
    // 用于在规则条数变化时打一条日志，便于确认用户改完 hot-rule.txt 已生效
    this.lastRuleCount = 0;
  }

  /** 载入规则文件；返回规则条数。 */
  loadRules() {
    try {
      return this.replacer.loadFromFile();
    } catch (error) {
      this.logger?.warn("加载自定义替换规则失败", { error: error?.message || String(error) });
      return 0;
    }
  }

  /**
   * 整理文本。options: { hotRule:boolean, punctuation:'off'|'full' }
   * 返回 { text, changed, stages, ruleCount, degraded }
   */
  async polish(rawText, options = {}) {
    const started = Date.now();
    const useHotRule = options.hotRule !== false;
    const puncMode = options.punctuation === "full" ? "full" : "off";

    const result = {
      text: rawText || "",
      changed: false,
      stages: [],
      ruleCount: 0,
      degraded: null,
    };

    if (typeof rawText !== "string" || !rawText.trim()) {
      return result;
    }

    let current = rawText;

    // 阶段一：自定义规则替换（hot-rule.txt）
    if (useHotRule) {
      const stageStart = Date.now();
      // 每次都走 loadRules：内部按 mtime 判断是否需要重新读盘，未变时只多一次
      // statSync。这样用户改完 hot-rule.txt 无需重启客户端，下一次转写即生效。
      const count = this.loadRules();
      if (count !== this.lastRuleCount) {
        this.logger?.info("自定义替换规则已更新", { count, previous: this.lastRuleCount });
        this.lastRuleCount = count;
      }
      result.ruleCount = count;
      if (count > 0) {
        const applied = this.replacer.apply(current);
        if (applied.text !== current) {
          result.stages.push({
            stage: "hot_rule",
            elapsed_ms: Date.now() - stageStart,
            applied_rules: applied.applied.length,
          });
          current = applied.text;
        }
        if (applied.error) {
          result.degraded = `hot_rule:${applied.error}`;
        }
      }
    }

    // 阶段二：标点恢复（默认关闭；关闭时零开销）
    if (puncMode === "full") {
      const stageStart = Date.now();
      try {
        const puncResult = await this.requestPunctuation(current);
        if (puncResult.ok) {
          if (puncResult.text !== current) {
            result.stages.push({ stage: "punctuation", elapsed_ms: Date.now() - stageStart });
            current = puncResult.text;
          }
        } else {
          // 失败保留上一阶段文本，记录原因，不算成功整理
          result.degraded = `punctuation:${puncResult.error || "failed"}`;
        }
      } catch (error) {
        result.degraded = `punctuation:${error?.message || String(error)}`;
      }
    }

    // 阶段三：长文本整理（默认关；需要显式传 longFormat.enabled）
    // 放在最后，因为它会引入换行——必须建立在已规范化的文本之上。
    const longFormat = options.longFormat || null;
    if (longFormat?.enabled && this.longFormatter) {
      const decision = this.shouldRunLongFormat(current, longFormat);
      if (decision.run) {
        const stageStart = Date.now();
        try {
          const applied = await this.longFormatter.format(current);
          if (applied.changed) {
            result.stages.push({
              stage: "long_format",
              elapsed_ms: Date.now() - stageStart,
              ratio: applied.ratio,
            });
            current = applied.text;
          }
          if (applied.degraded) {
            result.degraded = `long_format:${applied.degraded}`;
          }
        } catch (error) {
          // 整理失败绝不影响已完成的阶段一/二
          result.degraded = `long_format:${error?.message || String(error)}`;
          this.logger?.warn("长文本整理异常，保留前序结果", {
            error: error?.message || String(error),
          });
        }
      }
    }

    result.text = current;
    result.changed = current !== rawText;
    result.total_ms = Date.now() - started;
    return result;
  }

  /**
   * 决定是否值得为这段文本做长文本整理。
   *
   * 三道否决：
   *   - 终端场景：整理会插换行，而终端里换行 = 回车执行命令，必须避让
   *   - 窗口未知：读不到目标窗口信息时**也必须跳过**。整理是危险动作，
   *     判不出来就不能做——宁可这次不排版，也不能赌它不是终端。
   *     （2026-09-20 端到端回放发现原来的实现是反的：读不到窗口照样排版）
   *   - 太短：一两句话不需要分段，白等一次推理
   *
   * isTerminal 是三态：true=是终端，false=确认不是终端，null/undefined=未知。
   * 只有明确为 false 才整理。
   */
  shouldRunLongFormat(text, { minChars = 40, isTerminal = null } = {}) {
    if (isTerminal === true) return { run: false, reason: "terminal" };
    if (isTerminal !== false) return { run: false, reason: "unknown_window" };
    const contentChars = String(text || "").replace(/[\s\p{P}\p{S}]/gu, "").length;
    if (contentChars < minChars) return { run: false, reason: "below_min_chars" };
    return { run: true, reason: null, contentChars };
  }

  ensureChild() {
    if (this.child && !this.child.killed) return Promise.resolve(this.ready);
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve) => {
      const python = DEFAULT_PYTHON || this.findPython();
      if (!python) {
        this.logger?.warn("未找到可用的 Python，标点恢复不可用");
        this.starting = null;
        resolve(false);
        return;
      }
      try {
        const child = spawn(python, [DEFAULT_SERVER], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        });
        this.child = child;

        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let index;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            try {
              this.onMessage(JSON.parse(line));
            } catch {
              // 忽略无法解析的行
            }
          }
        });
        child.stderr.on("data", (chunk) => {
          const text = chunk.toString("utf8").trim();
          if (text) this.logger?.debug("punc stderr", { line: text.slice(0, 300) });
        });
        child.on("exit", () => {
          this.child = null;
          this.ready = false;
          // 进程若未能就绪就退出（如脚本路径错误），必须放行等待者，否则请求永久挂起
          if (this.readyResolver) {
            this.readyResolver(false);
            this.readyResolver = null;
          }
          this.starting = null;
          this.rejectAll("punc_process_exited");
        });
        child.on("error", (error) => {
          this.logger?.warn("标点服务启动失败", { error: error?.message });
          this.child = null;
          this.ready = false;
          resolve(false);
        });

        this.readyResolver = resolve;
      } catch (error) {
        this.logger?.warn("标点服务启动异常", { error: error?.message });
        this.starting = null;
        resolve(false);
      }
    });
    return this.starting;
  }

  onMessage(message) {
    if (message?.type === "ready") {
      this.ready = true;
      this.logger?.info("标点服务已就绪", { elapsed_ms: message.elapsed_ms });
      if (this.readyResolver) {
        this.readyResolver(true);
        this.readyResolver = null;
      }
      return;
    }
    const id = message?.id;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve({
      ok: message?.ok === true,
      text: message?.text ?? entry.text,
      error: message?.error || null,
      elapsed_ms: message?.elapsed_ms || 0,
    });
  }

  rejectAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, text: entry.text, error: reason });
    }
    this.pending.clear();
  }

  async requestPunctuation(text) {
    const ready = await this.ensureChild();
    if (!ready || !this.child) {
      return { ok: false, text, error: "punc_unavailable" };
    }
    const id = (this.seq += 1);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, text, error: "punc_timeout" });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer, text });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, text, mode: "full" })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, text, error: error?.message || "punc_write_failed" });
      }
    });
  }

  findPython() {
    // 约定：标点服务的独立环境由 CAPS_PUNC_PYTHON 指定，避免污染其他环境
    const candidates = [
      DEFAULT_PYTHON,
      "/home/ivan/.workbuddy/binaries/python/envs/caps-punc/bin/python3",
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // 继续尝试下一个
      }
    }
    return "";
  }

  dispose() {
    if (this.child && !this.child.killed) {
      this.child.kill();
      this.child = null;
    }
    this.ready = false;
    this.pending.clear();
  }
}

module.exports = { TextPolisher };
