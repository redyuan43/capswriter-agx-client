import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

// 历史记录页面组件
const HistoryPage = () => {
  const handleCopy = async (text) => {
    try {
      if (window.electronAPI) {
        await window.electronAPI.copyText(text);
        // 可以添加一个简单的提示
        const toast = document.createElement('div');
        toast.textContent = '文本已复制到剪贴板';
        toast.className = 'fixed top-4 right-4 bg-green-500 text-white px-4 py-2 rounded-lg shadow-lg z-50';
        document.body.appendChild(toast);
        setTimeout(() => {
          document.body.removeChild(toast);
        }, 2000);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch (error) {
      console.error("复制失败:", error);
    }
  };

  const handleClose = () => {
    if (window.electronAPI) {
      window.electronAPI.closeHistoryWindow();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      {/* 使用历史记录组件，但作为全屏页面而不是模态框 */}
      <div className="h-screen flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
          <div className="flex items-center space-x-3">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 chinese-title">语音转写 - 转录历史</h1>
          </div>
          <button
            onClick={handleClose}
            className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            关闭窗口
          </button>
        </div>

        {/* 历史记录内容 */}
        <div className="flex-1 overflow-hidden">
          <HistoryContent onCopy={handleCopy} />
        </div>
      </div>
    </div>
  );
};

// 历史记录内容组件
const HistoryContent = ({ onCopy }) => {
  const [transcriptions, setTranscriptions] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [retryError, setRetryError] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState("");
  const [filteredTranscriptions, setFilteredTranscriptions] = React.useState([]);

  // 加载转录历史
  const loadTranscriptions = async (silent = false) => {
    if (!window.electronAPI) return;
    
    if (!silent) setLoading(true);
    try {
      const result = await window.electronAPI.getTranscriptions(100, 0);
      setTranscriptions(result || []);
      setFilteredTranscriptions(result || []);
    } catch (error) {
      console.error("加载历史记录失败:", error);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // 搜索功能
  React.useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredTranscriptions(transcriptions);
    } else {
      const filtered = transcriptions.filter(item => 
        item.text?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.processed_text?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.raw_text?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.candidate_text?.toLowerCase().includes(searchQuery.toLowerCase())
      );
      setFilteredTranscriptions(filtered);
    }
  }, [searchQuery, transcriptions]);

  // 组件挂载时加载数据
  React.useEffect(() => {
    loadTranscriptions();
    const timer = setInterval(() => { if (!document.hidden) void loadTranscriptions(true); }, 1500);
    return () => clearInterval(timer);
  }, []);

  // 删除转录记录
  const handleDelete = async (id) => {
    if (!window.electronAPI) return;
    
    try {
      await window.electronAPI.deleteTranscription(id);
      setTranscriptions(prev => prev.filter(item => item.id !== id));
    } catch (error) {
      console.error("删除记录失败:", error);
    }
  };

  // 格式化日期
  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now - date);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    } else if (diffDays === 2) {
      return `昨天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    } else if (diffDays <= 7) {
      return `${diffDays - 1}天前`;
    } else {
      return date.toLocaleDateString('zh-CN', { 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* 搜索栏 */}
      <div className="p-6 bg-white dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
        <div className="max-w-4xl mx-auto">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="搜索转录内容..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent chinese-text text-lg"
            />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              共 {filteredTranscriptions.length} 条记录
            </span>
            <button
              onClick={() => {
                if (window.electronAPI) {
                  window.electronAPI.exportTranscriptions('txt');
                }
              }}
              className="px-4 py-2 bg-blue-500 hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700 text-white rounded-lg transition-colors text-sm"
            >
              导出全部
            </button>
          </div>
        </div>
      </div>

      {retryError && <p role="alert" className="px-6 text-sm text-amber-700">{retryError}</p>}
      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              <span className="ml-3 text-gray-600 dark:text-gray-400">加载中...</span>
            </div>
          ) : filteredTranscriptions.length === 0 ? (
            <div className="text-center py-12">
              <svg className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-gray-500 dark:text-gray-400 chinese-text text-lg">
                {searchQuery ? "没有找到匹配的记录" : "暂无转录历史"}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredTranscriptions.map((item) => (
                <div
                  key={item.id}
                  className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm hover:shadow-md transition-shadow border border-gray-200 dark:border-gray-700"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center space-x-3 text-sm text-gray-500 dark:text-gray-400">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <span>{formatDate(item.created_at)}</span>
                      {item.confidence && (
                        <span className="bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 px-2 py-1 rounded text-xs">
                          置信度: {Math.round(item.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    <div className="flex space-x-2">
                      <button
                        onClick={() => onCopy(item.processed_text || item.text)}
                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                        title="复制文本"
                      >
                        <svg className="w-4 h-4 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDelete(item.id)}
                        className="p-2 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                        title="删除记录"
                      >
                        <svg className="w-4 h-4 text-red-500 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {item.processing_status && <div className="mb-3 text-sm text-gray-600 dark:text-gray-300">
                    {{ processing: '正在整理', background: '后台整理中', completed: '整理完成', review_required: '整理结果需要复核', failed: '整理未完成，基础文本已保留', cancelled: '整理已取消', preempted: '新输入优先，旧整理已取消', interrupted: '上次整理被重启中断' }[item.processing_status] || item.processing_status}
                    {item.delivered_text && <span> · {item.delivered_text === item.corrected_text ? '基础结果已交付' : '整理结果已交付'}{item.delivery_ms != null ? ` · 松键到交付 ${item.delivery_ms} ms` : ''}</span>}
                    {item.processing_json && (() => { try { const info = JSON.parse(item.processing_json); return <span> · {info.route === 'short_basic' ? '短句基础处理' : `${info.provider === 'ai' ? 'ai' : '本机'} · ${info.model || '整理模型'}`} · {({ timeout: '模型超过 15 秒未完成', insufficient_memory: '本机显存/内存不足', model_missing: '本机模型文件不存在', request_failed: '整理服务离线或请求失败', natural_api_key_missing: '整理服务凭据未配置', model_identity_mismatch: '模型身份不一致', thinking_not_disabled: '服务未按要求关闭思考', incomplete_response: '模型未完整生成' }[info.degraded] || info.degraded) || `${info.background ? '后台整理完成 · ' : ''}生成 ${info.generation_ms ?? info.elapsed_ms ?? 0} ms · 首字 ${info.first_token_ms ?? '—'} ms${info.verification_ms != null ? ` · 复核 ${info.verification_ms} ms` : ''} · 合计 ${info.elapsed_ms ?? 0} ms`}{info.verification_reason ? ` · ${info.verification_reason}` : ''}{info.auto_delivery_approved === false ? ' · 尚未通过模型验收，仅供查看' : ''}</span>; } catch { return null; } })()}
                    {['processing', 'background'].includes(item.processing_status) && <button className="ml-3 text-blue-600" onClick={async () => { await window.electronAPI.cancelTextPolish({ jobId: item.session_id }); await loadTranscriptions(true); }}>取消整理</button>}
                    {!['processing', 'background'].includes(item.processing_status) && <button className="ml-3 text-blue-600" onClick={async () => { try { const r = await window.electronAPI.retrySpeechJob(item.id); setRetryError(r?.error || ''); await loadTranscriptions(true); } catch (e) { setRetryError(e.message); } }}>重新整理</button>}
                  </div>}
                  {/* 最终文本 */}
                  <div className="mb-4">
                    <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-2">{item.session_id ? item.delivered_text ? '实际交付文本:' : '基础文本（尚未交付）:' : '最终结果:'}</h4>
                    <p className="whitespace-pre-wrap chinese-content leading-relaxed bg-gray-50 dark:bg-gray-700/60 p-4 rounded-lg border dark:border-gray-600/30">
                      {item.delivered_text || item.corrected_text || item.text}
                    </p>
                  </div>

                  {/* AI优化文本 */}
                  {item.processed_text && (
                    <div className="mb-4">
                      <h4 className="text-sm font-medium text-emerald-700 dark:text-emerald-400 mb-2">整理结果（复制后自行使用）:</h4>
                      <p className="whitespace-pre-wrap chinese-content leading-relaxed bg-emerald-50 dark:bg-emerald-900/20 p-4 rounded-lg border border-emerald-200 dark:border-emerald-700">
                        {item.processed_text}
                      </p>
                    </div>
                  )}

                  {item.candidate_text && <div className="mb-4 rounded bg-amber-50 p-3 text-sm text-gray-900">
                    <p>待复核结果（未自动交付）</p><p className="whitespace-pre-wrap">{item.candidate_text}</p>
                    <button className="mt-2 text-blue-700" onClick={() => onCopy(item.candidate_text)}>复制待复核文本</button>
                  </div>}
                  {item.processing_json && (() => { try {
                    const edits = JSON.parse(item.processing_json).edits || [];
                    return edits.length > 0 && <details className="mb-3 text-sm"><summary>查看整理差异（{edits.length} 处）</summary>
                      {edits.map((edit, index) => <p key={index} className="mt-1 whitespace-pre-wrap"><del className="text-red-700">{edit.before}</del>{' → '}<ins className="text-emerald-700">{edit.after || '（删除）'}</ins></p>)}
                    </details>;
                  } catch { return null; } })()}
                  {item.corrected_text && item.corrected_text !== item.raw_text && <details className="mb-3 text-sm"><summary>热词与规则处理结果</summary><p className="whitespace-pre-wrap">{item.corrected_text}</p></details>}
                  {/* 原始识别文本 */}
                  {item.raw_text && item.raw_text.trim() !== item.text.trim() && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">原始识别:</h4>
                      <p className="text-xs chinese-content leading-relaxed bg-gray-100 dark:bg-gray-700/40 p-3 rounded-lg border dark:border-gray-600/20 text-gray-600 dark:text-gray-200">
                        {item.raw_text}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// 渲染应用
const container = document.getElementById('history-root');
const root = createRoot(container);
root.render(<HistoryPage />);
