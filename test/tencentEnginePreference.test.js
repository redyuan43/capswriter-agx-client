const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TencentQuota } = require('../src/helpers/tencentQuota');
const { TencentDirectBridge } = require('../src/helpers/tencentDirectBridge');
const { STANDARD, MODEL2 } = require('../src/helpers/tencentProvider');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-engine-preference-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('默认自动选择仍优先已确认的免费额度，并保留会话预留', t => {
  const quota = new TencentQuota({ dataDirectory: directory(t) });
  quota.observe(180);
  assert.equal(quota.status().realtime_engine_preference, 'auto');
  assert.equal(quota.begin('first'), STANDARD);
  assert.equal(quota.begin('second'), MODEL2);
  quota.record('first', 60, 'completed');
  assert.equal(quota.status().quota.remaining_seconds, 120);
  assert.equal(quota.status().engine, STANDARD);
});

test('显式选择2.0即使免费额度充足也生效，记账不扣经典版额度', t => {
  const quota = new TencentQuota({ dataDirectory: directory(t), getRealtimeEngine: () => MODEL2 });
  quota.observe(500);
  const status = quota.status();
  assert.equal(status.engine, MODEL2);
  assert.equal(status.realtime_engine_preference, MODEL2);
  assert.match(status.quota.message, /已选择.*2\.0.*付费/);
  assert.equal(quota.begin('paid'), MODEL2);
  quota.record('paid', 61, 'completed');
  assert.deepEqual(quota.status().usage_seconds, { standard: 0, model2: 61, flash: 0 });
  assert.equal(quota.status().quota.remaining_seconds, 500);
});

test('每次读取最新选择，切回自动只影响新会话，不重写使用中的引擎', t => {
  let preference = 'auto';
  const quota = new TencentQuota({ dataDirectory: directory(t), getRealtimeEngine: () => preference });
  quota.observe(600);
  assert.equal(quota.begin('existing-free'), STANDARD);
  preference = MODEL2;
  assert.equal(quota.status().engine, MODEL2);
  assert.equal(quota.begin('existing-paid'), MODEL2);
  preference = 'auto';
  assert.equal(quota.status().realtime_engine_preference, 'auto');
  assert.equal(quota.begin('new-free'), STANDARD);
  assert.equal(quota.state.sessions['existing-free'].engine, STANDARD);
  assert.equal(quota.state.sessions['existing-paid'].engine, MODEL2);
  quota.record('existing-free', 11, 'completed');
  quota.record('existing-paid', 22, 'completed');
  assert.deepEqual(quota.status().usage_seconds, { standard: 11, model2: 22, flash: 0 });
  assert.equal(quota.status().quota.remaining_seconds, 589);
});

test('未支持的设置按自动处理，不会意外强制付费模式', t => {
  let preference;
  const quota = new TencentQuota({ dataDirectory: directory(t), getRealtimeEngine: () => preference });
  quota.observe(600);
  for (preference of [undefined, null, '', 'auto', STANDARD, 'MODEL2', `${MODEL2} `, true, 100, {}]) {
    assert.equal(quota.status().realtime_engine_preference, 'auto');
    assert.equal(quota.status().engine, STANDARD);
  }
});

test('显式文件引擎及4004回退选择不被实时偏好覆盖', t => {
  let preference = MODEL2;
  const quota = new TencentQuota({ dataDirectory: directory(t), getRealtimeEngine: () => preference });
  quota.observe(600);
  assert.equal(quota.begin('file', 'flash_16k_zh'), 'flash_16k_zh');
  quota.record('file', 30, 'completed');
  preference = 'auto';
  assert.equal(quota.begin('fallback', MODEL2), MODEL2);
  quota.exhausted();
  assert.equal(quota.status().realtime_engine_preference, 'auto');
  assert.equal(quota.status().engine, MODEL2);
  assert.equal(quota.status().quota.remaining_seconds, 0);
  assert.deepEqual(quota.status().usage_seconds, { standard: 0, model2: 0, flash: 30 });
});

test('直连桥将动态设置传给默认额度实例，保留外部注入额度实例', t => {
  let preference = MODEL2;
  const dataDirectory = directory(t);
  const bridge = new TencentDirectBridge({ dataDirectory, provider: {}, getRealtimeEngine: () => preference });
  bridge.quota.observe(600);
  assert.equal(bridge.quota.status().engine, MODEL2);
  preference = 'auto';
  assert.equal(bridge.quota.status().engine, STANDARD);
  const injected = { status: () => ({ engine: STANDARD }) };
  const other = new TencentDirectBridge({ dataDirectory, provider: {}, quota: injected, getRealtimeEngine: () => MODEL2 });
  assert.equal(other.quota, injected);
});
