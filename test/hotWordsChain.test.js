/**
 * 热词链路回归测试
 *
 * 背景：热词功能曾经「看着全都改好了、实际一次都没生效」——
 *  1. IPCHandlers 构造函数手工搬运 managers 属性时漏了 hotWordsStore，
 *     handler 拿不到 store，返回空表；
 *  2. 渲染层拿到空表后直接 return，不打日志不报错，全程静默；
 *  3. 后来补的「不再沉默」防御本身也是坏的：把 logger 当函数调用
 *     （LogManager 是 warn(message, data) 这种对象式 API），
 *     走到降级分支就抛 TypeError，日志依然写不出来。
 *
 * 本文件把这三件事分别钉住，避免再犯。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

/* ------------------------------------------------------------------ *
 * electron mock
 *
 * 必须在 require 任何 handler 模块之前装好：这些模块在顶层就
 * `const { ipcMain } = require("electron")` 并把解构结果当作默认参数，
 * 装晚了默认值就是 undefined，注册时直接抛错。
 * ------------------------------------------------------------------ */
const ipcHandlersByChannel = new Map();

function installElectronMock() {
  const electronMock = {
    ipcMain: {
      handle: (channel, fn) => ipcHandlersByChannel.set(channel, fn),
      on: () => {},
      once: () => {},
      removeHandler: () => {},
      removeAllListeners: () => {},
    },
    app: {
      getPath: () => os.tmpdir(),
      getAppPath: () => process.cwd(),
      on: () => {},
      isPackaged: false,
      getVersion: () => "0.0.0-test",
    },
    BrowserWindow: function BrowserWindow() {},
    shell: { openExternal: async () => {} },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    nativeTheme: { on: () => {} },
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === "electron") return electronMock;
    return originalLoad.call(this, request, ...rest);
  };
}

installElectronMock();

const { registerHotWordsHandlers } = require("../src/platform/electron/ipc/hotWordsHandlers");
const { HotWordsStore } = require("../src/platform/electron/hotWordsStore");
const IPCHandlers = require("../src/helpers/ipcHandlers");

/** 记录 handle() 注册了哪些 channel 的假 ipcMain */
function makeIpcRecorder() {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
}

/** 万用替身：任何属性访问都返回另一个替身，用来顶掉无关的 managers */
function anyStub() {
  const target = function stubTarget() {};
  return new Proxy(target, {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then") return undefined; // 别被当成 thenable
      return anyStub();
    },
    apply: () => anyStub(),
    construct: () => anyStub(),
  });
}

function makeTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotwords-test-"));
  return dir;
}

test("get-hot-words 把带权重的词表交给渲染层（非空且含 | 权重）", () => {
  delete process.env.CAPS_HOT_WORDS_FILE;
  const dir = makeTempDataDir();
  fs.writeFileSync(path.join(dir, "hot-words.txt"), "GitHub|11\nTailscale|8\n", "utf8");

  const store = new HotWordsStore({ dataDirectory: dir });
  const ipc = makeIpcRecorder();
  registerHotWordsHandlers({ hotWordsStore: store, logger: anyStub() }, ipc);

  const result = ipc.handlers.get("get-hot-words")();

  assert.equal(result.degraded, undefined, "正常路径不应报降级");
  assert.equal(result.count, 2);
  // 渲染层需要的是「词|权重」；只给纯词条会让服务端一律按权重 5 处理
  assert.match(result.hotword, /GitHub\|11/, "必须带上权重 11");
  assert.match(result.hotword, /Tailscale\|8/, "必须保留原权重 8");
  assert.ok(result.path.endsWith("hot-words.txt"), "应给出词表路径便于排查");
});

test("store 没接上时：返回 degraded、不抛错、并且日志真的写出来", () => {
  const warned = [];
  const ipc = makeIpcRecorder();
  const ctxWithoutStore = {
    logger: { warn: (message, data) => warned.push({ message, data }) },
  };

  registerHotWordsHandlers(ctxWithoutStore, ipc);

  let result;
  assert.doesNotThrow(() => {
    result = ipc.handlers.get("get-hot-words")();
    // ↑ 这里曾经抛 TypeError: ctx.logger is not a function
  }, "降级必须走返回值，不能靠抛异常");

  assert.equal(result.degraded, "store_unavailable");
  assert.equal(result.count, 0);
  assert.equal(
    warned.length,
    1,
    "降级必须留下日志——此前把 logger 当函数调用，日志根本没写出来",
  );
});

test("add-hot-words 在 store 缺失时同样返回 degraded 而不是抛错", () => {
  const warned = [];
  const ipc = makeIpcRecorder();
  registerHotWordsHandlers(
    { logger: { warn: (message, data) => warned.push({ message, data }) } },
    ipc,
  );

  let result;
  assert.doesNotThrow(() => {
    result = ipc.handlers.get("add-hot-words")(null, ["Foo"]);
  });
  assert.equal(result.degraded, "store_unavailable");
  assert.equal(result.added, 0);
});

test("IPCHandlers 构造函数必须把 hotWordsStore 搬到 this（否则热词静默失效）", () => {
  const sentinel = { marker: "hotWordsStore-sentinel" };
  const managers = new Proxy(
    { hotWordsStore: sentinel, logger: anyStub() },
    {
      get(target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
        return anyStub();
      },
    },
  );

  const instance = new IPCHandlers(managers);

  assert.equal(
    instance.hotWordsStore,
    sentinel,
    "IPCHandlers 漏搬 hotWordsStore —— ctx 上拿不到，热词会静默失效",
  );
  assert.ok(
    ipcHandlersByChannel.has("get-hot-words"),
    "注册链应当已经装好 get-hot-words",
  );
});
