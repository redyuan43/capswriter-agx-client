const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const rebuildScript = fs.readFileSync(
  path.join(root, "scripts/rebuild-uiohook-native.js"),
  "utf8"
);
const appImageVerifier = fs.readFileSync(
  path.join(root, "scripts/verify-appimage-native-arch.sh"),
  "utf8"
);

test("Linux packaging does not rebuild loaded native modules in place", () => {
  assert.match(packageJson.scripts["build:linux:agx-client"], /--config\.npmRebuild=false/);
  assert.match(rebuildScript, /mkdtempSync/);
  assert.match(rebuildScript, /fs\.cpSync\(uiohookDir, isolatedDir/);
  assert.match(rebuildScript, /fs\.renameSync\(stagedModule, destinationModule\)/);
  assert.doesNotMatch(rebuildScript, /cwd: uiohookDir/);
});

test("AppImage verification covers both packaged native modules", () => {
  assert.match(appImageVerifier, /uiohook-napi\/build\/Release/);
  assert.match(appImageVerifier, /better-sqlite3\/build\/Release/);
});
