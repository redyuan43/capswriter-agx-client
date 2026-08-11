import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Keyboard,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import CardputerMappingEditor from "./CardputerMappingEditor";

const REFRESH_INTERVAL_MS = 4000;

function StatusBadge({ active, children }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
      active
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-gray-200 bg-gray-100 text-gray-600"
    }`}>
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-gray-400"}`} />
      {children}
    </span>
  );
}

function ActionButton({ icon: Icon, children, onClick, disabled, tone = "default" }) {
  const toneClass = tone === "danger"
    ? "border-red-200 text-red-700 hover:bg-red-50"
    : "border-gray-200 text-gray-700 hover:bg-gray-50";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}

export default function KnobMapperPanel() {
  const [status, setStatus] = useState(null);
  const [devices, setDevices] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.getKnobMapperStatus) return;
    try {
      const next = await window.electronAPI.getKnobMapperStatus();
      setStatus(next);
      if (!next?.supported) setDevices("");
    } catch (error) {
      toast.error("读取设备映射状态失败", { description: error?.message || String(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runAction = async (action, successMessage) => {
    setBusy(true);
    try {
      const result = await action();
      if (result?.success === false) {
        throw new Error(result.error || "操作失败");
      }
      toast.success(successMessage);
      await refresh();
    } catch (error) {
      toast.error("设备映射操作失败", { description: error?.message || String(error) });
    } finally {
      setBusy(false);
    }
  };

  const scanDevices = async () => {
    setBusy(true);
    try {
      const result = await window.electronAPI.listKnobMapperDevices();
      if (!result?.success) throw new Error(result?.error || "设备扫描失败");
      setDevices(result.output || "没有返回设备信息");
      toast.success("设备扫描完成");
    } catch (error) {
      toast.error("设备扫描失败", { description: error?.message || String(error) });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!status?.supported) {
    return (
      <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
        <div className="mx-auto max-w-2xl rounded-xl border border-gray-200 bg-white p-6">
          <div className="flex items-center gap-3 text-gray-900">
            <Keyboard className="h-5 w-5 text-blue-600" />
            <h2 className="text-xl font-semibold">设备映射</h2>
          </div>
          <p className="mt-3 text-sm text-gray-600">
            已验证的 evdev/uinput 设备映射仅支持 Linux。
          </p>
        </div>
      </div>
    );
  }

  const mappings = status.mappings || [];
  const running = Boolean(status.running);

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50">
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-gray-900">
              <Keyboard className="h-5 w-5 text-blue-600" />
              <h2 className="text-xl font-semibold">设备映射</h2>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              使用已经验证过的键值和动作，不修改硬件原始事件。
            </p>
          </div>
          <ActionButton icon={RefreshCw} onClick={refresh} disabled={busy}>
            刷新
          </ActionButton>
        </div>

        <CardputerMappingEditor />

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-gray-900">映射服务</h3>
              <p className="mt-1 text-xs text-gray-500">
                {status.pid ? `进程 PID ${status.pid}` : "当前没有运行中的映射进程"}
              </p>
            </div>
            <StatusBadge active={running}>{running ? "运行中" : "已停止"}</StatusBadge>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <ActionButton
              icon={Play}
              onClick={() => runAction(window.electronAPI.startKnobMapper, "设备映射已启动")}
              disabled={busy || running}
            >
              启动
            </ActionButton>
            <ActionButton
              icon={Square}
              onClick={() => runAction(window.electronAPI.stopKnobMapper, "设备映射已停止")}
              disabled={busy || !running}
              tone="danger"
            >
              停止
            </ActionButton>
            <ActionButton
              icon={RotateCcw}
              onClick={() => runAction(window.electronAPI.restartKnobMapper, "设备映射已重启")}
              disabled={busy}
            >
              重启
            </ActionButton>
            <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={status.enabled !== false}
                disabled={busy}
                onChange={(event) => runAction(
                  () => window.electronAPI.setKnobMapperEnabled(event.target.checked),
                  event.target.checked ? "已启用开机启动" : "已禁用开机启动",
                )}
              />
              开机自动运行
            </label>
          </div>
          {status.lastError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {status.lastError}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900">已验证设备和键值</h3>
              <p className="mt-1 text-xs text-gray-500">设备名称使用稳定匹配，避免依赖变化的 event 编号。</p>
            </div>
            <button
              type="button"
              onClick={scanDevices}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              扫描设备
            </button>
          </div>
          {mappings.map((mapping) => (
            <div key={mapping.id} className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-gray-900">{mapping.name}</h4>
                  <p className="mt-1 text-xs text-gray-500">{mapping.device}</p>
                </div>
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="border-b border-gray-200 text-xs text-gray-500">
                    <tr>
                      <th className="pb-2 pr-4 font-medium">物理动作</th>
                      <th className="pb-2 pr-4 font-medium">设备键值</th>
                      <th className="pb-2 font-medium">输出动作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {mapping.entries.map(([action, key, output]) => (
                      <tr key={`${mapping.id}-${action}`}>
                        <td className="py-2 pr-4 text-gray-700">{action}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-blue-700">{key}</td>
                        <td className="py-2 text-gray-600">{output}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-center gap-2">
            {devices ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-gray-400" />}
            <h3 className="font-semibold text-gray-900">最近设备扫描</h3>
          </div>
          <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-gray-950 p-3 text-xs leading-5 text-gray-200">
            {devices || "点击“扫描设备”查看当前设备匹配结果。"}
          </pre>
        </section>
      </div>
    </div>
  );
}
