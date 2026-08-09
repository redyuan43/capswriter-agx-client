const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const settingsHtml = fs.readFileSync(
  path.join(root, "src/settings.html"),
  "utf8"
);
const settingsEntry = fs.readFileSync(
  path.join(root, "src/settings.jsx"),
  "utf8"
);

test("production settings entry mounts the settings page", () => {
  assert.match(settingsHtml, /id=["']settings-root["']/);
  assert.match(settingsEntry, /document\.getElementById\(["']settings-root["']\)/);
  assert.match(settingsEntry, /createRoot\(settingsRoot\)\.render\(<SettingsPage \/>\)/);
});

test("settings page exposes the ASR administration entry", () => {
  assert.match(settingsEntry, /openAsrAdminWindow/);
  assert.match(settingsEntry, />\s*ASR 管理\s*</);
});

test("settings page exposes the verified device mapping entry", () => {
  assert.match(settingsEntry, /KnobMapperPanel/);
  assert.match(settingsEntry, />\s*设备映射\s*</);
});

test("settings page keeps the selected core entries and removes voice links", () => {
  assert.match(settingsEntry, />\s*M5 Bridge\s*</);
  assert.match(settingsEntry, />\s*ASR 服务端\s*</);
  assert.match(settingsEntry, />\s*翻译历史\s*</);
  assert.doesNotMatch(settingsEntry, />\s*语音链接表\s*</);
  assert.doesNotMatch(settingsEntry, /openLinkDirectoryWindow/);
});

test("settings page does not expose the removed process monitor", () => {
  assert.doesNotMatch(settingsEntry, /ProcessMonitorPanel/);
  assert.doesNotMatch(settingsEntry, />\s*进程监控\s*</);
  assert.doesNotMatch(settingsEntry, /activeTab === ['"]monitor['"]/);
});
