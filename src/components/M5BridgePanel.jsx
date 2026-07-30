import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bluetooth,
  Cable,
  ChevronDown,
  Loader2,
  Radio,
  RefreshCw,
  Router,
  Save,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";

const BRIDGE_BASE_URL = "http://127.0.0.1:8765";
const REFRESH_INTERVAL_MS = 3000;

async function requestJson(path, options) {
  const response = await fetch(`${BRIDGE_BASE_URL}${path}`, options);
  if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
  return response.json();
}

function statusClass(active) {
  return active
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : "bg-gray-100 text-gray-600 border-gray-200";
}

function triggerLabel(triggerId, route) {
  if (triggerId === "keyboard") return "电脑键盘";
  if (triggerId.startsWith("minijoy_bt")) return route?.trigger_name || "MiniJoy 蓝牙";
  if (triggerId.startsWith("wifi:")) return route?.trigger_name || `Wi-Fi 设备 ${triggerId.slice(5)}`;
  return route?.trigger_name || triggerId;
}

function StatusBadge({ active, children }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${statusClass(active)}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-gray-400"}`} />
      {children}
    </span>
  );
}

export default function M5BridgePanel() {
  const [bridgeState, setBridgeState] = useState(null);
  const [routing, setRouting] = useState(null);
  const [bluetoothDevices, setBluetoothDevices] = useState([]);
  const [wifiDevices, setWifiDevices] = useState([]);
  const [selections, setSelections] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirtyRef = useRef(false);

  const refresh = useCallback(async ({ resetSelections = false } = {}) => {
    try {
      const [statePayload, routingPayload, bluetoothPayload, devicesPayload] = await Promise.all([
        requestJson("/state"),
        requestJson("/audio/routing"),
        requestJson("/bluetooth/devices"),
        requestJson("/devices"),
      ]);
      const nextRouting = routingPayload.routing || {};
      setBridgeState(statePayload);
      setRouting(nextRouting);
      setBluetoothDevices(bluetoothPayload.devices || []);
      setWifiDevices(devicesPayload.devices || []);
      if (resetSelections || !dirtyRef.current) {
        setSelections(Object.fromEntries(
          Object.entries(nextRouting.routes || {}).map(([triggerId, route]) => [
            triggerId,
            route.source_id || "",
          ])
        ));
        dirtyRef.current = false;
      }
      setError("");
    } catch (requestError) {
      setError(requestError?.message || String(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh({ resetSelections: true });
    const timer = window.setInterval(() => refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const saveRoutes = async () => {
    setSaving(true);
    try {
      await requestJson("/audio/routing", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ version: 2, routes: selections }),
      });
      dirtyRef.current = false;
      await refresh({ resetSelections: true });
      toast.success("M5 音频路由已保存");
    } catch (saveError) {
      toast.error("保存路由失败", { description: saveError?.message || String(saveError) });
    } finally {
      setSaving(false);
    }
  };

  const routes = Object.entries(routing?.routes || {});
  const sources = (routing?.sources || []).filter(
    (source) => source.online && source.transport_available !== false
  );
  const inactiveRoutes = Object.values(routing?.inactive_routes || {});
  const connectedBluetooth = bluetoothDevices.filter((device) => device.connected);
  const knownBluetooth = bluetoothDevices.filter((device) => !device.connected);
  const bluetooth = bridgeState?.bluetooth;
  const bridgeReady = Boolean(bluetooth?.ready);

  return (
    <div className="flex-1 overflow-y-auto min-h-0 bg-gray-50">
      <div className="max-w-4xl mx-auto p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-gray-900">
              <Radio className="h-5 w-5 text-blue-600" />
              <h2 className="text-xl font-semibold chinese-title">CapsWriter M5 Bridge</h2>
            </div>
            <p className="mt-1 text-sm text-gray-500">仅展示当前在线、已连接且可用的设备状态。</p>
          </div>
          <button
            type="button"
            onClick={() => refresh({ resetSelections: !dirtyRef.current })}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Bridge 暂不可用：{error}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-center gap-2 text-sm text-gray-500"><Router className="h-4 w-4" />桥接服务</div>
            <div className="mt-3"><StatusBadge active={!error}>{error ? "离线" : "运行中"}</StatusBadge></div>
            <p className="mt-2 truncate text-xs text-gray-400">{bridgeState?.bridge_id || "等待状态"}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-center gap-2 text-sm text-gray-500"><Bluetooth className="h-4 w-4" />目标蓝牙</div>
            <div className="mt-3"><StatusBadge active={Boolean(bluetooth?.pipewire_available)}>{bluetooth?.pipewire_available ? "已连接" : "未连接"}</StatusBadge></div>
            <p className="mt-2 text-xs text-gray-400">{bluetooth?.target_mac || "未配置"}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-center gap-2 text-sm text-gray-500"><Cable className="h-4 w-4" />音频采集</div>
            <div className="mt-3"><StatusBadge active={bridgeReady}>{bridgeReady ? "可用" : bluetooth?.audio_status === "unknown" ? "待验证" : "不可用"}</StatusBadge></div>
            <p className="mt-2 text-xs text-gray-400">{bluetooth?.source?.name || "未发现实时音源"}</p>
          </div>
        </div>

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-gray-900">实时音频路由</h3>
              <p className="mt-1 text-xs text-gray-500">失效的旧配置不会占用当前路由。</p>
            </div>
            <button
              type="button"
              onClick={saveRoutes}
              disabled={saving || routes.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存路由
            </button>
          </div>
          <div className="mt-4 space-y-3">
            {routes.map(([triggerId, route]) => (
              <label key={triggerId} className="grid gap-2 rounded-lg bg-gray-50 p-3 sm:grid-cols-[minmax(150px,1fr)_minmax(220px,2fr)] sm:items-center">
                <span className="text-sm text-gray-700">{triggerLabel(triggerId, route)}</span>
                <select
                  value={selections[triggerId] || ""}
                  onChange={(event) => {
                    dirtyRef.current = true;
                    setSelections((current) => ({ ...current, [triggerId]: event.target.value }));
                  }}
                  className="min-h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800"
                >
                  {sources.map((source) => (
                    <option key={source.source_id} value={source.source_id}>{source.name}</option>
                  ))}
                </select>
              </label>
            ))}
            {!loading && routes.length === 0 && <p className="text-sm text-gray-500">当前没有可用路由。</p>}
          </div>
        </section>

        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-2"><Bluetooth className="h-4 w-4 text-blue-600" /><h3 className="font-semibold text-gray-900">实时蓝牙设备</h3></div>
            <div className="mt-4 space-y-3">
              {connectedBluetooth.map((device) => (
                <div key={device.mac} className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
                  <div className="flex items-center justify-between gap-3"><span className="text-sm font-medium text-gray-900">{device.label}</span><StatusBadge active>已连接</StatusBadge></div>
                  <p className="mt-1 text-xs text-gray-500">{device.mac}</p>
                </div>
              ))}
              {!loading && connectedBluetooth.length === 0 && <p className="text-sm text-gray-500">当前没有已连接的 MiniJoy。</p>}
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-2"><Wifi className="h-4 w-4 text-blue-600" /><h3 className="font-semibold text-gray-900">实时 Wi-Fi 设备</h3></div>
            <div className="mt-4 space-y-3">
              {wifiDevices.map((device) => (
                <div key={device.device_id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center justify-between gap-3"><span className="text-sm font-medium text-gray-900">{device.firmware_name || device.device_id}</span><StatusBadge active>在线</StatusBadge></div>
                  <p className="mt-1 text-xs text-gray-500">{device.device_ip || device.client_ip} · {device.board || "M5"} · RSSI {device.wifi_rssi ?? "-"}</p>
                </div>
              ))}
              {!loading && wifiDevices.length === 0 && <p className="text-sm text-gray-500">当前没有在线 Wi-Fi 设备。</p>}
            </div>
          </section>
        </div>

        {(inactiveRoutes.length > 0 || knownBluetooth.length > 0) && (
          <details className="group rounded-xl border border-gray-200 bg-white p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-gray-600">
              历史与不可用配置
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-4 space-y-2 border-t border-gray-100 pt-4 text-xs text-gray-500">
              {inactiveRoutes.map((route) => (
                <p key={route.trigger_id}>{triggerLabel(route.trigger_id, route)} → {route.source?.name || route.source_id || "未配置"}（不可用）</p>
              ))}
              {knownBluetooth.map((device) => <p key={device.mac}>{device.label} · {device.mac}（未连接）</p>)}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
