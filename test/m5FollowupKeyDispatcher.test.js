const assert = require("node:assert/strict");
const test = require("node:test");

const M5FollowupKeyDispatcher = require("../src/helpers/m5FollowupKeyDispatcher");

test("follow-up dispatcher activates the target before sending Return", async () => {
  const commands = [];
  const dispatcher = new M5FollowupKeyDispatcher({
    platform: "linux",
    settleMs: 0,
    runCommand: async (command, args) => {
      commands.push({ command, args });
      return { success: true };
    },
  });

  const result = await dispatcher.send({
    sessionId: "session",
    targetWindowId: "42",
    keyName: "Return",
    reason: "queued",
  });

  assert.deepEqual(result, { success: true, status: "sent", reason: "queued" });
  assert.deepEqual(commands, [
    { command: "xdotool", args: ["windowactivate", "--sync", "42"] },
    { command: "xdotool", args: ["key", "--delay", "35", "Return"] },
  ]);
});

test("follow-up dispatcher reports unsupported and command failure states", async () => {
  const unsupported = new M5FollowupKeyDispatcher({
    platform: "win32",
    runCommand: async () => ({ success: true }),
  });
  assert.equal((await unsupported.send({
    sessionId: "session",
    targetWindowId: "42",
    keyName: "Return",
  })).status, "unsupported_platform");

  const missingTarget = new M5FollowupKeyDispatcher({
    platform: "linux",
    runCommand: async () => ({ success: true }),
  });
  assert.equal((await missingTarget.send({
    sessionId: "session",
    targetWindowId: "",
    keyName: "Return",
  })).status, "no_target_window");

  let commandCount = 0;
  const activationFailure = new M5FollowupKeyDispatcher({
    platform: "linux",
    runCommand: async () => {
      commandCount += 1;
      return { success: false, error: "activate failed" };
    },
  });
  assert.equal((await activationFailure.send({
    sessionId: "session",
    targetWindowId: "42",
    keyName: "Return",
  })).status, "activate_failed");
  assert.equal(commandCount, 1);
});

test("follow-up dispatcher enqueue settles exactly once", async () => {
  let sends = 0;
  const dispatcher = new M5FollowupKeyDispatcher({
    platform: "linux",
    settleMs: 0,
    runCommand: async () => {
      sends += 1;
      return { success: true };
    },
  });
  const completed = [];

  await dispatcher.enqueue({
    sessionId: "session",
    targetWindowId: "42",
    keyName: "Return",
  }, (result) => completed.push(result));

  assert.equal(sends, 2);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, "sent");
});
