const { clipboard } = require("electron");
const { spawn, execSync } = require("child_process");

const PASTE_METHOD_SETTING_KEY = "clipboard_paste_method_map";
const LINUX_PASTE_METHOD = {
  CTRL_SHIFT_V: "ctrl_shift_v",
  SHIFT_INSERT: "shift_insert",
  CTRL_V: "ctrl_v",
};
const LINUX_TARGET_ACTIVATION_SETTLE_MS = 80;
const LINUX_CLIPBOARD_SETTLE_MS = 60;
const LINUX_PASTE_COMMAND_TIMEOUT_MS = 1800;
const LINUX_YDOTOOL_KEY_DELAY_MS = 25;
const LINUX_XDOTOOL_KEY_DELAY_MS = 35;
const LINUX_PASTE_AFTER_KEY_SETTLE_MS = 80;
const LINUX_CLIPBOARD_RESTORE_DELAY_MS = 1200;

class ClipboardManager {
  constructor(logger) {
    // 初始化剪贴板管理器
    this.logger = logger;
    this.targetWindowId = null;
    this.databaseManager = null;
    this.pasteMethodMap = {};
    
    // 尝试加载 osascript 模块（仅在 macOS 上）
    this.osascript = null;
    if (process.platform === "darwin") {
      try {
        this.osascript = require("osascript");
        this.safeLog("✅ osascript 模块加载成功");
      } catch (error) {
        this.safeLog("⚠️ osascript 模块加载失败，将使用备用方法", error.message);
      }
    }
  }

  setDatabaseManager(databaseManager) {
    this.databaseManager = databaseManager || null;
    this.loadPasteMethodMap();
  }

  loadPasteMethodMap() {
    if (!this.databaseManager || !this.databaseManager.getSetting) {
      return;
    }
    try {
      const storedMap = this.databaseManager.getSetting(PASTE_METHOD_SETTING_KEY, {});
      if (storedMap && typeof storedMap === "object" && !Array.isArray(storedMap)) {
        this.pasteMethodMap = storedMap;
      }
      this.safeLog("🧠 粘贴方式映射已加载", {
        mapSize: Object.keys(this.pasteMethodMap).length,
      });
    } catch (error) {
      this.safeLog("⚠️ 读取粘贴方式映射失败", error.message);
    }
  }

  savePasteMethodMap() {
    if (!this.databaseManager || !this.databaseManager.setSetting) {
      return;
    }
    try {
      this.databaseManager.setSetting(PASTE_METHOD_SETTING_KEY, this.pasteMethodMap);
    } catch (error) {
      this.safeLog("⚠️ 保存粘贴方式映射失败", error.message);
    }
  }

  // 设置目标窗口 ID (Linux 用)
  setTargetWindow(windowId) {
    this.targetWindowId = windowId;
    this.safeLog("🎯 设置目标窗口:", windowId);
  }

  createTraceId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  normalizeWindowClass(windowClass) {
    return String(windowClass || "").trim().toLowerCase();
  }

  methodToKeyCombo(method) {
    switch (method) {
      case LINUX_PASTE_METHOD.SHIFT_INSERT:
        return "Shift+Insert";
      case LINUX_PASTE_METHOD.CTRL_V:
        return "ctrl+v";
      case LINUX_PASTE_METHOD.CTRL_SHIFT_V:
      default:
        return "ctrl+shift+v";
    }
  }

  uniqueMethods(methods) {
    return Array.from(new Set(methods.filter(Boolean)));
  }

  isLinuxRemoteWindow(windowClass, windowTitle) {
    const normalizedClass = this.normalizeWindowClass(windowClass);
    const normalizedTitle = String(windowTitle || "").toLowerCase();

    return (
      /(remmina|virt-viewer|vmware|virtualbox|java|jetbrains-client)/.test(normalizedClass) ||
      /(remote|vnc|rdp)/.test(normalizedTitle)
    );
  }

  isLinuxWeChatWindow(windowClass, windowTitle) {
    const normalizedClass = this.normalizeWindowClass(windowClass);
    const normalizedTitle = String(windowTitle || "").toLowerCase();

    return (
      /(wechat|weixin)/.test(normalizedClass) ||
      /(wechat|weixin|微信)/.test(normalizedTitle)
    );
  }

  chooseLinuxPasteMethods(windowClass, windowTitle) {
    const normalizedClass = this.normalizeWindowClass(windowClass);
    const normalizedTitle = String(windowTitle || "").toLowerCase();
    const isRemminaWindow = /remmina/.test(normalizedClass);
    const isWeChatWindow = this.isLinuxWeChatWindow(normalizedClass, normalizedTitle);
    const isTerminalWindow =
      /(gnome-terminal|ptyxis|kgx|konsole|xterm|alacritty|kitty|wezterm|terminator|tilix)/.test(normalizedClass) ||
      /(terminal|shell|bash|zsh)/.test(normalizedTitle);
    const isCompatRemoteWindow = this.isLinuxRemoteWindow(normalizedClass, normalizedTitle);
    const isUnknownWindow = !normalizedClass && !normalizedTitle;
    const cached = isUnknownWindow ? "" : this.pasteMethodMap[normalizedClass];
    const cachedMethod = (
      cached === LINUX_PASTE_METHOD.CTRL_V ||
      cached === "ydotool_ctrl_v"
    ) ? "" : cached;

    let preferredMethod = cachedMethod;
    let source = cachedMethod ? "cache" : "rule";

    // Remmina 已验证使用 Ctrl+Shift+V，旧缓存不应覆盖该规则。
    if (isRemminaWindow) {
      preferredMethod = LINUX_PASTE_METHOD.CTRL_SHIFT_V;
      source = "remmina_rule";
    } else if (isWeChatWindow) {
      preferredMethod = LINUX_PASTE_METHOD.SHIFT_INSERT;
      source = "wechat_rule";
    } else if (!preferredMethod) {
      if (isTerminalWindow) {
        preferredMethod = LINUX_PASTE_METHOD.CTRL_SHIFT_V;
        source = "terminal_rule";
      } else if (isUnknownWindow) {
        preferredMethod = LINUX_PASTE_METHOD.SHIFT_INSERT;
        source = "unknown_window_rule";
      } else if (isCompatRemoteWindow) {
        preferredMethod = LINUX_PASTE_METHOD.SHIFT_INSERT;
        source = "compat_rule";
      } else {
        preferredMethod = LINUX_PASTE_METHOD.SHIFT_INSERT;
        source = "default_rule";
      }
    }

    const fallbackOrder = isRemminaWindow
      ? [
          preferredMethod,
          LINUX_PASTE_METHOD.CTRL_V,
          LINUX_PASTE_METHOD.SHIFT_INSERT,
        ]
      : isWeChatWindow || isUnknownWindow
        ? [
            preferredMethod,
            LINUX_PASTE_METHOD.CTRL_SHIFT_V,
            LINUX_PASTE_METHOD.CTRL_V,
          ]
      : [
          preferredMethod,
          LINUX_PASTE_METHOD.SHIFT_INSERT,
          LINUX_PASTE_METHOD.CTRL_SHIFT_V,
          LINUX_PASTE_METHOD.CTRL_V,
        ];

    return {
      preferredMethod,
      source,
      sequence: this.uniqueMethods(fallbackOrder),
    };
  }

  async spawnWithResult(command, args, timeoutMs = 2500) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeoutId = null;

      let proc = null;
      try {
        proc = spawn(command, args);
      } catch (error) {
        resolve({
          ok: false,
          code: -1,
          stdout: "",
          stderr: error.message,
          timeout: false,
        });
        return;
      }

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolve(result);
      };

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("error", (error) => {
        finish({
          ok: false,
          code: -1,
          stdout,
          stderr: `${stderr}\n${error.message}`.trim(),
          timeout: false,
        });
      });
      proc.on("close", (code) => {
        finish({
          ok: code === 0,
          code,
          stdout,
          stderr,
          timeout: false,
        });
      });

      timeoutId = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch (_) {
          // Ignore kill errors for already-exited processes.
        }
        finish({
          ok: false,
          code: -1,
          stdout,
          stderr: `${stderr}\ncommand timeout`.trim(),
          timeout: true,
        });
      }, timeoutMs);
    });
  }

  async spawnWithInput(command, args, input, timeoutMs = 2500) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeoutId = null;

      let proc = null;
      try {
        proc = spawn(command, args);
      } catch (error) {
        resolve({
          ok: false,
          code: -1,
          stdout: "",
          stderr: error.message,
          timeout: false,
        });
        return;
      }

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolve(result);
      };

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("error", (error) => {
        finish({
          ok: false,
          code: -1,
          stdout,
          stderr: `${stderr}\n${error.message}`.trim(),
          timeout: false,
        });
      });
      proc.on("close", (code) => {
        finish({
          ok: code === 0,
          code,
          stdout,
          stderr,
          timeout: false,
        });
      });

      timeoutId = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch (_) {
          // Ignore kill errors for already-exited processes.
        }
        finish({
          ok: false,
          code: -1,
          stdout,
          stderr: `${stderr}\ncommand timeout`.trim(),
          timeout: true,
        });
      }, timeoutMs);

      proc.stdin.end(input);
    });
  }

  getYdotoolKeySequence(method) {
    switch (method) {
      case LINUX_PASTE_METHOD.CTRL_SHIFT_V:
        return ["29:1", "42:1", "47:1", "47:0", "42:0", "29:0"];
      case LINUX_PASTE_METHOD.SHIFT_INSERT:
        return ["42:1", "110:1", "110:0", "42:0"];
      case LINUX_PASTE_METHOD.CTRL_V:
        return ["29:1", "47:1", "47:0", "29:0"];
      default:
        return null;
    }
  }

  getWtypeKeySequence(method) {
    switch (method) {
      case LINUX_PASTE_METHOD.CTRL_SHIFT_V:
        return ["-M", "ctrl", "-M", "shift", "v", "-m", "shift", "-m", "ctrl"];
      case LINUX_PASTE_METHOD.SHIFT_INSERT:
        return ["-M", "shift", "Insert", "-m", "shift"];
      case LINUX_PASTE_METHOD.CTRL_V:
        return ["-M", "ctrl", "v", "-m", "ctrl"];
      default:
        return null;
    }
  }

  isWaylandSession() {
    return process.platform === "linux"
      && String(process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland";
  }

  async runLinuxPasteCommand(method, keyCombo) {
    const fallbackErrors = [];
    const wtypeKeys = this.getWtypeKeySequence(method);
    if (this.isWaylandSession() && wtypeKeys) {
      const wtypeResult = await this.spawnWithResult(
        "wtype",
        wtypeKeys,
        LINUX_PASTE_COMMAND_TIMEOUT_MS
      );
      if (wtypeResult.ok) {
        return {
          ...wtypeResult,
          backend: "wtype",
        };
      }
      fallbackErrors.push(`wtype: ${wtypeResult.stderr}`);
    }

    const ydotoolKeys = this.getYdotoolKeySequence(method);
    if (ydotoolKeys) {
      const ydotoolResult = await this.spawnWithResult(
        "ydotool",
        ["key", "--key-delay", String(LINUX_YDOTOOL_KEY_DELAY_MS), ...ydotoolKeys],
        LINUX_PASTE_COMMAND_TIMEOUT_MS
      );
      if (ydotoolResult.ok) {
        return {
          ...ydotoolResult,
          backend: "ydotool",
          fallbackError: fallbackErrors.join("; "),
        };
      }

      fallbackErrors.push(`ydotool: ${ydotoolResult.stderr}`);

      const xdotoolResult = await this.spawnWithResult(
        "xdotool",
        ["key", "--delay", String(LINUX_XDOTOOL_KEY_DELAY_MS), keyCombo],
        LINUX_PASTE_COMMAND_TIMEOUT_MS
      );
      return {
        ...xdotoolResult,
        backend: "xdotool",
        fallbackFrom: this.isWaylandSession() ? "wtype,ydotool" : "ydotool",
        fallbackError: fallbackErrors.join("; "),
      };
    }

    const xdotoolResult = await this.spawnWithResult(
      "xdotool",
      ["key", "--delay", String(LINUX_XDOTOOL_KEY_DELAY_MS), keyCombo],
      LINUX_PASTE_COMMAND_TIMEOUT_MS
    );
    return {
      ...xdotoolResult,
      backend: "xdotool",
      fallbackFrom: this.isWaylandSession() ? "wtype" : "",
      fallbackError: fallbackErrors.join("; "),
    };
  }

  async writeLinuxPrimarySelection(text) {
    if (process.platform !== "linux") {
      return;
    }

    const result = await this.spawnWithInput(
      "wl-copy",
      ["--primary"],
      String(text || ""),
      150
    );
    this.safeLog("📌 Linux PRIMARY selection 写入结果", {
      ok: result.ok,
      code: result.code,
      timeout: result.timeout,
      stderr: result.stderr,
    });
  }

  getLinuxWindowMeta(windowId) {
    const fallback = {
      windowId: String(windowId || "").trim(),
      windowClass: "",
      windowTitle: "",
    };

    if (!windowId) return fallback;

    try {
      const output = execSync(
        `xprop -id ${windowId} WM_CLASS _NET_WM_NAME 2>/dev/null`,
        { encoding: "utf-8" }
      );
      const classMatch = output.match(/WM_CLASS\([^)]*\)\s*=\s*(.+)/);
      const titleMatch = output.match(/_NET_WM_NAME\([^)]*\)\s*=\s*(.+)/);

      const parseQuotedText = (raw = "") => {
        const parts = raw.match(/"([^"]*)"/g) || [];
        return parts.map((p) => p.replace(/^"|"$/g, "")).filter(Boolean).join(" ");
      };

      return {
        windowId: String(windowId).trim(),
        windowClass: parseQuotedText(classMatch ? classMatch[1] : ""),
        windowTitle: parseQuotedText(titleMatch ? titleMatch[1] : ""),
      };
    } catch (error) {
      this.safeLog("⚠️ 读取窗口元信息失败", {
        windowId: String(windowId),
        error: error.message,
      });
      return fallback;
    }
  }

  rememberLinuxPasteMethod(windowClass, method) {
    const key = this.normalizeWindowClass(windowClass);
    if (!key || !method) return;
    this.pasteMethodMap[key] = method;
    this.savePasteMethodMap();
  }

  // 安全日志方法 - 使用logManager记录
  safeLog(message, data = null) {
    if (this.logger) {
      try {
        this.logger.info(message, data);
      } catch (error) {
        // 静默忽略 EPIPE 错误
        if (error.code !== "EPIPE") {
          process.stderr.write(`日志错误: ${error.message}\n`);
        }
      }
    }
  }

  // 简化的 macOS accessibility 检查
  async enableMacOSAccessibility() {
    if (process.platform !== "darwin") return true;
    
    try {
      this.safeLog("🔧 检查 macOS accessibility 权限");
      
      // 简化为基本的权限检查，不设置复杂的AXManualAccessibility
      const script = `
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
          return frontApp
        end tell
      `;
      
      const testProcess = spawn("osascript", ["-e", script]);
      
      return new Promise((resolve) => {
        testProcess.on("close", (code) => {
          if (code === 0) {
            this.safeLog("✅ macOS accessibility 权限正常");
            resolve(true);
          } else {
            this.safeLog("⚠️ macOS accessibility 权限不足");
            resolve(false);
          }
        });
        
        testProcess.on("error", () => {
          this.safeLog("❌ accessibility 权限检查失败");
          resolve(false);
        });
      });
    } catch (error) {
      this.safeLog("❌ 检查 macOS accessibility 时出错:", error.message);
      return false;
    }
  }

  // 简化的文本插入方法 - 直接使用标准粘贴方式
  async insertTextDirectly(text) {
    // 简化实现，直接使用标准的粘贴方法
    this.safeLog("🎯 使用标准粘贴方式插入文本");
    return await this.pasteText(text);
  }

  async pasteText(text) {
    try {
      // 首先保存原始剪贴板内容
      const originalClipboard = clipboard.readText();
      this.safeLog(
        "💾 已保存原始剪贴板内容",
        originalClipboard.substring(0, 50) + "..."
      );

      // 将文本复制到剪贴板 - 这总是有效的
      clipboard.writeText(text);
      this.safeLog(
        "📋 文本已复制到剪贴板",
        text.substring(0, 50) + "..."
      );
      this.writeLinuxPrimarySelection(text).catch((error) => {
        this.safeLog("⚠️ Linux PRIMARY selection 后台写入失败", error?.message || String(error));
      });

      if (process.platform === "darwin") {
        // 简化权限检查，直接尝试粘贴
        this.safeLog("🔍 检查粘贴操作的辅助功能权限");
        const hasPermissions = await this.checkAccessibilityPermissions();

        if (!hasPermissions) {
          this.safeLog("⚠️ 没有辅助功能权限 - 文本仅复制到剪贴板");
          const errorMsg =
            "需要辅助功能权限才能自动粘贴。文本已复制到剪贴板 - 请手动使用 Cmd+V 粘贴。";
          throw new Error(errorMsg);
        }

        this.safeLog("✅ 权限已授予，尝试粘贴");
        return await this.pasteMacOS(originalClipboard);
      } else if (process.platform === "win32") {
        return await this.pasteWindows(originalClipboard);
      } else {
        return await this.pasteLinux(originalClipboard, text);
      }
    } catch (error) {
      throw error;
    }
  }

  async pasteMacOS(originalClipboard) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const pasteProcess = spawn("osascript", [
          "-e",
          'tell application "System Events" to keystroke "v" using command down',
        ]);

        let errorOutput = "";
        let hasTimedOut = false;

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;

          // 首先清除超时
          clearTimeout(timeoutId);

          // 清理进程引用
          pasteProcess.removeAllListeners();

          if (code === 0) {
            this.safeLog("✅ 通过 Cmd+V 模拟成功粘贴文本");
            setTimeout(() => {
              clipboard.writeText(originalClipboard);
              this.safeLog("🔄 原始剪贴板内容已恢复");
            }, 100);
            resolve();
          } else {
            const detail = errorOutput.trim();
            const errorMsg = detail
              ? `粘贴失败 (代码 ${code}): ${detail}。文本已复制到剪贴板 - 请手动使用 Cmd+V 粘贴。`
              : `粘贴失败 (代码 ${code})。文本已复制到剪贴板 - 请手动使用 Cmd+V 粘贴。`;
            reject(new Error(errorMsg));
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();
          const errorMsg = `粘贴命令失败: ${error.message}。文本已复制到剪贴板 - 请手动使用 Cmd+V 粘贴。`;
          reject(new Error(errorMsg));
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          pasteProcess.kill("SIGKILL");
          pasteProcess.removeAllListeners();
          const errorMsg =
            "粘贴操作超时。文本已复制到剪贴板 - 请手动使用 Cmd+V 粘贴。";
          reject(new Error(errorMsg));
        }, 3000);
      }, 100);
    });
  }

  async pasteWindows(originalClipboard) {
    return new Promise((resolve) => {
      const targetWindowId = /^\d+$/.test(String(this.targetWindowId || ""))
        ? String(this.targetWindowId)
        : "";
      const activationScript = targetWindowId
        ? `
        Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public static class CapsWriterWindow {
          [DllImport("kernel32.dll")]
          public static extern uint GetCurrentThreadId();
          [DllImport("user32.dll")]
          public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")]
          public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
          [DllImport("user32.dll")]
          public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
          [DllImport("user32.dll")]
          public static extern bool SetForegroundWindow(IntPtr hWnd);
          [DllImport("user32.dll")]
          public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
          [DllImport("user32.dll")]
          public static extern bool BringWindowToTop(IntPtr hWnd);
        }
"@
        $target = [IntPtr]${targetWindowId}
        $currentThread = [CapsWriterWindow]::GetCurrentThreadId()
        $targetThread = [CapsWriterWindow]::GetWindowThreadProcessId($target, [IntPtr]::Zero)
        $foreground = [CapsWriterWindow]::GetForegroundWindow()
        $foregroundThread = [CapsWriterWindow]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
        if ($targetThread -ne 0) {
          [CapsWriterWindow]::AttachThreadInput($currentThread, $targetThread, $true) | Out-Null
        }
        if ($foregroundThread -ne 0 -and $foregroundThread -ne $targetThread) {
          [CapsWriterWindow]::AttachThreadInput($currentThread, $foregroundThread, $true) | Out-Null
        }
        try {
          [CapsWriterWindow]::ShowWindowAsync($target, 9) | Out-Null
          [CapsWriterWindow]::BringWindowToTop($target) | Out-Null
          [CapsWriterWindow]::SetForegroundWindow($target) | Out-Null
        } finally {
          if ($foregroundThread -ne 0 -and $foregroundThread -ne $targetThread) {
            [CapsWriterWindow]::AttachThreadInput($currentThread, $foregroundThread, $false) | Out-Null
          }
          if ($targetThread -ne 0) {
            [CapsWriterWindow]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null
          }
        }
        Start-Sleep -Milliseconds 120
        `
        : "";
      const pasteProcess = spawn("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
        ${activationScript}
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait("^v")
        `
      ], { windowsHide: true });

      let errorOutput = "";
      pasteProcess.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });

      pasteProcess.on("close", (code) => {
        if (code === 0) {
          this.safeLog("✅ Windows 粘贴成功", {
            targetWindowId: targetWindowId || null,
          });
          setTimeout(() => {
            clipboard.writeText(originalClipboard);
            this.safeLog("🔄 原始剪贴板内容已恢复");
          }, 100);
          resolve();
        } else {
          this.safeLog("❌ Windows 粘贴失败:", errorOutput);
          // 即使失败，文本也在剪贴板中，用户可以手动粘贴
          resolve();
        }
      });

      pasteProcess.on("error", (error) => {
        this.safeLog("❌ Windows 粘贴错误:", error.message);
        // 即使失败，文本也在剪贴板中
        resolve();
      });
    });
  }

  async pasteLinux(originalClipboard, text = "") {
    const traceId = this.createTraceId();
    const startedAt = Date.now();
    const trace = {
      traceId,
      targetWindowId: this.targetWindowId || null,
      textLength: String(text || "").length,
      windowClass: "",
      windowTitle: "",
      preferredMethod: "",
      strategySource: "",
      attempts: [],
      finalMethod: "",
      clipboardRestored: false,
      clipboardRestoreReason: "",
      success: false,
      totalMs: 0,
    };
    let targetActivationOk = !this.targetWindowId;

    if (this.targetWindowId) {
      const activateResult = await this.spawnWithResult(
        "xdotool",
        ["windowactivate", "--sync", this.targetWindowId],
        2000
      );
      targetActivationOk = activateResult.ok;
      this.safeLog("🎯 激活目标窗口结果", {
        traceId,
        targetWindowId: this.targetWindowId,
        ok: activateResult.ok,
        code: activateResult.code,
        stderr: activateResult.stderr,
      });
      await new Promise((resolve) => setTimeout(resolve, LINUX_TARGET_ACTIVATION_SETTLE_MS));
    }

    const activeWindowId = this.targetWindowId || (() => {
      try {
        return execSync("xdotool getactivewindow 2>/dev/null", { encoding: "utf-8" }).trim();
      } catch (_) {
        return "";
      }
    })();
    const windowMeta = this.getLinuxWindowMeta(activeWindowId);
    trace.windowClass = windowMeta.windowClass;
    trace.windowTitle = windowMeta.windowTitle;
    await new Promise((resolve) => setTimeout(resolve, LINUX_CLIPBOARD_SETTLE_MS));

    const strategy = this.chooseLinuxPasteMethods(windowMeta.windowClass, windowMeta.windowTitle);
    const hasWindowMeta = Boolean(windowMeta.windowClass || windowMeta.windowTitle);
    const isRemoteWindow = this.isLinuxRemoteWindow(
      windowMeta.windowClass,
      windowMeta.windowTitle
    );
    const isWeChatWindow = this.isLinuxWeChatWindow(
      windowMeta.windowClass,
      windowMeta.windowTitle
    );
    const restoreClipboardAfterPaste = targetActivationOk && hasWindowMeta && !isRemoteWindow && !isWeChatWindow;
    trace.preferredMethod = strategy.preferredMethod;
    trace.strategySource = strategy.source;
    trace.clipboardRestoreReason = restoreClipboardAfterPaste
      ? "local_window"
      : !targetActivationOk
        ? "target_activation_failed"
        : !hasWindowMeta
          ? "unknown_window"
          : isWeChatWindow
            ? "wechat_window"
            : "remote_window";
    this.safeLog("🧭 Linux 粘贴策略", {
      traceId,
      windowId: windowMeta.windowId,
      windowClass: windowMeta.windowClass,
      windowTitle: windowMeta.windowTitle,
      preferredMethod: strategy.preferredMethod,
      source: strategy.source,
      sequence: strategy.sequence,
      targetActivationOk,
      hasWindowMeta,
      restoreClipboardAfterPaste,
    });

    for (let idx = 0; idx < strategy.sequence.length; idx += 1) {
      const method = strategy.sequence[idx];
      const keyCombo = this.methodToKeyCombo(method);
      const attemptStartedAt = Date.now();
      const result = await this.runLinuxPasteCommand(method, keyCombo);
      await new Promise((resolve) => setTimeout(resolve, LINUX_PASTE_AFTER_KEY_SETTLE_MS));

      const attemptLog = {
        index: idx + 1,
        method,
        keyCombo,
        ok: result.ok,
        code: result.code,
        timeout: result.timeout,
        stderr: result.stderr,
        backend: result.backend || "",
        fallbackFrom: result.fallbackFrom || "",
        fallbackError: result.fallbackError || "",
        elapsedMs: Date.now() - attemptStartedAt,
      };
      trace.attempts.push(attemptLog);

      this.safeLog("⌨️ Linux 粘贴尝试", {
        traceId,
        ...attemptLog,
      });

      if (result.ok) {
        trace.success = true;
        trace.finalMethod = method;
        if (restoreClipboardAfterPaste) {
          setTimeout(() => {
            clipboard.writeText(originalClipboard);
            this.safeLog("🔄 Linux 原始剪贴板内容已恢复", { traceId, method });
          }, LINUX_CLIPBOARD_RESTORE_DELAY_MS);
          trace.clipboardRestored = true;
        } else {
          this.safeLog("📌 Linux 跳过原始剪贴板恢复", {
            traceId,
            method,
            reason: trace.clipboardRestoreReason,
          });
        }
        this.safeLog("✅ Linux 粘贴命令成功", {
          traceId,
          method,
          keyCombo,
        });
        this.rememberLinuxPasteMethod(windowMeta.windowClass, method);
        break;
      }
    }

    if (!trace.success) {
      this.safeLog("❌ Linux 粘贴命令全部失败，文本已保留在剪贴板", { traceId });
    }

    trace.totalMs = Date.now() - startedAt;
    this.safeLog("📌 Linux 粘贴追踪汇总", trace);
    return trace;
  }

  async checkAccessibilityPermissions() {
    if (process.platform !== "darwin") return true;

    return new Promise((resolve) => {
      // 检查辅助功能权限
      const testProcess = spawn("osascript", [
        "-e",
        'tell application "System Events" to get name of first process',
      ]);

      let testError = "";

      testProcess.stderr.on("data", (data) => {
        testError += data.toString();
      });

      testProcess.on("close", (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          this.showAccessibilityDialog(testError);
          resolve(false);
        }
      });

      testProcess.on("error", () => {
        resolve(false);
      });
    });
  }

  showAccessibilityDialog(testError) {
    const isStuckPermission =
      testError.includes("not allowed assistive access") ||
      testError.includes("(-1719)") ||
      testError.includes("(-25006)");

    let dialogMessage;
    if (isStuckPermission) {
      dialogMessage = `🔒 语音转写需要辅助功能权限，但看起来您可能有来自先前版本的旧权限。

❗ 常见问题：如果您重新构建/重新安装了语音转写，旧权限可能"卡住"并阻止新权限。

🔧 解决方法：
1. 打开系统设置 → 隐私与安全性 → 辅助功能
2. 查找任何旧的"语音转写"条目并删除它们（点击 - 按钮）
3. 同时删除任何显示"Electron"或名称不明确的条目
4. 点击 + 按钮并手动添加新的语音转写应用
5. 确保复选框已启用
6. 重启语音转写

⚠️ 这在开发期间重新构建应用时特别常见。

📝 没有此权限，文本将只复制到剪贴板（无自动粘贴）。

您想现在打开系统设置吗？`;
    } else {
      dialogMessage = `🔒 语音转写需要辅助功能权限才能将文本粘贴到其他应用程序中。

📋 当前状态：剪贴板复制有效，但粘贴（Cmd+V 模拟）失败。

🔧 解决方法：
1. 打开系统设置（或较旧 macOS 上的系统偏好设置）
2. 转到隐私与安全性 → 辅助功能
3. 点击锁图标并输入您的密码
4. 将语音转写添加到列表中并勾选复选框
5. 重启语音转写

⚠️ 没有此权限，听写文本将只复制到剪贴板但不会自动粘贴。

💡 在生产版本中，此权限是完整功能所必需的。

您想现在打开系统设置吗？`;
    }

    const permissionDialog = spawn("osascript", [
      "-e",
      `display dialog "${dialogMessage}" buttons {"取消", "打开系统设置"} default button "打开系统设置"`,
    ]);

    permissionDialog.on("close", (dialogCode) => {
      if (dialogCode === 0) {
        this.openSystemSettings();
      }
    });

    permissionDialog.on("error", () => {
      // 权限对话框错误 - 用户需要手动授予权限
    });
  }

  openSystemSettings() {
    const settingsCommands = [
      [
        "open",
        [
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ],
      ],
      ["open", ["-b", "com.apple.systempreferences"]],
      ["open", ["/System/Library/PreferencePanes/Security.prefPane"]],
    ];

    let commandIndex = 0;
    const tryNextCommand = () => {
      if (commandIndex < settingsCommands.length) {
        const [cmd, args] = settingsCommands[commandIndex];
        const settingsProcess = spawn(cmd, args);

        settingsProcess.on("error", () => {
          commandIndex++;
          tryNextCommand();
        });

        settingsProcess.on("close", (settingsCode) => {
          if (settingsCode !== 0) {
            commandIndex++;
            tryNextCommand();
          }
        });
      } else {
        // 所有设置命令都失败，尝试后备方案
        spawn("open", ["-a", "System Preferences"]).on("error", () => {
          spawn("open", ["-a", "System Settings"]).on("error", () => {
            // 无法打开设置应用
          });
        });
      }
    };

    tryNextCommand();
  }

  /**
   * 复制文本到剪贴板
   * @param {string} text - 要复制的文本
   * @returns {Promise<{success: boolean}>}
   */
  async copyText(text) {
    try {
      clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      throw error;
    }
  }

  /**
   * 从剪贴板读取文本
   * @returns {Promise<string>}
   */
  async readClipboard() {
    try {
      const text = clipboard.readText();
      return text;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 将文本写入剪贴板
   * @param {string} text - 要写入的文本
   * @returns {Promise<{success: boolean}>}
   */
  async writeClipboard(text) {
    try {
      clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      throw error;
    }
  }
}

module.exports = ClipboardManager;
