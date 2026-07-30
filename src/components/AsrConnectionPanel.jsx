import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, Plus, Radio, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatProbeMetrics, probeAsrConnection } from "../helpers/asrConnectionProbe.mjs";

const emptyCustomProfile = () => ({
  id: `custom-${Date.now()}`,
  name: "自定义 ASR",
  url: "",
  auth: "none",
  preset: false,
  hasToken: false,
});

function sameDraft(left, right) {
  return left && right
    && left.id === right.id
    && left.name === right.name
    && left.url === right.url
    && left.auth === right.auth;
}

export default function AsrConnectionPanel() {
  const [state, setState] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState(null);
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testedDraft, setTestedDraft] = useState(null);
  const [probeMetrics, setProbeMetrics] = useState("");

  const selected = useMemo(
    () => state?.profiles?.find((item) => item.id === selectedId) || null,
    [state, selectedId],
  );
  const active = Boolean(selected && state?.activeProfileId === selected.id);
  const tokenRequired = draft?.auth === "token";

  const load = useCallback(async () => {
    if (!window.electronAPI?.listAsrConnectionProfiles) return;
    const next = await window.electronAPI.listAsrConnectionProfiles();
    setState(next);
    const nextSelected = next.profiles.find((item) => item.id === selectedId)
      || next.profiles.find((item) => item.id === next.activeProfileId)
      || next.profiles[0];
    if (nextSelected) {
      setSelectedId(nextSelected.id);
      setDraft({ ...nextSelected });
      setToken("");
      setClearToken(false);
      setTestedDraft(null);
      setProbeMetrics("");
    }
  }, [selectedId]);

  useEffect(() => {
    load().catch((error) => toast.error("加载 ASR 配置失败", { description: error?.message || String(error) }));
  }, [load]);

  const selectProfile = (profile) => {
    setSelectedId(profile.id);
    setDraft({ ...profile });
    setToken("");
    setClearToken(false);
    setTestedDraft(null);
    setProbeMetrics("");
  };

  const changeDraft = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setTestedDraft(null);
    setProbeMetrics("");
  };

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      await window.electronAPI.saveAsrConnectionProfile(draft, { token, clearToken });
      toast.success("ASR 配置已保存");
      await load();
    } catch (error) {
      toast.error("保存 ASR 配置失败", { description: error?.message || String(error) });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!draft || busy) return false;
    if (tokenRequired && !token && !draft.hasToken && !clearToken) {
      toast.error("请先输入公网 ASR 令牌");
      return false;
    }
    setBusy(true);
    try {
      const connection = await window.electronAPI.resolveAsrConnectionProfile(draft, { token, clearToken });
      const metrics = await probeAsrConnection(connection);
      setTestedDraft({ ...draft, token });
      const summary = formatProbeMetrics(metrics);
      setProbeMetrics(summary);
      toast.success("ASR 协议与音频吞吐测试通过", { description: summary });
      return true;
    } catch (error) {
      toast.error("ASR 连接测试失败", { description: error?.message || String(error) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveAndActivate = async () => {
    if (!draft || busy) return;
    const passed = testedDraft && sameDraft(testedDraft, draft) && testedDraft.token === token;
    if (!passed && !(await test())) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.saveAsrConnectionProfile(draft, { token, clearToken });
      await window.electronAPI.activateAsrConnectionProfile(draft.id);
      setState(result);
      toast.success(`已启用 ${draft.name}；下一次录音将使用新路由`);
      await load();
    } catch (error) {
      toast.error("启用 ASR 配置失败", { description: error?.message || String(error) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected || selected.preset || busy) return;
    setBusy(true);
    try {
      await window.electronAPI.deleteAsrConnectionProfile(selected.id);
      toast.success("自定义 ASR 配置已删除");
      await load();
    } catch (error) {
      toast.error("删除 ASR 配置失败", { description: error?.message || String(error) });
    } finally {
      setBusy(false);
    }
  };

  if (!state || !draft) {
    return <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-blue-600" /></div>;
  }

  const secureStorageUnavailable = tokenRequired && !state.secureStorage?.available;
  const unchangedActive = active && sameDraft(selected, draft) && !token && !clearToken;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-6">
      <div className="p-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-gray-900 chinese-title">ASR 服务端</h2>
          <p className="text-xs text-gray-600 mt-1">仅影响实时语音识别；切换前必须通过 WebSocket 连接测试。</p>
        </div>

        <div className="space-y-2 mb-4">
          {state.profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              onClick={() => selectProfile(profile)}
              className={`w-full flex items-center justify-between p-3 rounded-lg text-left border transition-colors ${profile.id === selectedId ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:bg-gray-50"}`}
            >
              <span>
                <span className="text-sm font-medium text-gray-900">{profile.name}</span>
                <span className="block text-xs text-gray-500 mt-1 break-all">{profile.url}</span>
              </span>
              <span className="flex items-center gap-1 text-xs">
                {profile.id === state.activeProfileId && <span className="text-green-700">使用中</span>}
                {profile.auth === "token" && <span className="text-gray-500">令牌</span>}
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => selectProfile(emptyCustomProfile())}
          disabled={busy}
          className="mb-4 w-full py-2 text-sm border border-dashed border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 flex items-center justify-center gap-2"
        >
          <Plus className="w-4 h-4" /> 新增自定义 ASR 配置
        </button>

        <div className="space-y-3 border-t pt-4">
          <label className="block text-xs text-gray-600">名称
            <input value={draft.name} disabled={draft.preset || busy} onChange={(event) => changeDraft("name", event.target.value)} className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-md disabled:bg-gray-100" />
          </label>
          <label className="block text-xs text-gray-600">实时 ASR WebSocket 地址
            <input value={draft.url} disabled={busy} onChange={(event) => changeDraft("url", event.target.value)} placeholder="wss://example.com/api/asr/realtime" className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-md" />
          </label>
          {!draft.preset && <label className="block text-xs text-gray-600">认证方式
            <select value={draft.auth} disabled={busy} onChange={(event) => changeDraft("auth", event.target.value)} className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white">
              <option value="none">无认证</option><option value="token">令牌认证</option>
            </select>
          </label>}
          {tokenRequired && <div className="rounded-md bg-gray-50 p-3">
            <label className="block text-xs text-gray-600">访问令牌
              <input type="password" value={token} disabled={busy || secureStorageUnavailable} onChange={(event) => { setToken(event.target.value); setClearToken(false); setTestedDraft(null); }} placeholder={draft.hasToken ? "已配置；留空保持不变" : "输入 ASR 访问令牌"} className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-md disabled:bg-gray-100" />
            </label>
            {secureStorageUnavailable ? <p className="mt-2 text-xs text-red-600">{state.secureStorage.message}</p> : <><p className="mt-2 text-xs text-green-700">{draft.hasToken ? "令牌已安全保存；输入新值可替换。" : "尚未保存令牌。"}</p><button type="button" disabled={busy || !draft.hasToken} onClick={() => { setToken(""); setClearToken(true); setTestedDraft(null); setProbeMetrics(""); }} className="mt-2 text-xs text-red-600 hover:underline">删除已保存令牌</button></>}
          </div>}
        </div>

        {probeMetrics && <p className="mt-3 rounded-md bg-green-50 px-3 py-2 text-xs text-green-800">测试指标：{probeMetrics}</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          {!active && <button type="button" onClick={save} disabled={busy} className="px-3 py-2 text-xs rounded-md bg-gray-100 text-gray-800 hover:bg-gray-200 disabled:opacity-60">保存配置</button>}
          <button type="button" onClick={test} disabled={busy} className="px-3 py-2 text-xs rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-60 flex items-center gap-1"><Radio className="w-3.5 h-3.5" /> 测试连接</button>
          {!unchangedActive && <button type="button" onClick={saveAndActivate} disabled={busy} className="px-3 py-2 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> 测试并启用</button>}
          {selected && !selected.preset && <button type="button" onClick={remove} disabled={busy} className="ml-auto px-3 py-2 text-xs rounded-md text-red-600 hover:bg-red-50 disabled:opacity-60 flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> 删除</button>}
        </div>
      </div>
    </div>
  );
}
