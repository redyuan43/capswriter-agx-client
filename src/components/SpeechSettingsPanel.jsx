import { useCallback, useEffect, useState } from 'react';

const INPUT = 'w-full rounded border border-gray-300 px-3 py-2 text-sm';
const BUTTON = 'rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50';
const EMPTY = { term: '', weight: 5, aliases: [], exclusions: [], enabled: true };
const fallbackMessage = (reason) => {
  if (reason === 'cancelled') return '已取消';
  if (reason === 'timeout') return '等待超时，已保留基础结果';
  if (reason === 'http_429') return '服务拒绝请求（HTTP 429），请检查限流或额度；已保留基础结果';
  if (reason === 'api_key_missing') return '尚未配置智谱凭据，已保留基础结果';
  if (reason?.startsWith('fidelity:')) return '整理结果未通过原文保护检查，已保留基础结果';
  return reason ? '整理未完成，已保留基础结果' : '整理完成';
};

export default function SpeechSettingsPanel() {
  const api = window.electronAPI;
  const [mode, setMode] = useState('light');
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState({ configured: {} });
  const [secrets, setSecrets] = useState({});
  const [dictionary, setDictionary] = useState({ dictionary: [], candidates: [], terms: [] });
  const [entry, setEntry] = useState(EMPTY);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewInput, setPreviewInput] = useState('');
  const [preview, setPreview] = useState(null);
  const reload = useCallback(async () => {
    const [provider, words, savedMode, savedEnabled] = await Promise.all([api.getProviderStatus(), api.getHotWords(), api.getSetting('text_processing_mode', 'light'), api.getSetting('text_polish_enabled', true)]);
    setStatus(provider); setDictionary(words); setMode(savedMode === 'prompt' ? 'prompt' : 'light');
    setEnabled(savedEnabled !== false);
  }, [api]);
  useEffect(() => { void reload().catch((e) => setMessage(e.message)); }, [reload]);
  const run = async (task) => {
    setBusy(true); setMessage('');
    try { await task(); } catch (e) { setMessage(e.message); } finally { setBusy(false); }
  };
  const setProcessingMode = (value) => run(async () => {
    await api.setSetting('text_processing_mode', value);
    await api.setSetting('text_polish_enabled', true);
    await api.setSetting('long_text_format_enabled', true);
    setEnabled(true);
    setMode(value); setMessage('处理模式已保存，下次整理生效');
  });
  const split = (value) => value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);

  return <section className="mb-6 space-y-5 rounded-lg border border-gray-200 bg-white p-5">
    <div>
      <h2 className="text-lg font-semibold text-gray-900">语音整理与热词</h2>
      <p className="mt-1 text-sm text-gray-600">FireRed2 日常输入只做本机标点、热词和规则处理，不调用大模型。提示词优化可在下方手动执行；腾讯及其他连接继续使用免费 GLM-4.7-Flash。</p>
    </div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => {
      const value = e.target.checked;
      void run(async () => { await api.setSetting('text_polish_enabled', value); if (value) await api.setSetting('long_text_format_enabled', true); setEnabled(value); });
    }} />启用语音整理</label>
    <label className="block text-sm font-medium">云端自动处理模式
      <select aria-label="处理模式" className={`${INPUT} mt-1`} value={mode} disabled={busy} onChange={(e) => setProcessingMode(e.target.value)}>
        <option value="light">轻度润色</option><option value="prompt">提示词优化</option>
      </select>
    </label>
    <p className="text-sm text-gray-600">{mode === 'light' ? '修正断句、标点和分段，保护原意。云端最多约 2 秒；本机日常输入不等待大模型。' : '使用 WorkBuddy 原始模板，改写为约 800 字符内的提示词，长输入可能压缩。云端自动处理最多 30 秒；本机仅手动优化时调用模型，最多 60 秒，可取消。'}</p>
    <details>
      <summary className="cursor-pointer text-sm font-medium text-blue-700">API 凭据与腾讯直连</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-gray-600">腾讯直连时音频发送到腾讯、整理文本发送到智谱。FireRed2 路径在本机识别和整理，不使用这些云端密钥。填写新值才会替换已有值。</p>
        {[
          ['glmApiKey', '智谱 API Key'], ['tencentAppId', '腾讯 AppId'],
          ['tencentSecretId', '腾讯 SecretId'], ['tencentSecretKey', '腾讯 SecretKey'],
        ].map(([key, label]) => <label key={key} className="block text-sm">{label} · {status.configured[key] ? '已配置' : '未配置'}
          <input className={`${INPUT} mt-1`} type="password" autoComplete="off" value={secrets[key] || ''}
            placeholder="填写新值" onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })} />
        </label>)}
        {!status.secureStorage && <p className="text-sm text-amber-700">系统密钥环不可用，暂时无法保存密钥。已配置的环境变量仍可使用。</p>}
        <button className={BUTTON} disabled={busy || !status.secureStorage} onClick={() => run(async () => {
          await api.saveProviderSecrets(Object.fromEntries(Object.entries(secrets).filter(([, value]) => value.trim())));
          setSecrets({}); await reload(); setMessage('凭据已加密保存');
        })}>保存凭据</button>
        <button className="ml-3 text-sm text-blue-700" disabled={busy} onClick={() => run(async () => {
          await api.activateAsrConnectionProfile('tencent-direct'); setMessage('已切换腾讯本机直连');
        })}>启用腾讯本机直连</button>
        <p className="text-xs text-gray-600">实时识别优先使用已确认的普通版免费额度；额度未知或不足时使用 2.0，2.0 和文件极速识别可能计费。</p>
      </div>
    </details>
    <details>
      <summary className="cursor-pointer text-sm font-medium text-blue-700">热词库 · {dictionary.count || 0} 条</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-gray-600">本次可发送 {dictionary.selected || 0} 条，省略 {dictionary.omitted || 0} 条，格式不适用 {dictionary.invalid?.length || 0} 条。最近三天编辑的词优先入选，词库完整保留；普通权重为 5，11 为强热词。仅明确别名会参与文字替换。</p>
        <button className="text-sm text-blue-700" disabled={busy} onClick={() => run(async () => {
          const clipboard = await api.readClipboard();
          if (clipboard?.success === false) throw new Error('无法读取剪贴板');
          await api.proposeHotWords(split(typeof clipboard === 'string' ? clipboard : clipboard.text || ''));
          await reload(); setMessage('候选词已列出，检查后保存才会生效');
        })}>从剪贴板提取候选词</button>
        {!!dictionary.candidates?.length && <div className="rounded bg-amber-50 p-3 text-sm">
          <p>剪贴板候选词：点击检查后保存才会生效。</p>
          {dictionary.candidates.map((term) => <button key={term} className="m-1 rounded border px-2 py-1" onClick={() => setEntry({ ...EMPTY, term })}>{term}</button>)}
        </div>}
        <input aria-label="搜索热词" className={INPUT} placeholder="搜索热词" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="max-h-40 overflow-auto rounded border">
          {dictionary.dictionary?.filter((e) => e.term.toLowerCase().includes(search.toLowerCase())).map((e) => <button key={e.term}
            className="flex w-full justify-between border-b px-3 py-2 text-left text-sm hover:bg-blue-50" onClick={() => setEntry(e)}>
            <span>{e.term}</span><span className="text-gray-500">{e.enabled ? `权重 ${e.weight}` : '停用'}</span>
          </button>)}
        </div>
        <label className="block text-sm">词条<input className={INPUT} value={entry.term} onChange={(e) => setEntry({ ...entry, term: e.target.value })} /></label>
        <label className="block text-sm">权重<input className={INPUT} type="number" min="1" max="11" value={entry.weight} onChange={(e) => setEntry({ ...entry, weight: Number(e.target.value) })} /></label>
        <label className="block text-sm">明确别名（逗号分隔）<input className={INPUT} value={entry.aliasesText ?? entry.aliases.join(',')} onChange={(e) => setEntry({ ...entry, aliases: split(e.target.value), aliasesText: e.target.value })} /></label>
        <label className="block text-sm">排除上下文（逗号分隔）<input className={INPUT} value={entry.exclusionsText ?? entry.exclusions.join(',')} onChange={(e) => setEntry({ ...entry, exclusions: split(e.target.value), exclusionsText: e.target.value })} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={entry.enabled} onChange={(e) => setEntry({ ...entry, enabled: e.target.checked })} />启用</label>
        <button className={BUTTON} disabled={busy || !entry.term.trim()} onClick={() => run(async () => {
          await api.updateHotWord(entry); await reload(); setEntry(EMPTY); setMessage('词条已保存');
        })}>保存词条</button>
        <details><summary className="cursor-pointer text-xs">查看下一次请求的热词</summary><p className="mt-2 break-all text-xs text-gray-600">{dictionary.hotword || '空词表'}</p></details>
      </div>
    </details>
    <details>
      <summary className="cursor-pointer text-sm font-medium text-blue-700">文字整理 / 手动提示词优化</summary>
      <textarea aria-label="待整理文本" className={`${INPUT} mt-3`} rows={4} value={previewInput} onChange={(e) => setPreviewInput(e.target.value)} placeholder="粘贴需要整理的文字；本机预览只处理规则，点击手动优化才调用本机模型" />
      <button className={`${BUTTON} mt-2`} disabled={busy || !previewInput.trim()} onClick={() => run(async () => {
        setPreview(await api.polishText(previewInput, { mode, hotRule: true, longFormat: { enabled: true } }));
      })}>{busy ? '正在整理…' : '预览'}</button>
      <button className={`${BUTTON} ml-2 mt-2`} disabled={busy || !previewInput.trim()} onClick={() => run(async () => {
        setPreview(await api.polishText(previewInput, { mode: 'prompt', manualPrompt: true, hotRule: true, longFormat: { enabled: true } }));
      })}>手动提示词优化</button>
      {busy && <button className="ml-3 text-sm text-gray-600" onClick={() => api.cancelTextPolish()}>取消</button>}
      {preview && <div className="mt-3 rounded bg-gray-50 p-3"><p className="whitespace-pre-wrap text-sm">{preview.text}</p><p className="mt-2 text-xs text-gray-500">{preview.total_ms} ms · {fallbackMessage(preview.degraded)}</p></div>}
    </details>
    {message && <p role="status" className="break-words text-sm text-gray-700">{message}</p>}
  </section>;
}
