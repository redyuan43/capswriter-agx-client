#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LinkBookmarkManager } = require("../../src/helpers/linkBookmarkManager");
const VoiceActionManager = require("../../src/helpers/voiceActionManager");
const { VoiceLearningManager } = require("../../src/helpers/voiceLearningManager");

function createTempPath(name) {
  return path.join(os.tmpdir(), `capswriter-${name}-${process.pid}-${Date.now()}.json`);
}

function createManager({ teacherDecision = null, shortcuts = [], clipboardManager = {}, linkBookmarkManager = null, openExternal = null } = {}) {
  const teacherCalls = [];
  const reviewLaunches = [];
  const learningManager = new VoiceLearningManager({
    shortcutsPath: createTempPath("shortcuts"),
    queuePath: createTempPath("learning-queue")
  });
  learningManager.loadShortcuts = () => shortcuts;
  const configPath = createTempPath("actions");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ version: 1, defaults: { fallbackAction: "codex_terminal" }, intents: [] })
  );

  const manager = new VoiceActionManager({
    logger: { warn: () => {}, info: () => {} },
    clipboardManager,
    teacherClassifier: {
      classify: async (payload) => {
        teacherCalls.push(payload);
        return { success: true, decision: teacherDecision || {}, model: "fake-teacher" };
      },
      cancelActive: () => false
    },
    learningManager,
    linkBookmarkManager,
    openExternal,
    configPath
  });

  manager.getActiveWindowInfo = () => ({
    windowId: "window-1",
    windowClass: "org.gnome.Ptyxis",
    windowTitle: "Terminal",
    pid: "",
    cwd: os.homedir(),
    isTerminal: true,
    isUnknownWindow: false
  });
  manager.launchIntentDraftReview = async (candidate) => {
    reviewLaunches.push(candidate);
  };

  return { manager, teacherCalls, reviewLaunches, learningManager };
}

async function run() {
  {
    const { manager, teacherCalls } = createManager({
      shortcuts: [
        {
          id: "shortcut_summary",
          phrases: ["这个黑窗口刚才干啥了"],
          normalizedPhrases: ["这个黑窗口刚才干啥了"],
          routeType: "codex_terminal",
          intentId: null,
          enabled: true
        }
      ]
    });

    const result = await manager.handlePrompt("这个黑窗口刚才干啥了", {});
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.handled, false);
    assert.strictEqual(result.fallback, "codex_terminal");
    assert.strictEqual(teacherCalls.length, 0, "shortcut 命中后不应调用 Teacher");
  }

  {
    const pasted = [];
    const { manager } = createManager({
      clipboardManager: {
        setTargetWindow: () => {},
        pasteText: async (text) => {
          pasted.push(text);
        }
      }
    });
    const pressedWindows = [];
    manager.pressEnter = async (windowId) => {
      pressedWindows.push(windowId);
    };

    const result = await manager.handlePrompt("用 VS Code 打开这个目录", {});

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.handledByVoiceAction, true);
    assert.strictEqual(result.intentId, "open_vscode");
    assert.strictEqual(result.actionType, "terminal_prompt");
    assert.deepStrictEqual(pasted, ["code $PWD"]);
    assert.deepStrictEqual(pressedWindows, ["window-1"]);
  }

  {
    const { manager } = createManager();
    const commandCalls = [];
    const keySequences = [];
    manager.runCommand = async (command, args, timeoutMs) => {
      commandCalls.push({ command, args, timeoutMs });
    };
    manager.runLinuxKeySequence = async (payload) => {
      keySequences.push(payload);
    };

    const result = await manager.handlePrompt("把这个窗口移到右边工作空间去", {});

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.handledByVoiceAction, true);
    assert.strictEqual(result.intentId, "move_window_to_right_workspace");
    assert.strictEqual(result.actionType, "key_sequence");
    assert.deepStrictEqual(commandCalls, [
      { command: "xdotool", args: ["windowactivate", "--sync", "window-1"], timeoutMs: 2000 }
    ]);
    assert.deepStrictEqual(keySequences, [
      { ydotoolKeys: [], xdotoolKeys: ["shift+super+Right"], timeoutMs: 1500 }
    ]);
  }

  {
    const { manager } = createManager();
    const keySequences = [];
    manager.runCommand = async () => {};
    manager.runLinuxKeySequence = async (payload) => {
      keySequences.push(payload);
    };

    const result = await manager.handlePrompt("把这个窗口移动左边的 workspace 里面", {});

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "move_window_to_left_workspace");
    assert.deepStrictEqual(keySequences, [
      { ydotoolKeys: [], xdotoolKeys: ["shift+super+Left"], timeoutMs: 1500 }
    ]);
  }

  {
    const { manager } = createManager();
    const keySequences = [];
    manager.runCommand = async () => {};
    manager.runLinuxKeySequence = async (payload) => {
      keySequences.push(payload);
    };

    const result = await manager.handlePrompt("把浏览器向右移动两个空间", {});

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "move_window_to_right_workspace");
    assert.deepStrictEqual(keySequences, [
      { ydotoolKeys: [], xdotoolKeys: ["shift+super+Right"], timeoutMs: 1500 },
      { ydotoolKeys: [], xdotoolKeys: ["shift+super+Right"], timeoutMs: 1500 }
    ]);
  }

  {
    const { manager } = createManager();
    const keySequences = [];
    manager.runCommand = async () => {};
    manager.runLinuxKeySequence = async (payload) => {
      keySequences.push(payload);
    };

    const result = await manager.handlePrompt("把对话框往左挪三个 workspace", {});

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "move_window_to_left_workspace");
    assert.strictEqual(keySequences.length, 3);
    assert.ok(keySequences.every((payload) => payload.xdotoolKeys[0] === "shift+super+Left"));
  }

  {
    const { manager } = createManager();
    const keySequences = [];
    manager.runCommand = async () => {};
    manager.runLinuxKeySequence = async (payload) => {
      keySequences.push(payload);
    };

    const result = await manager.executeIntentById("move_window_to_right_workspace", {
      text: "把 Windows 向右移动两个空间"
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "move_window_to_right_workspace");
    assert.strictEqual(keySequences.length, 2);
    assert.ok(keySequences.every((payload) => payload.xdotoolKeys[0] === "shift+super+Right"));
  }

  {
    const { manager } = createManager();
    const keySequences = [];
    manager.runCommand = async () => {};
    manager.runLinuxKeySequence = async (payload) => {
      keySequences.push(payload);
      manager.cancelActiveRouting("escape");
    };

    const result = await manager.handlePrompt("把浏览器向右移动三个空间", {});

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.intentId, "move_window_to_right_workspace");
    assert.strictEqual(keySequences.length, 1);
  }

  {
    const openedUrls = [];
    const linkBookmarkManager = new LinkBookmarkManager({
      bookmarksPath: createTempPath("link-bookmarks")
    });
    linkBookmarkManager.saveBookmark({
      id: "daily_report",
      title: "日报系统",
      url: "http://127.0.0.1:9999/report",
      aliases: ["日报", "日报页面"],
      enabled: true
    });
    const { manager } = createManager({
      linkBookmarkManager,
      openExternal: async (url) => {
        openedUrls.push(url);
      }
    });

    const result = await manager.handlePrompt("打开日报页面", {});

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "open_link_bookmark");
    assert.strictEqual(result.actionType, "open_link_bookmark");
    assert.deepStrictEqual(openedUrls, ["http://127.0.0.1:9999/report"]);
  }

  {
    const openedUrls = [];
    const linkBookmarkManager = new LinkBookmarkManager({
      bookmarksPath: createTempPath("link-bookmarks-strong-alias")
    });
    const { manager } = createManager({
      linkBookmarkManager,
      openExternal: async (url) => {
        openedUrls.push(url);
      }
    });

    const result = await manager.handlePrompt("设计风格", {});

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "open_link_bookmark");
    assert.strictEqual(result.matchSource, "link_exact");
    assert.deepStrictEqual(openedUrls, ["http://127.0.0.1:17573/design-systems"]);
  }

  {
    const openedUrls = [];
    const linkBookmarkManager = new LinkBookmarkManager({
      bookmarksPath: createTempPath("link-bookmarks-chatgpt")
    });
    const { manager } = createManager({
      linkBookmarkManager,
      openExternal: async (url) => {
        openedUrls.push(url);
      }
    });

    const result = await manager.handlePrompt("打开ChatGPT页面", {});

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "open_link_bookmark");
    assert.strictEqual(result.matchSource, "link_exact");
    assert.deepStrictEqual(openedUrls, ["https://chatgpt.com"]);
  }

  {
    const openedUrls = [];
    const shellCalls = [];
    const linkBookmarkManager = new LinkBookmarkManager({
      bookmarksPath: createTempPath("link-bookmarks-server-override")
    });
    const { manager } = createManager({
      linkBookmarkManager,
      openExternal: async (url) => {
        openedUrls.push(url);
      }
    });
    manager.spawnDetached = async (command, args) => {
      shellCalls.push({ command, args });
    };

    const result = await manager.executeLinkBookmarkOverride("打开ChatGPT网页", {
      serverIntentId: "open_gnome_terminal"
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "open_link_bookmark");
    assert.strictEqual(result.actionType, "open_link_bookmark");
    assert.deepStrictEqual(openedUrls, ["https://chatgpt.com"]);
    assert.deepStrictEqual(shellCalls, []);
  }

  {
    const { manager } = createManager();
    const shellCalls = [];
    manager.spawnDetached = async (command, args) => {
      shellCalls.push({ command, args });
    };

    const result = await manager.executeLinkBookmarkOverride("打开一个终端", {
      serverIntentId: "open_gnome_terminal"
    });

    assert.strictEqual(result, null);
    assert.deepStrictEqual(shellCalls, []);
  }

  {
    const { manager, teacherCalls } = createManager();
    const result = await manager.handlePrompt("   ", {});

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.error, "Empty prompt");
    assert.strictEqual(teacherCalls.length, 0, "空白提示词不应进入 Teacher 或兜底路由");
  }

  {
    const { manager } = createManager();
    const shellCalls = [];
    manager.spawnDetached = async (command, args) => {
      shellCalls.push({ command, args });
    };

    const result = await manager.executeIntentById("open_gnome_terminal", {
      text: ""
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.intentId, "open_gnome_terminal");
    assert.strictEqual(result.matchSource, "empty_prompt");
    assert.deepStrictEqual(shellCalls, []);
  }

  {
    const { manager } = createManager();
    const shellCalls = [];
    manager.spawnDetached = async (command, args) => {
      shellCalls.push({ command, args });
    };

    const result = await manager.executeIntentById("open_gnome_terminal", {
      text: "打开ChatGPT页面"
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.intentId, "open_gnome_terminal");
    assert.strictEqual(result.matchSource, "ambiguous_program");
    assert.deepStrictEqual(shellCalls, []);
  }

  {
    const { manager } = createManager();
    const shellCalls = [];
    manager.spawnDetached = async (command, args) => {
      shellCalls.push({ command, args });
    };

    const result = await manager.executeIntentById("open_gnome_terminal", {
      text: "打开一个终端"
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "open_gnome_terminal");
    assert.deepStrictEqual(shellCalls, [{ command: "gnome-terminal", args: [] }]);
  }

  {
    const { manager } = createManager();
    const shellCalls = [];
    manager.spawnDetached = async (command, args) => {
      shellCalls.push({ command, args });
    };

    const result = await manager.handlePrompt("创建三个终端", {});

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "open_gnome_terminal");
    assert.strictEqual(result.actionType, "shell");
    assert.strictEqual(shellCalls.length, 3);
    assert.deepStrictEqual(shellCalls, [
      { command: "gnome-terminal", args: [] },
      { command: "gnome-terminal", args: [] },
      { command: "gnome-terminal", args: [] }
    ]);
  }

  {
    const { manager } = createManager();
    const shellCalls = [];
    manager.spawnDetached = async (command, args) => {
      shellCalls.push({ command, args });
    };

    const result = await manager.executeIntentById("open_gnome_terminal", {
      text: "打开2个终端"
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "open_gnome_terminal");
    assert.strictEqual(shellCalls.length, 2);
  }

  {
    const { manager } = createManager();
    const shellCalls = [];
    manager.spawnDetached = async (command, args) => {
      shellCalls.push({ command, args });
    };

    const result = await manager.executeDeterministicIntentOverride("创建三个终端", {
      serverIntentId: "open_vscode"
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.intentId, "open_gnome_terminal");
    assert.strictEqual(result.actionType, "shell");
    assert.strictEqual(shellCalls.length, 3);
  }

  {
    const { manager, reviewLaunches, learningManager } = createManager({
      teacherDecision: {
        routeType: "ask",
        intentId: null,
        confidence: 0.94,
        risk: "medium",
        confirmationRequired: true,
        learnable: true,
        learnTarget: "new_intent_draft",
        learningAction: "draft_intent",
        targetRoute: "intent",
        suggestedPhrases: ["开项目"],
        draftIntentRequest: {
          userPhrase: "以后我说开项目，就帮我做项目准备动作",
          desiredBehavior: "执行用户确认后的项目准备固定动作",
          suggestedIntentId: "open_project_in_vscode",
          suggestedDescription: "用 VS Code 打开当前终端所在目录",
          missingDetails: []
        },
        preview: "需要创建新的语音意图",
        reason: "现有 intent 不能表达该自定义话术"
      }
    });

    const result = await manager.handlePrompt("以后我说开项目，就帮我做项目准备动作", {});
    const queue = learningManager.loadRawQueue();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.handledByVoiceAction, true);
    assert.strictEqual(result.actionType, "draft_intent");
    assert.strictEqual(reviewLaunches.length, 1);
    assert.strictEqual(reviewLaunches[0].draftIntentRequest.suggestedIntentId, "open_project_in_vscode");
    assert.ok(queue.events.some((event) => event.type === "teacher_decision"));
    assert.ok(queue.events.some((event) => event.type === "intent_draft_requested"));
  }

  console.log("PASS voice learning funnel");
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
