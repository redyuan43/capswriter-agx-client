const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const LogManager = require("../src/helpers/logManager");

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for log flush"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("log manager batches writes without console output", async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "capswriter-log-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let consoleCalls = 0;
  const manager = new LogManager({
    userDataPath,
    consoleEnabled: false,
    consoleRef: { log() { consoleCalls += 1; } },
  });

  manager.info("first", { value: 1 });
  manager.warn("second", { value: 2 });
  await waitFor(() => fs.existsSync(manager.logFile) &&
    fs.readFileSync(manager.logFile, "utf8").split("\n").filter(Boolean).length === 2);

  const logs = manager.getRecentLogs(2);
  assert.equal(consoleCalls, 0);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].message, "first");
  assert.equal(logs[1].message, "second");
});

test("log manager rotates an oversized file on startup", (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "capswriter-log-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const logDir = path.join(userDataPath, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "app.log"), "old-log-content");

  const manager = new LogManager({
    userDataPath,
    consoleEnabled: false,
    maxLogBytes: 1,
  });

  assert.equal(fs.existsSync(manager.logFile), false);
  assert.equal(
    fs.readFileSync(`${manager.logFile}.1`, "utf8"),
    "old-log-content"
  );
});
