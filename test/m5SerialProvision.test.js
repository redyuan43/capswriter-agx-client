/**
 * M5 串口配网协议回归测试
 *
 * 钉住三类问题：
 *  1. 协议格式：VSPROV 行必须能被固件 cJSON 解析；bridge id 缺省用 lan-<host>。
 *  2. 应答解析：固件日志可能与应答交错在同一 CDC，只有行前缀匹配才认。
 *  3. 读循环：假 fs 模拟 EAGAIN/分片到达，确认分片拼接与超时返回 null。
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  buildProvisionLine,
  parseResponseLine,
  pickPrimaryLanAddress,
  listEspressifPorts,
  drainSerial,
  openNonBlocking,
} = require("../src/helpers/m5SerialProvision");

test("buildProvisionLine: 最小 payload 只含 ssid", () => {
  const line = buildProvisionLine({ ssid: "HANYUAN" });
  assert.ok(line.startsWith("VSPROV "));
  const body = JSON.parse(line.slice("VSPROV ".length));
  assert.equal(body.ssid, "HANYUAN");
  assert.equal(body.password, "");
  assert.equal(body.apply, true);
  assert.equal(body.bridge, undefined);
});

test("buildProvisionLine: bridge host 自动补 id 与默认端口", () => {
  const line = buildProvisionLine({
    ssid: "HANYUAN",
    password: "secret",
    bridge: { host: "192.168.100.151" },
  });
  const body = JSON.parse(line.slice("VSPROV ".length));
  assert.equal(body.bridge.id, "lan-192-168-100-151");
  assert.equal(body.bridge.host, "192.168.100.151");
  assert.equal(body.bridge.port, 8765);
  assert.equal(body.password, "secret");
});

test("buildProvisionLine: 拒绝空 ssid 与超长字段", () => {
  assert.throws(() => buildProvisionLine({ ssid: "" }));
  assert.throws(() => buildProvisionLine({ ssid: "x".repeat(33) }));
  assert.throws(() => buildProvisionLine({ ssid: "ok", password: "p".repeat(65) }));
});

test("buildProvisionLine: apply=false 会传给固件", () => {
  const body = JSON.parse(
    buildProvisionLine({ ssid: "S", apply: false }).slice("VSPROV ".length)
  );
  assert.equal(body.apply, false);
});

test("parseResponseLine: 只认已知前缀", () => {
  const ok = parseResponseLine(
    'VSPROV_OK {"connected":true,"ip":"192.168.100.149","profiles_stored":2}'
  );
  assert.equal(ok.kind, "VSPROV_OK");
  assert.equal(ok.data.connected, true);

  const err = parseResponseLine('VSPROV_ERR {"error":"bad_json"}');
  assert.equal(err.kind, "VSPROV_ERR");
  assert.equal(err.data.error, "bad_json");

  const status = parseResponseLine('VSOK {"connected":false}');
  assert.equal(status.kind, "VSOK");

  assert.equal(parseResponseLine("ESP_LOG noise here"), null);
  assert.equal(parseResponseLine(""), null);
  assert.equal(parseResponseLine(null), null);
});

test("parseResponseLine: 坏 JSON 仍返回 kind，data 为 null", () => {
  const parsed = parseResponseLine("VSPROV_OK {broken");
  assert.equal(parsed.kind, "VSPROV_OK");
  assert.equal(parsed.data, null);
});

test("pickPrimaryLanAddress: 跳过 lo/tailscale/docker，取第一个真实网段", () => {
  const picked = pickPrimaryLanAddress({
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    tailscale0: [{ family: "IPv4", address: "100.67.179.113", internal: false }],
    "br-ab425eec9d91": [{ family: "IPv4", address: "172.17.0.1", internal: false }],
    docker0: [{ family: "IPv4", address: "172.18.0.1", internal: false }],
    eno1: [{ family: "IPv4", address: "192.168.100.109", internal: false }],
  });
  assert.equal(picked.name, "eno1");
  assert.equal(picked.address, "192.168.100.109");
});

test("listEspressifPorts: 只收 Espressif USB-JTAG 条目，目录缺失返回空", () => {
  const fakeFs = {
    readdirSync: (dir) => {
      assert.equal(dir, "/dev/serial/by-id");
      return [
        "usb-Espressif_USB_JTAG_serial_debug_unit_84FC26xxxx-if00",
        "usb-1a86_USB_Serial-if00-port0",
      ];
    },
  };
  const ports = listEspressifPorts(fakeFs);
  assert.equal(ports.length, 1);
  assert.ok(ports[0].path.endsWith("usb-Espressif_USB_JTAG_serial_debug_unit_84FC26xxxx-if00"));

  const missingFs = { readdirSync: () => { throw new Error("ENOENT"); } };
  assert.deepEqual(listEspressifPorts(missingFs), []);
});

test("drainSerial: 分片 + EAGAIN + 日志噪声下仍能取到应答", () => {
  const chunks = [
    null, // EAGAIN
    Buffer.from("I (1234) vibe_wifi: loaded 2 profile(s)\nVSP"),
    Buffer.from("ROV_OK {\"connected\":true,\"ip\":\"192.168.100"),
    null,
    Buffer.from(".149\"}\n"),
  ];
  let readCalls = 0;
  const fakeFs = {
    readSync: (fd, buffer, offset, length) => {
      const chunk = chunks[Math.min(readCalls++, chunks.length - 1)];
      if (!chunk) {
        const error = new Error("Resource temporarily unavailable");
        error.code = "EAGAIN";
        throw error;
      }
      chunk.copy(buffer, offset);
      return chunk.length;
    },
  };
  const sleeps = [];
  const saved = drainSerial(1, fakeFs, {
    expectPrefixes: ["VSPROV_OK ", "VSPROV_ERR "],
    deadline: Date.now() + 5000,
    sleepFn: (ms) => sleeps.push(ms),
  });
  assert.ok(saved, "应该匹配到应答");
  assert.equal(saved.kind, "VSPROV_OK");
  assert.equal(saved.data.connected, true);
  assert.equal(saved.data.ip, "192.168.100.149");
});

test("drainSerial: 超时无应答返回 null（旧固件场景）", () => {
  const fakeFs = {
    readSync: () => {
      const error = new Error("Resource temporarily unavailable");
      error.code = "EAGAIN";
      throw error;
    },
  };
  const matched = drainSerial(1, fakeFs, {
    expectPrefixes: ["VSOK "],
    deadline: Date.now() + 200,
    sleepFn: () => {},
  });
  assert.equal(matched, null);
});

test("openNonBlocking: 打不开时抛可读错误", () => {
  const fakeFs = {
    openSync: () => {
      throw new Error("ENOENT");
    },
  };
  assert.throws(() => openNonBlocking("/dev/ttyACM0", fakeFs), /无法打开串口/);
});
