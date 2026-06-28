import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";

const emptyDraft = {
  id: "",
  title: "",
  url: "",
  aliases: "",
  enabled: true
};

function aliasesToText(aliases) {
  return (Array.isArray(aliases) ? aliases : []).join("\n");
}

function textToAliases(value) {
  return String(value || "")
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDraft(bookmark) {
  return {
    id: bookmark?.id || "",
    title: bookmark?.title || "",
    url: bookmark?.url || "",
    aliases: aliasesToText(bookmark?.aliases),
    enabled: bookmark?.enabled !== false,
    createdAt: bookmark?.createdAt || ""
  };
}

export default function LinkDirectoryPage() {
  const [bookmarks, setBookmarks] = useState([]);
  const [bookmarksPath, setBookmarksPath] = useState("");
  const [draft, setDraft] = useState(emptyDraft);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const editBookmark = (bookmark) => {
    setDraft(normalizeDraft(bookmark));
    setMessage(`正在编辑：${bookmark.title || bookmark.url}`);
  };

  const loadBookmarks = useCallback(async () => {
    if (!window.electronAPI?.getLinkBookmarks) return;
    const result = await window.electronAPI.getLinkBookmarks();
    if (result?.success === false) {
      setMessage(result.error || "加载失败");
      return;
    }
    setBookmarks(Array.isArray(result?.bookmarks) ? result.bookmarks : []);
    setBookmarksPath(result?.path || "");
    setMessage("");
  }, []);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  const filteredBookmarks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return bookmarks;
    return bookmarks.filter((bookmark) => {
      const haystack = [
        bookmark.title,
        bookmark.url,
        ...(bookmark.aliases || [])
      ].join(" ").toLowerCase();
      return haystack.includes(normalized);
    });
  }, [bookmarks, query]);

  const saveDraft = async () => {
    if (!window.electronAPI?.saveLinkBookmark || saving) return;
    setSaving(true);
    try {
      const payload = {
        id: draft.id || undefined,
        title: draft.title,
        url: draft.url,
        aliases: textToAliases(draft.aliases),
        enabled: draft.enabled,
        createdAt: draft.createdAt
      };
      const result = await window.electronAPI.saveLinkBookmark(payload);
      if (!result || result.success === false) {
        throw new Error(result?.error || "保存失败");
      }
      setDraft(emptyDraft);
      setMessage("已保存");
      await loadBookmarks();
    } catch (error) {
      setMessage(error?.message || String(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteBookmark = async (bookmark) => {
    if (!window.electronAPI?.deleteLinkBookmark) return;
    const result = await window.electronAPI.deleteLinkBookmark(bookmark.id);
    if (!result || result.success === false) {
      setMessage(result?.error || "删除失败");
      return;
    }
    if (draft.id === bookmark.id) {
      setDraft(emptyDraft);
    }
    setMessage("已删除");
    await loadBookmarks();
  };

  const toggleBookmark = async (bookmark) => {
    if (!window.electronAPI?.saveLinkBookmark) return;
    const result = await window.electronAPI.saveLinkBookmark({
      ...bookmark,
      enabled: bookmark.enabled === false
    });
    if (!result || result.success === false) {
      setMessage(result?.error || "更新失败");
      return;
    }
    await loadBookmarks();
  };

  const openBookmark = async (bookmark) => {
    if (!window.electronAPI?.openLinkBookmark) return;
    const result = await window.electronAPI.openLinkBookmark({ id: bookmark.id });
    if (!result || result.success === false) {
      setMessage(result?.error || "打开失败");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-950">
      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
          <div>
            <h1 className="text-xl font-semibold">语音链接表</h1>
            <p className="mt-1 max-w-3xl truncate text-xs text-gray-500">{bookmarksPath}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadBookmarks}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-700 hover:bg-gray-100"
            >
              <RefreshCw className="h-4 w-4" />
              重载
            </button>
          </div>
        </div>
      </div>

      <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_360px] gap-5 px-5 py-5">
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="relative w-80 max-w-full">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full rounded-md border border-gray-300 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                placeholder="搜索"
              />
            </div>
            <span className="text-sm text-gray-500">{filteredBookmarks.length} / {bookmarks.length}</span>
          </div>

          <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <thead className="bg-gray-100 text-xs font-medium text-gray-600">
                <tr>
                  <th className="w-[16%] px-3 py-2">名称</th>
                  <th className="w-[28%] px-3 py-2">URL</th>
                  <th className="w-[38%] px-3 py-2">别名</th>
                  <th className="w-[8%] px-3 py-2">状态</th>
                  <th className="w-[10%] px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredBookmarks.map((bookmark) => (
                  <tr
                    key={bookmark.id}
                    onDoubleClick={() => editBookmark(bookmark)}
                    className={`${bookmark.enabled === false ? "bg-gray-50 text-gray-400" : ""} ${draft.id === bookmark.id ? "bg-blue-50" : ""}`}
                  >
                    <td className="px-3 py-3 align-top font-medium">{bookmark.title}</td>
                    <td className="break-all px-3 py-3 align-top text-gray-600">{bookmark.url}</td>
                    <td className="px-3 py-3 align-top text-gray-600">
                      <div className="flex flex-wrap gap-1.5">
                        {(bookmark.aliases || []).map((alias) => (
                          <span
                            key={alias}
                            className="max-w-full break-all rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs leading-5 text-gray-700"
                          >
                            {alias}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => toggleBookmark(bookmark)}
                        className={`h-7 rounded-md px-2 text-xs ${bookmark.enabled === false ? "bg-gray-200 text-gray-500" : "bg-emerald-100 text-emerald-700"}`}
                      >
                        {bookmark.enabled === false ? "停用" : "启用"}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openBookmark(bookmark)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100"
                          title="打开"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => editBookmark(bookmark)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100"
                          title="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteBookmark(bookmark)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-rose-600 hover:bg-rose-50"
                          title="删除"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="rounded-md border border-gray-200 bg-white p-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{draft.id ? "编辑链接" : "新增链接"}</h2>
            <button
              type="button"
              onClick={() => setDraft(emptyDraft)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"
              title="清空"
            >
              {draft.id ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            </button>
          </div>

          <label className="mb-3 block text-xs font-medium text-gray-600">
            名称
            <input
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              className="mt-1 h-9 w-full rounded-md border border-gray-300 px-3 text-sm font-normal text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </label>

          <label className="mb-3 block text-xs font-medium text-gray-600">
            URL
            <input
              value={draft.url}
              onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
              className="mt-1 h-9 w-full rounded-md border border-gray-300 px-3 text-sm font-normal text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </label>

          <label className="mb-3 block text-xs font-medium text-gray-600">
            别名
            <textarea
              value={draft.aliases}
              onChange={(event) => setDraft((current) => ({ ...current, aliases: event.target.value }))}
              placeholder="每行一个别名，也可以用逗号分隔"
              className="mt-1 min-h-40 w-full resize-y rounded-md border border-gray-300 px-3 py-2 text-sm font-normal leading-6 text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </label>

          <label className="mb-4 flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
              className="h-4 w-4"
            />
            启用
          </label>

          <button
            type="button"
            onClick={saveDraft}
            disabled={saving}
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            <Save className="h-4 w-4" />
            保存
          </button>

          {message ? <div className="mt-3 rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-700">{message}</div> : null}
        </aside>
      </main>
    </div>
  );
}
