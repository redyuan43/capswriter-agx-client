const { existsSync } = require("fs");
const { spawnSync } = require("child_process");
const { join } = require("path");

if (process.platform !== "linux" || process.arch !== "arm64") {
  console.error("This verification must run on Linux arm64.");
  process.exit(1);
}

const modulePath = join(
  __dirname,
  "..",
  "node_modules",
  "uiohook-napi",
  "build",
  "Release",
  "uiohook_napi.node"
);

if (!existsSync(modulePath)) {
  console.error(`Missing rebuilt uiohook module: ${modulePath}`);
  process.exit(1);
}

const readelf = spawnSync("readelf", ["-h", modulePath], { encoding: "utf8" });
if (readelf.status !== 0 || !readelf.stdout.includes("Machine:") || !readelf.stdout.includes("AArch64")) {
  console.error(`uiohook module is not AArch64:\n${readelf.stdout}${readelf.stderr}`);
  process.exit(1);
}

try {
  require("uiohook-napi");
} catch (error) {
  console.error(`uiohook module failed to load:\n${error.stack || error}`);
  process.exit(1);
}

console.log(`Verified Linux arm64 uiohook module: ${modulePath}`);
