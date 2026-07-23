"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

if (process.platform !== "linux") {
  throw new Error("uiohook native rebuild is only supported on Linux.");
}

const uiohookDir = path.dirname(require.resolve("uiohook-napi/package.json"));
const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");
const electronVersion = require("electron/package.json").version;
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
    cwd: uiohookDir,
    env: { ...process.env, npm_config_build_from_source: "true" },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
