const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { spawn, execFileSync } = require("child_process");

const DEFAULT_CODEX_CWD = os.homedir();
const DEFAULT_CODEX_MODEL = "gpt-5.3-codex-spark";
const DEFAULT_TITLE = `CapsWriter Codex Voice - ${DEFAULT_CODEX_MODEL}`;
const DEFAULT_TMUX_SESSION = "capswriter-codex";
const OUTPUT_WATCH_INTERVAL_MS = 800;
const OUTPUT_IDLE_COMPLETE_MS = 6500;
const COMPLETION_SETTLE_MS = 1800;
const FLOATING_PREVIEW_MAX_LINES = 9;
const FLOATING_PREVIEW_MAX_CHARS = 900;
const FLOATING_SUMMARY_MAX_LINES = 4;
const FLOATING_SUMMARY_MAX_CHARS = 360;
const FLOATING_FINAL_BLOCK_MAX_CHARS = 420;
const FALLBACK_COMPLETED_PREVIEW = "Codex 已回到可输入状态。终端里没有提取到可展示的最终回复。";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveExistingDirectory(value, fallback = os.homedir()) {
  const candidates = [value, fallback, os.homedir()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(String(candidate).replace(/^~(?=$|\/)/, os.homedir()));
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch (_) {
      // Try the next candidate.
    }
  }
  return os.homedir();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTmuxName(value, fallback = DEFAULT_TMUX_SESSION) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001bP[\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][0-9A-Za-z]/g, "")
    .replace(/\u001b[=>]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r/g, "\n");
}

function isDividerLine(line) {
  const compact = String(line || "").trim().replace(/\s+/g, "");
  return /^[─━_\-=]{8,}$/.test(compact);
}

function isTerminalNoiseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return true;
  if (/^Script (started|done) on /i.test(trimmed)) return true;
  if (/^Working directory: /i.test(trimmed)) return true;
  if (/^CapsWriter Codex Voice Terminal$/i.test(trimmed)) return true;
  if (/^OpenAI Codex/i.test(trimmed)) return true;
  if (/^(model|directory|permissions):\s+/i.test(trimmed)) return true;
  if (/^Tip:\s+/i.test(trimmed)) return true;
  if (/^Booting MCP server:/i.test(trimmed)) return true;
  if (/^Starting MCP servers/i.test(trimmed)) return true;
  if (/\b(?:Starting|Booting)\s+MCP\b/i.test(trimmed)) return true;
  if (/\bMCP\b/i.test(trimmed) && /\bservers?\b/i.test(trimmed)) return true;
  if ((trimmed.match(/\b(?:Starting|MCP|server|servers?)\b/gi) || []).length >= 3) return true;
  if (/^Working\b/i.test(trimmed)) return true;
  if ((trimmed.match(/Working/gi) || []).length >= 2) return true;
  if (/^\d*H?\d*(?:Working|orking|rking|king|inging|ng){2,}/i.test(trimmed)) return true;
  if (/^gpt-[\w.-]+ .*Context .* left/i.test(trimmed)) return true;
  if (/^Token usage:\s+/i.test(trimmed)) return true;
  if (/^To continue this session, run\s*$/i.test(trimmed)) return true;
  if (/To continue this session, run\s+codex resume/i.test(trimmed)) return true;
  if (/^codex resume\s+/i.test(trimmed)) return true;
  if (/^\d+s\s+•\s+esc to interrupt/i.test(trimmed)) return true;
  if (/^⚠ .*hooks? .*review/i.test(trimmed)) return true;
  if (/^[\d;?]+[A-Za-z]?$/.test(trimmed)) return true;
  if (isDividerLine(trimmed)) return true;
  if (/^(?:q|x|j|k|l|m|n|t|u|v|w|`|a|:|;|\s)+$/i.test(trimmed)) return true;

  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length >= 20) {
    const lowerCompact = compact.toLowerCase();
    const startupFragments = (lowerCompact.match(/starting|start|mcp|servers?|serv|codex|code/g) || []).length;
    if (startupFragments >= 3) return true;
    if (/start(?:ing)?(?:start(?:ing)?){1,}/i.test(compact)) return true;

    const terminalGlyphs = (compact.match(/[qxjklmntuvw`;:]/gi) || []).length;
    if (terminalGlyphs / compact.length > 0.65) return true;
  }

  const coordinateFragments = (trimmed.match(/\b\d{1,3};\d{1,3}[A-Za-z]\b/g) || []).length;
  if (coordinateFragments >= 2) return true;

  return false;
}

function isCommandLikeLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return true;
  if (/^[|>]+\s*/.test(trimmed)) return true;
  if (/^```/.test(trimmed)) return true;
  if (/^Ran\s+/i.test(trimmed)) return true;
  if (/^(?:if|then|else|fi|for|while|do|done|case|esac)\b/.test(trimmed)) return true;
  if (/\b(?:pactl|set-sink-volume|set-sink-mute|get-sink-volume|awk|grep|sed|xargs|sudo|bash|sh|python|node|npm|systemctl|journalctl|curl|ssh|git)\b/.test(trimmed)) {
    return true;
  }
  if (/^\$[\w{]/.test(trimmed)) return true;
  if (/^\w[\w.-]*=.*;/.test(trimmed)) return true;
  if (/\b(?:front-left|front-right|Volume:|Sink #|RUNNING|IDLE)\b/i.test(trimmed)) return true;

  const compact = trimmed.replace(/\s+/g, "");
  const shellChars = (compact.match(/[|;&$`{}[\]\\]/g) || []).length;
  if (compact.length >= 18 && shellChars / compact.length > 0.12) return true;
  return false;
}

function hasReadableSentence(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.length < 3) return false;
  const readable = (trimmed.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length;
  if (readable / Math.max(1, trimmed.length) < 0.35) return false;
  return /[\u4e00-\u9fff]/.test(trimmed) || /\b[A-Za-z]{3,}\b/.test(trimmed);
}

function isMeaningfulPreviewText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if ((text.match(/Working/gi) || []).length >= 2) return false;
  if ((text.match(/\b(?:Starting|MCP|server|servers?)\b/gi) || []).length >= 3) return false;
  if ((text.match(/\b\d{1,3};\d{1,3}[A-Za-z]\b/g) || []).length >= 2) return false;

  const compact = text.replace(/\s+/g, "");
  if (!compact) return false;
  const startupFragments = (compact.toLowerCase().match(/starting|start|mcp|servers?|serv|codex|code/g) || []).length;
  if (compact.length >= 20 && startupFragments >= 3) return false;
  if (/start(?:ing)?(?:start(?:ing)?){1,}/i.test(compact)) return false;

  const terminalGlyphs = (compact.match(/[qxjklmntuvw`;:]/gi) || []).length;
  if (compact.length >= 30 && terminalGlyphs / compact.length > 0.45) return false;

  const letters = (compact.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length;
  return letters / compact.length > 0.25;
}

function isCodexPromptLine(line) {
  return /^›(?:\s|$)/.test(String(line || "").trim());
}

function normalizePreviewText(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?;；:：'"“”‘’`~|\\/\-_=+()[\]{}<>《》【】]/g, "")
    .toLowerCase();
}

function compactFloatingSummary(value) {
  const lines = String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isTerminalNoiseLine(line))
    .filter((line) => !isCodexPromptLine(line))
    .filter((line) => !isCommandLikeLine(line))
    .filter(hasReadableSentence);

  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    const normalized = normalizePreviewText(line);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(line.replace(/^[•*-]\s*/, "• "));
  }

  const preferred = deduped.filter((line) =>
    /^[•*-]\s+/.test(line) ||
    /(?:已|完成|成功|失败|可以|建议|如果|需要|发现|结果|总结|done|complete|completed|success|failed|ready)/i.test(line)
  );
  const selected = (preferred.length ? preferred : deduped).slice(-FLOATING_SUMMARY_MAX_LINES);
  const summary = selected.join("\n").trim();
  if (!summary) return "";
  return summary.length > FLOATING_SUMMARY_MAX_CHARS
    ? `${summary.slice(0, FLOATING_SUMMARY_MAX_CHARS).trim()}...`
    : summary;
}

class CodexTerminalManager extends EventEmitter {
  constructor({ logger = null, dataDirectory = "" } = {}) {
    super();
    this.logger = logger;
    this.requestedCwd = process.env.CODEX_VOICE_CWD || DEFAULT_CODEX_CWD;
    this.cwd = resolveExistingDirectory(this.requestedCwd, DEFAULT_CODEX_CWD);
    this.model = process.env.CODEX_VOICE_MODEL || DEFAULT_CODEX_MODEL;
    this.title = process.env.CODEX_VOICE_TERMINAL_TITLE || DEFAULT_TITLE;
    this.sessionName = normalizeTmuxName(process.env.CODEX_VOICE_TMUX_SESSION || DEFAULT_TMUX_SESSION);
    this.paneTarget = `${this.sessionName}:0.0`;
    this.logPath = process.env.CODEX_VOICE_LOG_PATH || path.join(
      dataDirectory || os.tmpdir(),
      "capswriter-codex-voice.log"
    );
    this.statePath = path.join(dataDirectory || os.tmpdir(), "capswriter-codex-tmux.json");
    this.lastOutput = "";
    this.lastOutputAt = 0;
    this.lastTerminalActivityAt = 0;
    this.lastSubmitAt = 0;
    this.idleTimer = null;
    this.completionTimer = null;
    this.watching = false;
    this.state = "idle";
    this.stateChangedAt = Date.now();
    this.runSeq = 0;
    this.currentRunId = "";
    this.currentPrompt = "";
    this.previewStartOffset = 0;
    this.lastRawText = "";
    this.lastRawSignature = "";
    this.lastCompletedPreview = "";
  }

  start() {
    this._ensureOutputWatcher();
    return true;
  }

  stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
    if (this.watching) {
      fs.unwatchFile(this.logPath);
      this.watching = false;
    }
  }

  getVoiceRouteContext() {
    const lastQuestion = this.lastCompletedPreview || this.lastOutput || "";
    const normalized = String(lastQuestion || "").replace(/\s+/g, "");
    const awaitingFollowup =
      Boolean(normalized) &&
      /[？?]|(?:哪个|哪里|在哪|城市|地点|文件|路径|目录|名字|账号|密码|选择|请提供|需要你|告诉我)/.test(normalized);
    const sessionAlive = this._tmuxSessionExists();
    return {
      awaitingFollowup,
      lastQuestion,
      lastSummary: this.currentPrompt || "",
      state: this.state,
      sessionName: this.sessionName,
      paneTarget: this.paneTarget,
      sessionAlive,
      attachedClientCount: sessionAlive ? this._getAttachedClientCount() : 0,
      windowId: "",
      windowAlive: sessionAlive,
      windowTitle: this.title,
      windowClass: "tmux"
    };
  }

  isCodexVoiceWindow(windowId) {
    return false;
  }

  async cancelActiveTask(reason = "cancelled") {
    if (!this._commandExists("tmux")) {
      return { success: false, cancelled: false, error: "需要安装 tmux 才能取消 Codex Terminal" };
    }
    if (!this._tmuxSessionExists()) {
      return { success: false, cancelled: false, error: "Codex tmux 会话不存在" };
    }
    try {
      await this._runCommand("tmux", ["send-keys", "-t", this.paneTarget, "Escape"], 1500);
      await sleep(250);
      await this._runCommand("tmux", ["send-keys", "-t", this.paneTarget, "C-c"], 1500);
      this._setState("idle");
      this._writeState({ lastCancelAt: Date.now() });
      this._logInfo("Codex tmux interrupt requested", {
        reason,
        sessionName: this.sessionName,
        paneTarget: this.paneTarget
      });
      return {
        success: true,
        cancelled: true,
        sessionName: this.sessionName,
        paneTarget: this.paneTarget
      };
    } catch (error) {
      const message = error?.message || String(error);
      this._logWarn("Failed to interrupt Codex tmux session", { reason, error: message });
      return { success: false, cancelled: false, error: message };
    }
  }

  async submitPrompt(prompt, options = {}) {
    const text = String(prompt || "").trim();
    if (!text) {
      return { success: false, error: "Empty prompt" };
    }

    this._ensureOutputWatcher();
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
    this.runSeq += 1;
    this.currentRunId = `codex-${Date.now().toString(36)}-${this.runSeq}`;
    this._setState("sent");
    this.currentPrompt = text;
    this.lastSubmitAt = Date.now();
    this.lastOutput = "";
    this.lastOutputAt = 0;
    this.lastTerminalActivityAt = 0;
    this.lastRawSignature = "";
    this.lastCompletedPreview = "";
    this.previewStartOffset = this._getLogSize();
    this._emitUpdate({
      phase: "sent",
      message: "正在发送到 Codex Terminal",
      prompt: text,
      preview: ""
    });

    try {
      const launchedSession = await this._ensureTmuxSession();
      const openedVisibleClient = await this._ensureVisibleTmuxClient();
      await this._sendPromptToTmux(text);
      this._setState("running");
      this._writeState({
        lastSubmitAt: this.lastSubmitAt,
        cwd: this.cwd,
        model: this.model
      });
      this._emitUpdate({
        phase: "running",
        message: "已发送到 Codex tmux 会话",
        prompt: text,
        preview: ""
      });
      return {
        success: true,
        launched: launchedSession,
        drafted: false,
        sessionName: this.sessionName,
        paneTarget: this.paneTarget,
        attachedClientCount: this._getAttachedClientCount(),
        openedVisibleClient,
        logPath: this.logPath
      };
    } catch (error) {
      this._setState("error");
      const message = error?.message || String(error);
      this._emitUpdate({
        phase: "error",
        message: `Codex 发送失败：${message}`,
        prompt: text,
        preview: message
      });
      return { success: false, error: message };
    }
  }

  async ensureTerminalWindow() {
    await this._ensureTmuxSession();
    await this._ensureVisibleTmuxClient();
    return this.paneTarget;
  }

  async _ensureTmuxSession() {
    if (!this._commandExists("tmux")) {
      throw new Error("需要安装 tmux 才能在 Wayland 下稳定复用 Codex Terminal");
    }
    this.cwd = resolveExistingDirectory(this.cwd, DEFAULT_CODEX_CWD);
    if (this._tmuxSessionExists()) {
      return false;
    }

    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    const codexCommand = [
      "codex",
      "--cd",
      shellQuote(this.cwd),
      "--model",
      shellQuote(this.model),
      "--no-alt-screen"
    ].join(" ");
    const shellCommand = [
      `cd ${shellQuote(this.cwd)}`,
      `echo 'CapsWriter Codex Voice Terminal'`,
      `echo 'Working directory: ${this.cwd}'`,
      `script -q -f ${shellQuote(this.logPath)} -c ${shellQuote(codexCommand)}`
    ].join("; ");

    await this._runCommand("tmux", [
      "new-session",
      "-d",
      "-s",
      this.sessionName,
      "-c",
      this.cwd,
      "bash",
      "-lc",
      shellCommand
    ], 4000);
    this._writeState({ launchedAt: Date.now(), cwd: this.cwd, model: this.model });
    this._logInfo("Codex tmux session launched", {
      sessionName: this.sessionName,
      paneTarget: this.paneTarget,
      cwd: this.cwd,
      model: this.model,
      logPath: this.logPath
    });
    await sleep(600);
    return true;
  }

  async _ensureVisibleTmuxClient() {
    if (this._getAttachedClientCount() > 0) {
      return false;
    }

    const terminal = this._resolveTerminalClient();
    const child = spawn(terminal.command, terminal.args, {
      detached: true,
      stdio: "ignore",
      cwd: this.cwd,
      env: process.env
    });
    child.unref();
    this._logInfo("Codex tmux visible client launched", {
      command: terminal.command,
      args: terminal.args,
      sessionName: this.sessionName
    });
    await sleep(500);
    return true;
  }

  async _sendPromptToTmux(prompt) {
    const bufferName = `${this.sessionName}-prompt`;
    await this._runCommandWithInput("tmux", ["load-buffer", "-b", bufferName, "-"], prompt, 2500);
    await this._runCommand("tmux", ["paste-buffer", "-d", "-b", bufferName, "-t", this.paneTarget], 2500);
    await sleep(80);
    await this._runCommand("tmux", ["send-keys", "-t", this.paneTarget, "Enter"], 1500);
  }

  _tmuxSessionExists() {
    if (!this._commandExists("tmux")) {
      return false;
    }
    try {
      execFileSync("tmux", ["has-session", "-t", this.sessionName], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 1000
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  _getAttachedClientCount() {
    if (!this._commandExists("tmux") || !this._tmuxSessionExists()) {
      return 0;
    }
    try {
      const output = execFileSync("tmux", ["list-clients", "-t", this.sessionName], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"]
      });
      return output.split("\n").map((line) => line.trim()).filter(Boolean).length;
    } catch (_) {
      return 0;
    }
  }

  _resolveTerminalClient() {
    const attachCommand = `tmux attach-session -t ${shellQuote(this.sessionName)}`;
    if (this._commandExists("ptyxis")) {
      return {
        command: "ptyxis",
        args: [
          "--new-window",
          "--working-directory",
          this.cwd,
          "--title",
          this.title,
          "--",
          "bash",
          "-lc",
          attachCommand
        ]
      };
    }
    if (this._commandExists("gnome-terminal")) {
      return {
        command: "gnome-terminal",
        args: ["--title", this.title, "--working-directory", this.cwd, "--", "bash", "-lc", attachCommand]
      };
    }
    if (this._commandExists("kgx")) {
      return {
        command: "kgx",
        args: ["--working-directory", this.cwd, "--title", this.title, "--", "bash", "-lc", attachCommand]
      };
    }
    if (this._commandExists("xterm")) {
      return {
        command: "xterm",
        args: ["-T", this.title, "-e", "bash", "-lc", attachCommand]
      };
    }
    throw new Error("未找到可用 terminal（需要 ptyxis、gnome-terminal、kgx 或 xterm）");
  }

  _ensureOutputWatcher() {
    if (this.watching) return;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    if (!fs.existsSync(this.logPath)) {
      fs.writeFileSync(this.logPath, "", "utf8");
    }
    fs.watchFile(this.logPath, { interval: OUTPUT_WATCH_INTERVAL_MS }, () => {
      this._readOutputPreview();
    });
    this.watching = true;
    this._readOutputPreview();
  }

  _readOutputPreview() {
    let stat = null;
    try {
      stat = fs.statSync(this.logPath);
    } catch (_) {
      return;
    }
    if (!stat || stat.size <= 0) return;

    const fd = fs.openSync(this.logPath, "r");
    try {
      const startOffset = Math.max(0, Math.min(this.previewStartOffset, stat.size));
      const availableLength = stat.size - startOffset;
      const length = Math.min(availableLength, 24000);
      if (length <= 0) return;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, Math.max(startOffset, stat.size - length));
      const rawText = buffer.toString("utf8");
      this.lastRawText = rawText;
      this._recordRawActivity(rawText);
      const preview = this._buildPreview(rawText);
      if (this.state === "completed") {
        return;
      }
      if (this._hasReturnedToPrompt(rawText)) {
        if (preview && preview !== this.lastOutput) {
          this.lastOutput = preview;
          this.lastOutputAt = Date.now();
        }
        this._scheduleSettledCompletion();
        return;
      }
      if (!preview || preview === this.lastOutput) return;

      this.lastOutput = preview;
      this.lastOutputAt = Date.now();
      if (this.state === "running" || this.state === "sent") {
        this._emitUpdate({
          phase: "running",
          message: "Codex 正在执行",
          preview: ""
        });
        this._scheduleIdleCompletion();
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  _buildPreview(rawText) {
    const cleaned = stripAnsi(rawText)
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => !isTerminalNoiseLine(line))
      .filter((line) => !isCodexPromptLine(line))
      .filter((line) => !this._isPromptEchoLine(line))
      .filter((line) => !isCommandLikeLine(line));

    return cleaned
      .slice(-FLOATING_PREVIEW_MAX_LINES)
      .join("\n")
      .slice(-FLOATING_PREVIEW_MAX_CHARS);
  }

  _buildFinalBlockPreview(rawText) {
    const lines = stripAnsi(rawText)
      .split("\n")
      .map((line) => line.trimEnd());

    const dividerIndices = [];
    lines.forEach((line, index) => {
      if (isDividerLine(line)) {
        dividerIndices.push(index);
      }
    });

    const candidateBlocks = [];
    if (dividerIndices.length > 0) {
      dividerIndices.forEach((dividerIndex, index) => {
        const nextDividerIndex = dividerIndices[index + 1] ?? lines.length;
        candidateBlocks.push(lines.slice(dividerIndex + 1, nextDividerIndex));
      });
    } else {
      candidateBlocks.push(lines);
    }

    for (let index = candidateBlocks.length - 1; index >= 0; index -= 1) {
      const block = this._sanitizeFinalBlockLines(candidateBlocks[index]).join("\n").trim();
      if (isMeaningfulPreviewText(block)) {
        return block.length > FLOATING_FINAL_BLOCK_MAX_CHARS
          ? `${block.slice(0, FLOATING_FINAL_BLOCK_MAX_CHARS).trim()}...`
          : block;
      }
    }

    return "";
  }

  _sanitizeFinalBlockLines(lines) {
    const result = [];
    const seen = new Set();
    for (const line of lines || []) {
      const trimmed = String(line || "").trim();
      if (!trimmed) continue;
      if (isCodexPromptLine(trimmed)) break;
      if (isDividerLine(trimmed)) continue;
      if (isTerminalNoiseLine(trimmed)) continue;
      if (this._isPromptEchoLine(trimmed)) continue;
      if (isCommandLikeLine(trimmed)) continue;
      if (!hasReadableSentence(trimmed)) continue;

      const normalized = normalizePreviewText(trimmed);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(trimmed);
    }
    return result.slice(-FLOATING_SUMMARY_MAX_LINES);
  }

  _recordRawActivity(rawText) {
    const signature = `${String(rawText || "").length}:${String(rawText || "").slice(-240)}`;
    if (!signature || signature === this.lastRawSignature) return;
    this.lastRawSignature = signature;
    this.lastTerminalActivityAt = Date.now();
  }

  _hasReturnedToPrompt(rawText) {
    if (this.state !== "running" || !this.currentPrompt) {
      return false;
    }

    const lines = stripAnsi(rawText)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isTerminalNoiseLine(line));
    const promptIndices = [];
    lines.forEach((line, index) => {
      if (isCodexPromptLine(line)) {
        promptIndices.push(index);
      }
    });

    if (promptIndices.length < 2) {
      return false;
    }

    const firstPromptIndex = promptIndices[0];
    const lastPromptIndex = promptIndices[promptIndices.length - 1];
    if (lastPromptIndex <= firstPromptIndex) {
      return false;
    }

    return true;
  }

  _isPromptEchoLine(line) {
    if (!this.currentPrompt) return false;
    const normalizedLine = normalizePreviewText(line);
    const normalizedPrompt = normalizePreviewText(this.currentPrompt);
    if (!normalizedLine || !normalizedPrompt) return false;
    if (normalizedLine.length < 8) return false;
    return normalizedPrompt.includes(normalizedLine) || normalizedLine.includes(normalizedPrompt.slice(0, 24));
  }

  _getLogSize() {
    try {
      return fs.statSync(this.logPath).size || 0;
    } catch (_) {
      return 0;
    }
  }

  _scheduleIdleCompletion() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (this.state !== "running") return;
      if (!this.lastOutputAt || this.lastOutputAt < this.lastSubmitAt) {
        this._scheduleIdleCompletion();
        return;
      }
      const idleMs = Date.now() - this.lastOutputAt;
      if (idleMs < OUTPUT_IDLE_COMPLETE_MS) {
        this._scheduleIdleCompletion();
        return;
      }
      this._markCompleted(this.lastOutput, this.lastRawText);
    }, OUTPUT_IDLE_COMPLETE_MS);
  }

  _scheduleSettledCompletion() {
    if (this.state !== "running") return;
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
    }
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null;
      if (this.state !== "running") return;
      this._markCompleted(this.lastOutput, this.lastRawText);
    }, COMPLETION_SETTLE_MS);
  }

  _markCompleted(preview, rawText = "") {
    if (this.state !== "running") return;
    const cleanPreview = this._buildCompletionPreview(preview, rawText) || FALLBACK_COMPLETED_PREVIEW;
    this._setState("completed");
    this.lastCompletedPreview = cleanPreview;
    this._emitUpdate({
      phase: "completed",
      message: "Codex 任务已完成",
      preview: cleanPreview
    });
  }

  _buildCompletionPreview(preview, rawText = "") {
    const finalBlock = this._buildFinalBlockPreview(rawText || this.lastRawText || "");
    if (isMeaningfulPreviewText(finalBlock)) {
      return finalBlock;
    }

    const fallbackSummary = compactFloatingSummary(preview);
    return isMeaningfulPreviewText(fallbackSummary) ? fallbackSummary : "";
  }

  _setState(nextState) {
    if (this.state === nextState) return;
    this.state = nextState;
    this.stateChangedAt = Date.now();
  }

  _emitUpdate(payload) {
    this.emit("update", {
      success: payload.phase !== "error",
      phase: payload.phase || "idle",
      runId: this.currentRunId,
      state: this.state,
      stateChangedAt: this.stateChangedAt,
      message: payload.message || "",
      prompt: payload.prompt || "",
      preview: payload.preview || "",
      cwd: this.cwd,
      model: this.model,
      title: this.title,
      logPath: this.logPath,
      ts: Date.now()
    });
  }

  _commandExists(command) {
    try {
      execFileSync("bash", ["-lc", `command -v ${shellQuote(command)}`], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 1000
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  _runCommand(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${command} timed out`));
      }, timeoutMs);

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(true);
          return;
        }
        reject(new Error(`${command} failed (${code}): ${stderr.trim()}`));
      });
    });
  }

  _runCommandWithInput(command, args, input, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${command} timed out`));
      }, timeoutMs);

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(true);
          return;
        }
        reject(new Error(`${command} failed (${code}): ${stderr.trim()}`));
      });
      child.stdin.end(input);
    });
  }

  _writeState(extra = {}) {
    const payload = {
      sessionName: this.sessionName,
      paneTarget: this.paneTarget,
      cwd: this.cwd,
      model: this.model,
      title: this.title,
      logPath: this.logPath,
      updatedAt: Date.now(),
      ...extra
    };
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(payload, null, 2), "utf8");
    } catch (_) {
      // best-effort diagnostic state
    }
  }

  _logInfo(message, data = null) {
    if (this.logger?.info) {
      this.logger.info(message, data || undefined);
    }
  }

  _logWarn(message, data = null) {
    if (this.logger?.warn) {
      this.logger.warn(message, data || undefined);
    }
  }
}

module.exports = CodexTerminalManager;
