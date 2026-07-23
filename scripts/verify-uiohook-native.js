"use strict";

const fs = require("node:fs");
const path = require("node:path");
const nodeGypBuild = require("node-gyp-build");

const MACHINES = new Map([
  ["x64", 0x3e],
  ["arm64", 0xb7],
]);

if (process.platform !== "linux" || !MACHINES.has(process.arch)) {
  throw new Error(`Unsupported native verification target: ${process.platform}/${process.arch}`);
}

const uiohookDir = path.dirname(require.resolve("uiohook-napi/package.json"));
const nativeModule = nodeGypBuild.resolve(uiohookDir);
const header = fs.readFileSync(nativeModule).subarray(0, 20);
const machine = header.readUInt16LE(18);

if (header.subarray(0, 4).toString("binary") !== "\x7fELF") {
  throw new Error(`uiohook native module is not ELF: ${nativeModule}`);
}
if (machine !== MACHINES.get(process.arch)) {
  throw new Error(`uiohook native module has ELF machine ${machine}, expected ${process.arch}: ${nativeModule}`);
}
if (!nativeModule.includes(`${path.sep}build${path.sep}Release${path.sep}`)) {
  throw new Error(`uiohook must resolve to the source-built module: ${nativeModule}`);
}

console.log(`Verified ${process.arch} uiohook native module: ${nativeModule}`);
