const assert = require("node:assert/strict");
const test = require("node:test");

const WindowManager = require("../src/helpers/windowManager");
const {
  DEFAULT_ASR_ADMIN_URL,
  resolveAsrAdminUrl,
} = require("../src/helpers/windowManager");

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

test("keeps the floating ball non-focusable on Wayland while dictating", () => {
  const calls = [];
  const manager = new WindowManager({ platform: "linux", sessionType: "wayland" });
  manager.mainWindow = {
    isDestroyed: () => false,
    setFocusable: (value) => calls.push(["setFocusable", value]),
    showInactive: () => calls.push(["showInactive"]),
    blur: () => calls.push(["blur"]),
  };

  assert.equal(manager.setFloatingBallInputCaptureEnabled(true), true);
  assert.deepEqual(calls, [
    ["setFocusable", false],
    ["showInactive"],
    ["blur"],
  ]);
});

test("resolves the default and configured ASR administration URLs", () => {
  assert.equal(resolveAsrAdminUrl({}), DEFAULT_ASR_ADMIN_URL);
  assert.equal(
    resolveAsrAdminUrl({ CAPSWRITER_ASR_ADMIN_URL: "https://asr.example.test/admin" }),
    "https://asr.example.test/admin"
  );
  assert.throws(
    () => resolveAsrAdminUrl({ CAPSWRITER_ASR_ADMIN_URL: "file:///tmp/admin.html" }),
    /仅支持 HTTP 或 HTTPS/
  );
});

test("reuses a secure ASR administration window", async () => {
  const calls = [];
  const listeners = new Map();
  const webContentsListeners = new Map();
  const fakeWindow = {
    isDestroyed: () => false,
    loadURL: async (url) => calls.push(["loadURL", url]),
    show: () => calls.push(["show"]),
    focus: () => calls.push(["focus"]),
    destroy: () => calls.push(["destroy"]),
    on: (event, handler) => listeners.set(event, handler),
    webContents: {
      setWindowOpenHandler: (handler) => calls.push(["setWindowOpenHandler", handler]),
      on: (event, handler) => webContentsListeners.set(event, handler),
    },
  };
  let created = 0;
  let receivedOptions = null;
  const manager = new WindowManager({
    env: { CAPSWRITER_ASR_ADMIN_URL: "https://asr.example.test/admin" },
    browserWindowFactory(options) {
      created += 1;
      receivedOptions = options;
      return fakeWindow;
    },
  });

  assert.equal(await manager.showAsrAdminWindow(), true);
  assert.equal(await manager.showAsrAdminWindow(), true);
  assert.equal(created, 1);
  assert.deepEqual(
    calls.filter(([name]) => name === "loadURL"),
    [["loadURL", "https://asr.example.test/admin"]]
  );
  assert.equal(receivedOptions.webPreferences.nodeIntegration, false);
  assert.equal(receivedOptions.webPreferences.contextIsolation, true);
  assert.equal(receivedOptions.webPreferences.sandbox, true);
  assert.equal(calls.filter(([name]) => name === "show").length, 2);
  assert.equal(calls.filter(([name]) => name === "focus").length, 2);

  let prevented = false;
  webContentsListeners.get("will-navigate")(
    { preventDefault: () => { prevented = true; } },
    "https://other.example.test/"
  );
  assert.equal(prevented, true);

  listeners.get("closed")();
  assert.equal(manager.asrAdminWindow, null);
});
