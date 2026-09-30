const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const diagnose = require('../src/helpers/m5SerialDiagnose');
const provision = require('../src/helpers/m5SerialProvision');

function eagain() {
  return Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
}

/** 造一个「提供若干数据块、随后一直 EAGAIN」的非阻塞 fd 桩。 */
function stubFd(chunks) {
  let index = 0;
  return {
    readSync: (_fd, buffer, _offset, length) => {
      if (index >= chunks.length) throw eagain();
      const chunk = Buffer.from(chunks[index], 'utf8');
      index += 1;
      const size = Math.min(chunk.length, length);
      chunk.copy(buffer, 0, 0, size);
      return size;
    },
  };
}

test('classify：错误行与协议应答分级', () => {
  assert.equal(diagnose.classify('E (1234) wifi: ERROR connect failed'), 'ERROR');
  assert.equal(diagnose.classify('brownout detected'), 'BROWNOUT');
  assert.equal(diagnose.classify('VSPROV_OK {"ssid":"x"}'), 'OK');
  assert.equal(diagnose.classify('VSPROV_ERR {"error":"psk"}'), 'ERR');
  assert.equal(diagnose.classify('I (1) boot: hello'), '');
});

test('readLines：按 LF 切行、去掉 CR、保留半行到下一次读取', () => {
  diagnose.resetLineBuffer();
  const lines = [];
  // fd 仍是数字（真实 fd 语义），非阻塞读取行为由 fsRef 桩提供
  const fd = 7;
  const first = diagnose.readLines(fd, {
    onData: (line) => lines.push(line),
    fsRef: stubFd(['VSPROV_OK {"a":1}\r\nhalf']),
  });
  assert.deepEqual(lines, ['VSPROV_OK {"a":1}']);
  assert.ok(first > 0);

  // 第二次读到剩余半行的后半段，应拼成一行
  diagnose.readLines(fd, {
    onData: (line) => lines.push(line),
    fsRef: stubFd(['-line\nnext\n']),
  });
  assert.deepEqual(lines, ['VSPROV_OK {"a":1}', 'half-line', 'next']);

  // resetLineBuffer 清掉残留半行
  diagnose.resetLineBuffer();
  diagnose.readLines(fd, { onData: (line) => lines.push(line), fsRef: stubFd(['boom\n']) });
  assert.deepEqual(lines.slice(-1), ['boom']);
});

test('resolvePort：显式端口存在则直接用，不存在则报错退出', () => {
  assert.equal(diagnose.resolvePort(process.execPath), process.execPath);

  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error('__process_exit__');
  };
  try {
    assert.throws(
      () => diagnose.resolvePort('/dev/definitely-not-exists'),
      /__process_exit__/
    );
  } finally {
    process.exit = originalExit;
  }
  assert.equal(exitCode, 1);
});

test('串口 I/O 复用配网模块实现，不再重复实现（M2 防回退）', () => {
  // 直接复用同一函数对象，保证诊断与配网认的是同一个端口集合
  assert.equal(diagnose.listEspressifPorts, provision.listEspressifPorts);

  const source = fs.readFileSync(
    path.join(__dirname, '../src/helpers/m5SerialDiagnose.js'),
    'utf8'
  );
  // 不得再自己 readdir 枚举、不得重复写 O_NONBLOCK 打开逻辑
  assert.doesNotMatch(source, /readdirSync/);
  assert.doesNotMatch(source, /O_NONBLOCK/);
  // 不得再出现静默吞异常（B4）
  assert.doesNotMatch(source, /catch\s*\{\s*(\/\*[^*]*\*\/)?\s*\}/);
});

test('重连退避有上限，且失败可见（不再空转刷屏）', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/helpers/m5SerialDiagnose.js'),
    'utf8'
  );
  assert.match(source, /Math\.min\(5000, 1000 \* attempt\)/);
  assert.match(source, /\[WARN\] 重连失败/);
});
