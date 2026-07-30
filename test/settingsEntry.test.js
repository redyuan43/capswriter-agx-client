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
