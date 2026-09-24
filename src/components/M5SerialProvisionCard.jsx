import { useCallback, useEffect, useState } from "react";
import { Cable, Loader2, RefreshCw, Usb, Wifi } from "lucide-react";
import { toast } from "sonner";

function deviceSummary(device) {
  if (!device) return "未检测到设备";
  const status = device.provisionSupported
    ? "支持串口配网"
    : `固件不支持（${device.reason === "no_response" ? "旧固件" : "无应答"}）`;
  return `${device.id.replace("usb-Espressif_USB_JTAG_serial_debug_unit_", "").replace("-if00", "")} · ${status}`;
}

export default function M5SerialProvisionCard() {
  const [devices, setDevices] = useState(null);
  const [hostInfo, setHostInfo] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [result, setResult] = useState("");
  const [manual, setManual] = useState({ ssid: "", password: "" });
  const [showManual, setShowManual] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    setResult("");
    try {
      const [devicePayload, infoPayload] = await Promise.all([
        window.electronAPI.m5SerialListDevices(),
        window.electronAPI.m5SerialHostInfo(),
      ]);
      setDevices(devicePayload.devices || []);
      setHostInfo(infoPayload);
      const wifi = infoPayload.wifiProfile;
      if (wifi && wifi.available && wifi.ssid) {
        setManual((prev) => ({
          ...prev,
          ssid: prev.ssid || wifi.ssid,
          password: prev.password || (wifi.pskReadable ? wifi.password : ""),
        }));
      }
      setShowManual((prev) => {
        if (prev) return prev;
        const remembered = infoPayload.remembered;
        const hasAuto = wifi && wifi.available && wifi.pskReadable;
        return !hasAuto && !(remembered && remembered.password);
      });
    } catch (error) {
      setResult(`检测失败：${error.message}`);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    scan();
  }, [scan]);

  const provision = useCallback(async () => {
    setProvisioning(true);
    setResult("");
    try {
      const payload = {};
      if (manual.ssid) payload.ssid = manual.ssid;
      if (manual.password) payload.password = manual.password;
      const outcome = await window.electronAPI.m5SerialProvision(payload);
      if (outcome.success) {
        const r = outcome.result || {};
        const parts = [];
        parts.push(r.connected ? "✅ 已连上 WiFi" : "⚠️ 已写入 NVS，但设备暂未连上（检查密码/信号）");
        if (r.ip) parts.push(`IP: ${r.ip}`);
        if (r.ssid) parts.push(`SSID: ${r.ssid}`);
        if (r.bridge_written) parts.push("bridge 已指向本机");
        parts.push("历史配置：" + (r.profiles_stored ?? "?") + " 条");
        setResult(parts.join(" · "));
        toast.success("M5 配网完成");
      } else {
        setResult(`❌ ${outcome.error}`);
        toast.error(`配网失败：${outcome.error}`);
      }
    } catch (error) {
      setResult(`❌ ${error.message}`);
    } finally {
      setProvisioning(false);
    }
  }, [manual]);

  const primary = devices && devices[0];
  const bridgeTarget = hostInfo && hostInfo.bridgeTarget;
  const remembered = hostInfo && hostInfo.remembered;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Usb className="h-4 w-4 text-blue-600" />
          <h3 className="font-semibold text-gray-900">M5 串口配网</h3>
        </div>
        <button
          type="button"
          onClick={scan}
          disabled={scanning || provisioning}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`} />
          重新检测
        </button>
      </div>

      <p className="mt-2 text-xs text-gray-500">
        用 USB 线连接 M5 设备后，把它的 WiFi 改到与主机同一网络，并把 bridge 指向本机。
      </p>

      <div className="mt-4 space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <Cable className="h-4 w-4 text-gray-400" />
          <span className={devices && devices.length ? "text-gray-900" : "text-gray-500"}>
            {devices === null ? "检测中…" : deviceSummary(primary)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Wifi className="h-4 w-4 text-gray-400" />
          <span className="text-gray-700">
            {bridgeTarget
              ? `本机 bridge 目标：${bridgeTarget.host}:${bridgeTarget.port}（${bridgeTarget.iface}）`
              : "未找到本机局域网地址"}
          </span>
        </div>
        {remembered && (
          <p className="text-xs text-gray-500">
            已记住 WiFi 档案：{remembered.ssid}（下发时自动使用）
          </p>
        )}
      </div>

      {showManual && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <input
            value={manual.ssid}
            onChange={(event) => setManual((prev) => ({ ...prev, ssid: event.target.value }))}
            placeholder="WiFi 名称 (SSID)"
            className="h-10 min-w-0 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800"
          />
          <input
            value={manual.password}
            onChange={(event) => setManual((prev) => ({ ...prev, password: event.target.value }))}
            placeholder="WiFi 密码"
            type="password"
            className="h-10 min-w-0 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800"
          />
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={provision}
          disabled={scanning || provisioning || !primary}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {provisioning && <Loader2 className="h-4 w-4 animate-spin" />}
          {provisioning ? "配网中（最长 25 秒）…" : "下发配置到设备"}
        </button>
        {!showManual && (
          <button
            type="button"
            onClick={() => setShowManual(true)}
            className="text-xs text-gray-500 underline hover:text-gray-700"
          >
            手动填写 WiFi
          </button>
        )}
      </div>

      {result && (
        <p className="mt-3 rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-700">{result}</p>
      )}
    </section>
  );
}
