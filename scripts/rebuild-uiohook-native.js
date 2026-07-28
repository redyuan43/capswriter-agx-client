"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.platform !== "linux") {
  throw new Error("uiohook native rebuild is only supported on Linux.");
}

const uiohookDir = path.dirname(require.resolve("uiohook-napi/package.json"));
const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");
const electronVersion = require("electron/package.json").version;
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capswriter-uiohook-"));
const isolatedDir = path.join(workRoot, "uiohook-napi");

try {
  fs.cpSync(uiohookDir, isolatedDir, {
    recursive: true,
    filter(source) {
      return path.relative(uiohookDir, source).split(path.sep)[0] !== "build";
    },
  });
  const result = spawnSync(
    process.execPath,
    [
      nodeGyp,
      "rebuild",
      `--target=${electronVersion}`,
      `--arch=${process.arch}`,
      "--dist-url=https://electronjs.org/headers",
    ],
    {
      cwd: isolatedDir,
      env: { ...process.env, npm_config_build_from_source: "true" },
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  const sourceModule = path.join(isolatedDir, "build", "Release", "uiohook_napi.node");
  const destinationDir = path.join(uiohookDir, "build", "Release");
  const destinationModule = path.join(destinationDir, "uiohook_napi.node");
  const stagedModule = path.join(destinationDir, `.uiohook_napi.node.${process.pid}.tmp`);
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(sourceModule, stagedModule);
  fs.renameSync(stagedModule, destinationModule);
  console.log(`Atomically installed Electron ${electronVersion} uiohook module: ${destinationModule}`);
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
}
