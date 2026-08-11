import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";

const DEVICE_ID = "28:84:85:76:25:c0";
const CONTROL_LABELS = {
  "cardputer.opt.tap": "Opt 单击",
  "cardputer.opt.double": "Opt 双击",
  "cardputer.opt.hold": "Opt 长按 / 松开",
  "cardputer.pointer.primary": "飞鼠主键（Space）",
  "cardputer.pointer.secondary": "飞鼠副键（Enter）",
  "cardputer.pointer.wheel_up": "滚轮向上",
  "cardputer.pointer.wheel_down": "滚轮向下",
};

const ACTION_OPTIONS = [
  ["none", "不执行动作"],
  ["pointer.button:left", "鼠标左键"],
  ["pointer.button:right", "鼠标右键"],
  ["pointer.button:middle", "鼠标中键"],
  ["pointer.button:back", "鼠标后退键"],
  ["pointer.button:forward", "鼠标前进键"],
  ["pointer.scroll:up", "原生滚轮向上"],
  ["pointer.scroll:down", "原生滚轮向下"],
  ["keyboard.chord", "键盘快捷键"],
  ["capswriter.dictation.hold", "电脑听写（按住）"],
  ["capswriter.dictation.toggle", "电脑听写（切换）"],
  ["capswriter.codex.hold", "Codex 语音（按住）"],
  ["capswriter.codex.toggle", "Codex 语音（切换）"],
  ["capswriter.cancel", "CapsWriter 取消"],
  ["capswriter.confirm", "CapsWriter 确认"],
  ["device.recording.toggle", "Cardputer 录音（切换）"],
  ["device.recording.hold", "Cardputer 录音（按住）"],
  ["device.legacy_double", "Cardputer 当前双击动作"],
];

function optionsForControl(id) {
  const pointerButton = id.includes("pointer.primary") || id.includes("pointer.secondary");
  const wheel = id.includes("wheel_");
  const hold = id === "cardputer.opt.hold" || pointerButton;
  return ACTION_OPTIONS.filter(([value]) => {
    if (value.startsWith("device.")) {
      if (id === "cardputer.opt.hold") return value === "device.recording.hold";
      if (id === "cardputer.opt.double") {
        return value === "device.recording.toggle" || value === "device.legacy_double";
      }
      return id === "cardputer.opt.tap" && value === "device.recording.toggle";
    }
    if (value.startsWith("pointer.button:")) return pointerButton;
    if (value.startsWith("pointer.scroll:")) return wheel;
    if (value.endsWith(".hold")) return hold;
    return true;
  });
}

const DOM_TO_LINUX = {
  ControlLeft: 29, ShiftLeft: 42, AltLeft: 56, MetaLeft: 125,
  ControlRight: 97, ShiftRight: 54, AltRight: 100, MetaRight: 126,
  Enter: 28, Escape: 1, Backspace: 14, Tab: 15, Space: 57,
  ArrowUp: 103, ArrowDown: 108, ArrowLeft: 105, ArrowRight: 106,
  Delete: 111, Home: 102, End: 107, PageUp: 104, PageDown: 109,
};
for (let index = 0; index < 26; index += 1) {
  DOM_TO_LINUX[`Key${String.fromCharCode(65 + index)}`] = [30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44][index];
}
for (let index = 0; index < 10; index += 1) {
  DOM_TO_LINUX[`Digit${index}`] = index === 0 ? 11 : index + 1;
}

function actionValue(action) {
  if (action?.type === "pointer.button") return `${action.type}:${action.button}`;
  if (action?.type === "pointer.scroll") return `${action.type}:${action.direction}`;
  return action?.type || "none";
}

function actionFromValue(value, previous = {}, stateful = false) {
  const [, detail] = value.split(":");
  if (value.startsWith("pointer.button:")) return { type: "pointer.button", button: detail };
  if (value.startsWith("pointer.scroll:")) return { type: "pointer.scroll", direction: detail };
  if (value === "keyboard.chord") return { type: value, behavior: stateful ? "hold" : "tap", keys: previous.keys || [29, 46] };
  return { type: value };
}

function ShortcutRecorder({ action, onChange }) {
  const [recording, setRecording] = useState(false);
  const label = action.keys?.length ? action.keys.join(" + ") : "未设置";
  return (
    <button
      type="button"
      className={`rounded-md border px-2 py-1 text-xs ${recording ? "border-blue-400 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600"}`}
      onClick={() => setRecording(true)}
      onKeyDown={(event) => {
        if (!recording) return;
        event.preventDefault();
        const keys = [
          event.ctrlKey ? 29 : null,
          event.shiftKey ? 42 : null,
          event.altKey ? 56 : null,
          event.metaKey ? 125 : null,
          DOM_TO_LINUX[event.code],
        ].filter((value, index, values) => value && values.indexOf(value) === index);
        if (keys.length) onChange({ ...action, keys });
        setRecording(false);
      }}
    >
      {recording ? "请按快捷键…" : `录制：${label}`}
    </button>
  );
}

function RangeRow({ label, value, min, max, step, onChange, left, right }) {
  return (
    <label className="block">
      <div className="flex justify-between text-xs text-gray-600">
        <span>{label}</span><span>{Number(value).toFixed(step < 1 ? 1 : 0)}</span>
      </div>
      <input className="mt-1 w-full" type="range" value={value} min={min} max={max} step={step}
        onChange={(event) => onChange(Number(event.target.value))} />
      <div className="flex justify-between text-[11px] text-gray-400"><span>{left}</span><span>{right}</span></div>
    </label>
  );
}

export default function CardputerMappingEditor() {
  const [status, setStatus] = useState(null);
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const refresh = useCallback(async () => {
    const next = await window.electronAPI.getDeviceMappingStatus(DEVICE_ID);
    setStatus(next);
    if (!dirty) setProfile(next.profile);
  }, [dirty]);

  useEffect(() => {
    refresh().catch((error) => toast.error("读取 Cardputer 映射失败", { description: error.message }));
    const timer = window.setInterval(() => refresh().catch(() => {}), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const controls = useMemo(() => Object.entries(profile?.controls || {}), [profile]);
  const updateControl = (id, action) => {
    setProfile((current) => ({ ...current, controls: { ...current.controls, [id]: action } }));
    setDirty(true);
  };
  const updateAirMouse = (key, value) => {
    setProfile((current) => ({ ...current, air_mouse: { ...current.air_mouse, [key]: value } }));
    setDirty(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      const result = await window.electronAPI.saveDeviceMappingProfile(DEVICE_ID, profile);
      setProfile(result.profile);
      setStatus((current) => ({ ...current, profile: result.profile, sync: result.sync }));
      setDirty(false);
      toast.success("Cardputer 映射已保存并等待设备应用");
    } catch (error) {
      toast.error("保存失败", { description: error.message });
    } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true);
    try {
      const result = await window.electronAPI.resetDeviceMappingProfile(DEVICE_ID);
      setProfile(result.profile);
      setDirty(false);
      toast.success("已恢复 Cardputer 默认映射");
    } finally { setBusy(false); }
  };

  if (!profile) return <Loader2 className="h-5 w-5 animate-spin text-blue-600" />;
  const syncLabel = { applied: "已应用", pending: "等待设备", failed: "同步失败", saved: "已保存" }[status?.sync?.status] || "已保存";
  return (
    <section className="space-y-5 rounded-xl border border-blue-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><h3 className="font-semibold text-gray-900">Cardputer-Adv</h3><CheckCircle2 className="h-4 w-4 text-emerald-500" /></div>
          <p className="mt-1 text-xs text-gray-500">普通键盘全键透传 · Fn+M / Fn+S 保留在设备端 · {status?.connected ? `在线 ${status.device?.firmware_version || ""}` : "离线"} · {DEVICE_ID}</p>
        </div>
        <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs text-blue-700">{syncLabel} · r{profile.revision}</span>
      </div>

      <div>
        <h4 className="text-sm font-medium text-gray-800">特殊控制映射</h4>
        <div className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200">
          {controls.map(([id, action]) => (
            <div key={id} className="grid gap-2 p-3 md:grid-cols-[minmax(160px,1fr)_minmax(220px,1.4fr)_auto] md:items-center">
              <span className="text-sm text-gray-700">{CONTROL_LABELS[id]}</span>
              <select className="rounded-md border border-gray-200 px-2 py-1.5 text-sm" value={actionValue(action)}
                onChange={(event) => updateControl(id, actionFromValue(
                  event.target.value,
                  action,
                  id === "cardputer.opt.hold" || id.includes("pointer.primary") || id.includes("pointer.secondary")
                ))}>
                {optionsForControl(id).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              {action.type === "keyboard.chord" ? <ShortcutRecorder action={action} onChange={(next) => updateControl(id, next)} /> : <span />}
            </div>
          ))}
        </div>
      </div>

      <div>
        <h4 className="text-sm font-medium text-gray-800">飞鼠方向与手感</h4>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <RangeRow label="光标速度" value={profile.air_mouse.pointer_speed} min="0.5" max="2.5" step="0.1" left="慢" right="快" onChange={(value) => updateAirMouse("pointer_speed", value)} />
          <RangeRow label="滚轮速度" value={profile.air_mouse.wheel_speed} min="0.5" max="2" step="0.1" left="慢" right="快" onChange={(value) => updateAirMouse("wheel_speed", value)} />
          <RangeRow label="光标漂移抑制" value={profile.air_mouse.pointer_deadzone_dps} min="1" max="6" step="0.5" left="灵敏" right="稳定" onChange={(value) => updateAirMouse("pointer_deadzone_dps", value)} />
          <RangeRow label="滚轮漂移抑制" value={profile.air_mouse.wheel_deadzone_dps} min="2" max="10" step="0.5" left="灵敏" right="稳定" onChange={(value) => updateAirMouse("wheel_deadzone_dps", value)} />
        </div>
        <div className="mt-4 flex flex-wrap gap-4 text-sm text-gray-700">
          {[["invert_horizontal", "水平反向"], ["invert_vertical", "垂直反向"], ["invert_scroll", "滚轮反向"]].map(([key, label]) => (
            <label key={key} className="inline-flex items-center gap-2"><input type="checkbox" checked={profile.air_mouse[key]} onChange={(event) => updateAirMouse(key, event.target.checked)} />{label}</label>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={reset} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700"><RotateCcw className="h-4 w-4" />恢复默认</button>
        <button type="button" onClick={save} disabled={busy || !dirty} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"><Save className="h-4 w-4" />保存并应用</button>
      </div>
    </section>
  );
}
