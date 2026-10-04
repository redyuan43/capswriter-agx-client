import { useCallback, useEffect, useState } from 'react';

const INPUT = 'w-full rounded border border-gray-300 px-3 py-2 text-sm';
const BUTTON = 'rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50';
const EMPTY = { term: '', weight: 5, aliases: [], exclusions: [], enabled: true, group: 'general', strong: false };
const fallbackMessage = (reason) => {
  if (reason === 'background_pending') return '基础结果已交付，后台整理中';
  if (reason === 'model_unverified') return '整理模型待质量验收，当前交付基础文本';
  if (reason === 'natural_api_key_missing') return '整理服务凭据未配置，已保留基础结果';
  if (reason === 'model_identity_mismatch') return '整理模型与配置不一致，已保留基础结果';
  if (reason === 'cancelled') return '已取消';
  if (reason === 'insufficient_memory') return '本机显存/内存不足，已保留基础结果';
  if (reason === 'model_missing') return '本机模型文件不存在，已保留基础结果';
  if (reason === 'request_failed') return '整理服务离线或请求失败，已保留基础结果';
  if (reason === 'incomplete_response') return '模型未完整生成，已保留基础结果';
  if (reason === 'timeout') return '等待超时，已保留基础结果';
  if (reason === 'http_429') return '服务拒绝请求（HTTP 429），请检查限流或额度；已保留基础结果';
  if (reason === 'api_key_missing') return '尚未配置智谱凭据，已保留基础结果';
  if (reason?.startsWith('fidelity:')) return '整理结果未通过原文保护检查，已保留基础结果';
  return reason ? '整理未完成，已保留基础结果' : '整理完成';
};

export default function SpeechSettingsPanel() {
  const api = window.electronAPI;
  const [mode, setMode] = useState('light');
  const [localStatus, setLocalStatus] = useState(null);
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
    setStatus(provider); setDictionary(words); setMode(['natural', 'prompt'].includes(savedMode) ? savedMode : 'light');
    setEnabled(savedEnabled !== false);
  }, [api]);
  useEffect(() => { void reload().catch((e) => setMessage(e.message)); }, [reload]);
  useEffect(() => { if (mode === 'natural') api.probeLongTextService().then(setLocalStatus).catch(() => setLocalStatus({ available: false })); }, [api, mode]);
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
      <p className="mt-1 text-sm text-gray-600">自然整理最多等待至松键后 2 秒，较慢的结果在历史中查看。语音识别与整理服务独立配置。</p>
    </div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => {
      const value = e.target.checked;
      void run(async () => { await api.setSetting('text_polish_enabled', value); if (value) await api.setSetting('long_text_format_enabled', true); setEnabled(value); });
    }} />启用语音整理</label>
    <label className="block text-sm font-medium">自动处理模式
      <select aria-label="处理模式" className={`${INPUT} mt-1`} value={mode} disabled={busy} onChange={(e) => setProcessingMode(e.target.value)}>
        <option value="natural">自然整理</option><option value="light">逐字保真</option><option value="prompt">提示词优化</option>
      </select>
    </label>
    <p className="text-sm text-gray-600">{mode === 'natural' ? (localStatus?.profile === 'ai-natural' ? '短句使用本机基础处理，超过 40 字调用 Handy 默认整理流程。候选结果通过本地词项检查后仅存入历史供审阅；当前验收未通过，不会自动输入。后台结果不会覆盖已输入文字。' : localStatus?.scope === 'punctuation' ? '当前只修复断句、标点和分段，保留原文字词与顺序。术语按已确认词库纠正；不自动改写或删除重复。后台结果不会覆盖已经输入的文字。' : '整理模型尚需验证断句、语病和口头语处理效果。后台结果不会覆盖已经输入的文字。自动交付由模型验收状态决定。') : mode === 'light' ? '修正断句、标点和分段，保护原意。云端最多约 2 秒；本机日常输入不等待大模型。' : '使用 WorkBuddy 原始模板，改写为约 800 字符内的提示词，长输入可能压缩。云端自动处理最多 30 秒；本机仅手动优化时调用模型，最多 60 秒，可取消。'}</p>
    {mode === 'natural' && <p role="status" className="text-sm text-gray-600">{localStatus === null ? '正在检查整理服务…' : localStatus.available ? `${localStatus.provider === 'ai' ? 'ai 整理服务可用' : '本机模型已加载'} · ${localStatus.model}` : localStatus.error === 'insufficient_memory' ? '本机可用显存/内存不足，已降级为基础处理' : localStatus.error === 'model_missing' ? '本机模型文件不存在，已降级为基础处理' : '整理服务离线或加载中，暂用基础处理'} · {localStatus?.qualityApproved ? (localStatus.scope === 'punctuation' ? '受限标点整理已启用；全文改写未启用' : '质量验收已通过') : '质量待验收：模型结果仅供历史查看'}<button className="ml-3 text-blue-600" onClick={() => api.probeLongTextService().then(setLocalStatus)}>刷新状态</button></p>}
    <details>
      <summary className="cursor-pointer text-sm font-medium text-blue-700">API 凭据与腾讯直连</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-gray-600">腾讯直连时音频发送到腾讯；启用 ai 整理时，中长句文本通过内部加密通道发送到 ai，短句在本机处理。逐字保真和提示词模式保留原有模型配置。填写新值才会替换已有值。</p>
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
        <p className="text-xs text-gray-600">本次可发送 {dictionary.selected || 0} 条，省略 {dictionary.omitted || 0} 条，格式不适用 {dictionary.invalid?.length || 0} 条。选中词组和最近三天编辑的词优先入选，词库完整保留；普通权重为 5。仅明确别名会参与文字替换。</p>
        <div className="flex flex-wrap gap-3">
          {Object.entries(dictionary.groups || {}).map(([id, label]) => <label key={id} className="text-sm"><input type="checkbox" checked={dictionary.activeGroups?.includes(id) || false} disabled={busy} onChange={(e) => run(async () => {
            const groups = e.target.checked ? [...dictionary.activeGroups, id] : dictionary.activeGroups.filter(g => g !== id);
            await api.configureHotWords({ activeGroups: groups }); await reload();
          })} /> {label}</label>)}
        </div>
        <label className="block text-sm"><input type="checkbox" checked={dictionary.managedWeights || false} disabled={busy} onChange={e => run(async () => {
          await api.configureHotWords({ managedWeights: e.target.checked }); await reload();
        })} /> 普通词统一为 5，明确指定的强热词为 11（保留原始权重，可撤销）</label>
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
        <label className="block text-sm">词组<select className={INPUT} value={entry.group || 'general'} onChange={e => setEntry({ ...entry, group: e.target.value })}>{Object.entries(dictionary.groups || { general: '其他词' }).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label className="block text-sm"><input type="checkbox" checked={entry.strong || false} onChange={e => setEntry({ ...entry, strong: e.target.checked, weight: e.target.checked ? 11 : 5 })} /> 明确指定为强热词</label>
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
      <textarea aria-label="待整理文本" className={`${INPUT} mt-3`} rows={4} value={previewInput} onChange={(e) => setPreviewInput(e.target.value)} placeholder="粘贴需要整理的文字；自然整理预览调用本机模型；只显示结果，不自动粘贴" />
      <button className={`${BUTTON} mt-2`} disabled={busy || !previewInput.trim()} onClick={() => run(async () => {
        setPreview(await api.polishText(previewInput, { mode, hotRule: true, longFormat: { enabled: true } }));
      })}>{busy ? '正在整理…' : '预览'}</button>
      <button className={`${BUTTON} ml-2 mt-2`} disabled={busy || !previewInput.trim()} onClick={() => run(async () => {
        setPreview(await api.polishText(previewInput, { mode: 'prompt', manualPrompt: true, hotRule: true, longFormat: { enabled: true } }));
      })}>手动提示词优化</button>
      {busy && <button className="ml-3 text-sm text-gray-600" onClick={() => api.cancelTextPolish()}>取消</button>}
      {preview && <div className="mt-3 rounded bg-gray-50 p-3"><p className="whitespace-pre-wrap text-sm">{preview.text}</p><p className="mt-2 text-xs text-gray-500">{preview.total_ms} ms · {fallbackMessage(preview.degraded)}</p>{preview.candidate_text && <p className="mt-2 whitespace-pre-wrap text-sm text-amber-800">待复核：{preview.candidate_text}</p>}</div>}
    </details>
    {message && <p role="status" className="break-words text-sm text-gray-700">{message}</p>}
  </section>;
}
