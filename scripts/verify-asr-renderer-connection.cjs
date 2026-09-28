// 验证真实 Electron file:// 页面的 HTTP/WS 来源；不采集音频、不调用云端。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { TencentDirectBridge } = require('../src/helpers/tencentDirectBridge');
let bridge, folder;
app.whenReady().then(async () => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-renderer-asr-'));
  bridge = new TencentDirectBridge({ dataDirectory: folder,
    provider: { credentials: () => ({}), resources: async () => [], realtimeUrl: () => { throw new Error('禁止云端连接'); } },
    hotWordsStore: { snapshot: () => ({ hotword: '', version: 'test' }) } });
  const connection = await bridge.connection();
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const file = path.join(folder, 'index.html');
  fs.writeFileSync(file, '<!doctype html><title>ASR connection check</title>');
  await win.loadFile(file);
  const result = await win.webContents.executeJavaScript(`(async()=>{
    const status=await fetch(${JSON.stringify(connection.httpBaseUrl + '/api/status')}).then(r=>r.status);
    const opened=await new Promise((resolve,reject)=>{
      const ws=new WebSocket(${JSON.stringify(connection.url)});
      const timer=setTimeout(()=>{ws.close();reject(new Error('连接超时'))},3000);
      ws.onopen=()=>{clearTimeout(timer);ws.close();resolve(true)};
      ws.onerror=()=>{clearTimeout(timer);reject(new Error('WebSocket 连接失败'))};
    });return {status,opened};
  })()`);
  assert.deepEqual(result, { status: 200, opened: true });
  console.log(JSON.stringify({ rendererOrigin: 'file://', ...result, cloudRequests: 0 }));
  win.destroy();
}).catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  bridge?.dispose();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
