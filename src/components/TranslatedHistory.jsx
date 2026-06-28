import { useState, useEffect } from "react";
import { Copy, Trash2, Search, Trash, Loader2, LayoutList, Columns, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

const TranslatedHistory = ({ onClose }) => {
    const [historyItems, setHistoryItems] = useState([]);
    const [loading, setLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [filteredItems, setFilteredItems] = useState([]);
    const [showOriginal, setShowOriginal] = useState(true);
    const [layoutMode, setLayoutMode] = useState('split');

    // 加载翻译历史
    const loadHistory = async () => {
        if (!window.electronAPI) return;

        setLoading(true);
        try {
            const result = await window.electronAPI.getTranslatedClipboardHistory(100, 0);
            setHistoryItems(result || []);
            setFilteredItems(result || []);
        } catch (error) {
            console.error("加载翻译历史失败:", error);
            toast.error("加载翻译历史失败");
        } finally {
            setLoading(false);
        }
    };

    // 搜索功能
    useEffect(() => {
        if (!searchQuery.trim()) {
            setFilteredItems(historyItems);
        } else {
            const query = searchQuery.toLowerCase();
            const filtered = historyItems.filter(item =>
                (item.original_text || "").toLowerCase().includes(query) ||
                (item.translated_text || "").toLowerCase().includes(query)
            );
            setFilteredItems(filtered);
        }
    }, [searchQuery, historyItems]);

    // 组件挂载时加载数据
    useEffect(() => {
        loadHistory();
    }, []);

    // 删除记录
    const handleDelete = async (id) => {
        if (!window.electronAPI) return;

        try {
            await window.electronAPI.deleteTranslatedClipboardItem(id);
            setHistoryItems(prev => prev.filter(item => item.id !== id));
            toast.success("已删除该记录");
        } catch (error) {
            console.error("删除记录失败:", error);
            toast.error("删除记录失败");
        }
    };

    // 清空所有记录
    const handleClearAll = async () => {
        if (!window.electronAPI) return;
        if (!window.confirm("确定要清空所有翻译历史记录吗？")) return;

        try {
            await window.electronAPI.clearTranslatedClipboardHistory();
            setHistoryItems([]);
            toast.success("已清空所有记录");
        } catch (error) {
            console.error("清空记录失败:", error);
            toast.error("清空记录失败");
        }
    };

    const handleCopy = async (text) => {
        try {
            if (window.electronAPI) {
                await window.electronAPI.copyText(text);
                toast.success("已复制译文");
            } else {
                await navigator.clipboard.writeText(text);
                toast.success("已复制译文");
            }
        } catch (error) {
            console.error("复制失败:", error);
            toast.error("复制失败");
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
        <div className="absolute inset-0 bg-gradient-to-br from-slate-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex flex-col z-50">
            {/* 标题栏 */}
            <div className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex-shrink-0">
                <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 chinese-title">翻译历史</h1>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* 搜索栏与清空按钮 */}
            <div className="p-6 pb-2">
                <div className="max-w-4xl mx-auto flex items-center gap-4">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="搜索历史记录..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-shadow"
                        />
                    </div>

                    <div className="hidden sm:flex bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                        <button
                            onClick={() => setLayoutMode('split')}
                            className={`p-1.5 rounded-md transition-colors ${layoutMode === 'split' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                            title="双排显示"
                        >
                            <Columns className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setLayoutMode('stacked')}
                            className={`p-1.5 rounded-md transition-colors ${layoutMode === 'stacked' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                            title="单排显示"
                        >
                            <LayoutList className="w-4 h-4" />
                        </button>
                    </div>

                    <button
                        onClick={() => setShowOriginal(!showOriginal)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm ${showOriginal ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}
                        title={showOriginal ? "隐藏原文" : "显示原文"}
                    >
                        {showOriginal ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                        <span className="hidden sm:inline">原文</span>
                    </button>

                    {historyItems.length > 0 && (
                        <button
                            onClick={handleClearAll}
                            className="flex items-center gap-2 px-3 py-2 bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40 rounded-lg transition-colors text-sm"
                            title="清空所有记录"
                        >
                            <Trash className="w-4 h-4" />
                            <span className="hidden sm:inline">清空</span>
                        </button>
                    )}
                </div>
            </div>

            {/* 列表区域 */}
            <div className="flex-1 overflow-y-auto p-6 pt-2">
                <div className="max-w-4xl mx-auto">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="animate-spin h-8 w-8 text-blue-500" />
                            <span className="ml-3 text-gray-500">加载中...</span>
                        </div>
                    ) : filteredItems.length === 0 ? (
                        <div className="text-center py-12">
                            <div className="text-gray-300 dark:text-gray-600 mb-3 mx-auto flex justify-center">
                                <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                                </svg>
                            </div>
                            <p className="text-gray-500 dark:text-gray-400">
                                {searchQuery ? "没有找到匹配的记录" : "暂无翻译历史"}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {filteredItems.map(item => (
                                <div key={item.id} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden hover:shadow-md transition-shadow">
                                    {/* 卡片头部 */}
                                    <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 dark:border-gray-700/50 bg-gray-50/50 dark:bg-gray-800/50">
                                        <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            {formatDate(item.created_at)}
                                        </span>
                                        <div className="flex items-center gap-1">
                                            <button
                                                onClick={() => handleCopy(item.translated_text)}
                                                className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-md transition-colors"
                                                title="复制译文"
                                            >
                                                <Copy className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => handleDelete(item.id)}
                                                className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-md transition-colors"
                                                title="删除"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                    {/* 卡片内容: 双栏或上下结构 */}
                                    <div className={`flex ${layoutMode === 'split' && showOriginal ? 'flex-col md:flex-row divide-y md:divide-y-0 md:divide-x' : 'flex-col divide-y'} divide-gray-100 dark:divide-gray-700`}>
                                        {showOriginal && (
                                            <div className={`p-4 bg-gray-50/30 dark:bg-gray-800/30 min-w-0 ${layoutMode === 'split' ? 'flex-1' : ''}`}>
                                                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Original Text</div>
                                                <div className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-words overflow-x-auto">
                                                    {item.original_text}
                                                </div>
                                            </div>
                                        )}
                                        <div className="flex-1 p-4 bg-blue-50/10 dark:bg-blue-900/5 min-w-0">
                                            <div className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider mb-2">Translated Text</div>
                                            <div className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap break-words overflow-x-auto">
                                                {item.translated_text}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default TranslatedHistory;
