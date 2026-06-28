"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 23333;
const SERVER_PORTS = Array.from({ length: 5 }, (_, index) => DEFAULT_PORT + index);
const RUNTIME_CONFIG_PATH = path.join(os.homedir(), ".clawd", "runtime.json");

class MiniCPMVoiceBridge {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.timeoutMs = Number(options.timeoutMs) || 2500;
  }

  async submitVoice(text, options = {}) {
    const prompt = String(text || "").trim();
    if (!prompt) {
      throw new Error("没有识别到语音内容");
    }

    const payload = {
      text: prompt,
      source: options.source || "capswriter",
      created_at: new Date().toISOString(),
    };
    let lastError = null;
    for (const port of this.getCandidatePorts()) {
      try {
        return await this.postJson(port, "/voice/submit", payload);
      } catch (error) {
        lastError = error;
      }
    }

    const detail = lastError && lastError.message ? `：${lastError.message}` : "";
    throw new Error(`MiniCPM 桌宠未运行或未启用语音入口${detail}`);
  }

  async interruptVoice() {
    let lastError = null;
    for (const port of this.getCandidatePorts()) {
      try {
        return await this.postJson(port, "/voice/interrupt", {
          source: "capswriter",
          created_at: new Date().toISOString(),
        });
      } catch (error) {
        lastError = error;
      }
    }

    const detail = lastError && lastError.message ? `：${lastError.message}` : "";
    throw new Error(`MiniCPM 桌宠未运行或未启用语音中断入口${detail}`);
  }

  getCandidatePorts() {
    const ports = [];
    const seen = new Set();
    const add = (value) => {
      const port = Number(value);
      if (!Number.isInteger(port) || !SERVER_PORTS.includes(port) || seen.has(port)) return;
      seen.add(port);
      ports.push(port);
    };

    add(this.readRuntimePort());
    SERVER_PORTS.forEach(add);
    return ports;
  }

  readRuntimePort() {
    try {
      const raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
      return raw && raw.port;
    } catch {
      return null;
    }
  }

  postJson(port, pathname, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = http.request({
        host: DEFAULT_HOST,
        port,
        path: pathname,
        method: "POST",
        timeout: this.timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => {
          let data = {};
          try {
            data = responseBody ? JSON.parse(responseBody) : {};
          } catch {
            data = { raw: responseBody };
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && data.ok !== false) {
            resolve({ success: true, port, ...data });
            return;
          }
          reject(new Error(data.error || `HTTP ${res.statusCode}`));
        });
      });

      req.on("timeout", () => {
        req.destroy(new Error(`timeout after ${this.timeoutMs}ms`));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = MiniCPMVoiceBridge;
