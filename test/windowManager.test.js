const assert = require("node:assert/strict");
const test = require("node:test");

const WindowManager = require("../src/helpers/windowManager");

test("records the Windows foreground window handle for later paste activation", () => {
  let command = null;
  let args = null;
  const manager = new WindowManager({
    platform: "win32",
    execFileSync(receivedCommand, receivedArgs) {
      command = receivedCommand;
      args = receivedArgs;
      return "424242\r\n";
    },
  });

  assert.equal(manager.rememberActiveWindow(), "424242");
  assert.equal(manager.previousActiveWindow, "424242");
  assert.equal(command, "powershell");
  assert.deepEqual(args.slice(0, 3), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  assert.match(args[3], /GetForegroundWindow/);
});

test("rejects an invalid Windows foreground window handle", () => {
  const manager = new WindowManager({
    platform: "win32",
    execFileSync() {
      return "not-a-window";
    },
  });

  assert.equal(manager.rememberActiveWindow(), null);
  assert.equal(manager.previousActiveWindow, null);
});
