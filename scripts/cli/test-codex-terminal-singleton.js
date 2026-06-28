#!/usr/bin/env node

const assert = require("assert");
const os = require("os");
const path = require("path");
const CodexTerminalManager = require("../../src/helpers/codexTerminalManager");

function createManager(options = {}) {
  const manager = new CodexTerminalManager({
    dataDirectory: path.join(os.tmpdir(), `capswriter-codex-tmux-test-${process.pid}-${Date.now()}`)
  });
  const state = {
    sessionExists: Boolean(options.sessionExists),
    attachedClients: Number(options.attachedClients || 0),
    tmuxAvailable: options.tmuxAvailable !== false,
    visibleLaunches: 0
  };
  const commands = [];
  const inputCommands = [];
  const warnings = [];

  manager.logger = {
    warn: (message, data) => warnings.push({ message, data }),
    info: () => {}
  };
  manager._commandExists = (command) => {
    if (command === "tmux") return state.tmuxAvailable;
    return command === "ptyxis";
  };
  manager._tmuxSessionExists = () => state.tmuxAvailable && state.sessionExists;
  manager._getAttachedClientCount = () => (state.sessionExists ? state.attachedClients : 0);
  manager._ensureVisibleTmuxClient = async () => {
    if (state.attachedClients > 0) return false;
    state.attachedClients = 1;
    state.visibleLaunches += 1;
    return true;
  };
  manager._runCommand = async (command, args) => {
    commands.push({ command, args });
    if (command === "tmux" && args[0] === "new-session") {
      state.sessionExists = true;
    }
    return true;
  };
  manager._runCommandWithInput = async (command, args, input) => {
    inputCommands.push({ command, args, input });
    return true;
  };

  return { manager, state, commands, inputCommands, warnings };
}

async function run() {
  const managers = [];

  {
    const { manager, state, commands, inputCommands } = createManager();
    managers.push(manager);

    const result = await manager.submitPrompt("查一下深圳天气");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.launched, true);
    assert.strictEqual(result.openedVisibleClient, true);
    assert.strictEqual(result.sessionName, "capswriter-codex");
    assert.strictEqual(state.visibleLaunches, 1);
    assert.strictEqual(commands.filter((item) => item.args[0] === "new-session").length, 1);
    assert.deepStrictEqual(inputCommands.map((item) => item.input), ["查一下深圳天气"]);
    assert.ok(commands.some((item) => item.args[0] === "paste-buffer"));
    assert.ok(commands.some((item) => item.args[0] === "send-keys" && item.args.includes("Enter")));
  }

  {
    const { manager, state, commands, inputCommands } = createManager({
      sessionExists: true,
      attachedClients: 1
    });
    managers.push(manager);

    const result = await manager.submitPrompt("继续回答上一个问题");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.launched, false);
    assert.strictEqual(result.openedVisibleClient, false);
    assert.strictEqual(state.visibleLaunches, 0);
    assert.strictEqual(commands.filter((item) => item.args[0] === "new-session").length, 0);
    assert.deepStrictEqual(inputCommands.map((item) => item.input), ["继续回答上一个问题"]);
  }

  {
    const { manager, commands } = createManager({ sessionExists: true, attachedClients: 1 });
    managers.push(manager);

    const result = await manager.cancelActiveTask("test_escape");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.cancelled, true);
    assert.ok(commands.some((item) => item.args[0] === "send-keys" && item.args.includes("Escape")));
    assert.ok(commands.some((item) => item.args[0] === "send-keys" && item.args.includes("C-c")));
  }

  {
    const { manager } = createManager({ tmuxAvailable: false });
    managers.push(manager);

    const submitResult = await manager.submitPrompt("查天气");
    const cancelResult = await manager.cancelActiveTask("test_no_tmux");

    assert.strictEqual(submitResult.success, false);
    assert.match(submitResult.error, /tmux/);
    assert.strictEqual(cancelResult.success, false);
    assert.strictEqual(cancelResult.cancelled, false);
    assert.match(cancelResult.error, /tmux/);
  }

  managers.forEach((manager) => manager.stop());
  console.log("PASS codex terminal tmux singleton");
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
