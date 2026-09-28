// 独立 Electron 窗口验证设置页；只使用临时词库、模拟凭据和模型，不连接云端。
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '..');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-speech-ui-'));
app.setPath('userData', path.join(folder, 'electron'));
app.setName('CapsWriter Speech QA');

app.whenReady().then(async () => {
  const esbuild = require(require.resolve('esbuild', { paths: [path.dirname(require.resolve('vite/package.json'))] }));
  const { HotWordsStore } = require('../src/platform/electron/hotWordsStore');
  const { TextPolisher } = require('../src/platform/electron/textPolish');
  fs.writeFileSync(path.join(folder, 'hot-words.txt'), 'Qwen|5\n');
  const words = new HotWordsStore({ dataDirectory: folder });
  const settings = new Map();
  let configured = {};
  const polisher = new TextPolisher({ dataDirectory: folder, hotWordsStore: words, longFormatter: {
    format: async (text, options) => ({ text, changed: false, model: 'glm-4.7-flash', thinking: false, mode: options.mode, elapsed_ms: 1 }),
  } });
  const methods = {
    getSetting: (key, fallback) => settings.get(key) ?? fallback,
    setSetting: (key, value) => { settings.set(key, value); return true; },
    getProviderStatus: () => ({ configured, secureStorage: true }),
    saveProviderSecrets: (patch) => { configured = Object.fromEntries(Object.keys(patch).map((k) => [k, true])); return methods.getProviderStatus(); },
    getHotWords: () => ({ ...words.snapshot(), count: words.entries.length, dictionary: words.entries, candidates: words.candidates }),
    updateHotWord: (entry) => words.update(entry),
    proposeHotWords: (terms) => words.propose(terms),
    readClipboard: () => ({ success: true, text: '示例候选词' }),
    activateAsrConnectionProfile: (id) => { settings.set('profile', id); },
    polishText: (text, options) => polisher.polish(text, options),
    cancelTextPolish: () => polisher.dispose(),
  };
  ipcMain.handle('speech-qa', (_event, name, args) => methods[name](...args));
  const preload = path.join(folder, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',Object.fromEntries(${JSON.stringify(Object.keys(methods))}.map(name=>[name,(...args)=>ipcRenderer.invoke('speech-qa',name,args)])));`);
  await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Panel from './src/components/SpeechSettingsPanel.jsx';createRoot(document.getElementById('root')).render(<Panel/>);`, resolveDir: root, loader: 'jsx' },
    bundle: true, jsx: 'automatic', outfile: path.join(folder, 'ui.js'), define: { 'process.env.NODE_ENV': '"production"' } });
  const assets = path.join(root, 'src/dist/assets');
  const css = fs.readdirSync(assets).filter((s) => /^index-.*\.css$/.test(s)).map((s) => `<link rel="stylesheet" href="${pathToFileURL(path.join(assets, s))}">`).join('');
  fs.writeFileSync(path.join(folder, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">${css}</head><body style="background:#f3f4f6;padding:24px"><div id="root"></div><script src="./ui.js"></script></body></html>`);
  const win = new BrowserWindow({ width: 680, height: 1000, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(folder, 'index.html'));
  win.showInactive();
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (code) => {
    const start = Date.now();
    while (!(await evaluate(code))) { if (Date.now() - start > 4000) throw new Error(`界面等待超时：${code}`); await new Promise((r) => setTimeout(r, 30)); }
  };
  await waitFor(`!!document.querySelector('select[aria-label="处理模式"]')`);
  await evaluate(`(()=>{const s=document.querySelector('select');s.value='prompt';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.body.innerText.includes('约 800 字符')`);
  assert.equal(settings.get('text_processing_mode'), 'prompt');
  await evaluate(`document.querySelectorAll('details').forEach(d=>d.open=true)`);
  const type = (label, text) => evaluate(`(()=>{const input=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith(${JSON.stringify(label)})).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await type('词条', 'TestTerm'); await type('明确别名', '测试词,测式词'); await type('排除上下文', '示例,样例');
  await evaluate(`([...document.querySelectorAll('button')].find(b=>b.textContent==='保存词条')).click()`);
  await waitFor(`document.body.innerText.includes('词条已保存')`);
  assert.deepEqual(words.entries.find((e) => e.term === 'TestTerm').aliases, ['测试词', '测式词']);
  await evaluate(`([...document.querySelectorAll('button')].find(b=>b.textContent==='从剪贴板提取候选词')).click()`);
  await waitFor(`document.body.innerText.includes('示例候选词')`);
  assert.equal(words.snapshot().hotword.includes('示例候选词'), false);
  await evaluate(`(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'请使用测试词。');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`([...document.querySelectorAll('button')].find(b=>b.textContent==='预览')).click()`);
  await waitFor(`document.body.innerText.includes('请使用TestTerm。')`);
  assert.equal(errors.length, 0, errors.join('\n'));
  const output = path.join(root, 'artifacts/asr-review'); fs.mkdirSync(output, { recursive: true });
  await evaluate(`document.querySelectorAll('details')[0].open=false`);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const screenshot = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, 'speech-settings.png'), screenshot.toPNG());
  const report = { modeSwitch: true, aliasEditing: true, candidateConfirmation: true, preview: true, consoleErrors: errors };
  fs.writeFileSync(path.join(output, 'ui-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  win.destroy(); polisher.dispose(); app.quit();
}).catch((error) => { console.error(error.message); app.exit(1); });

app.on('will-quit', () => fs.rmSync(folder, { recursive: true, force: true }));
