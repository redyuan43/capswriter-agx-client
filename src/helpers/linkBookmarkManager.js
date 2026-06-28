const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizePhrase } = require("./voiceLearningManager");

const DEFAULT_BOOKMARKS_PATH = path.join(
  os.homedir(),
  ".config",
  "speech-transcription",
  "voice-link-bookmarks.json"
);

const DEFAULT_BOOKMARKS = [
  {
    id: "ssh_topology",
    title: "设备网络拓扑页",
    url: "http://100.91.42.28:18080/ssh-topology",
    aliases: ["网络拓扑", "设备拓扑", "拓扑页面", "ssh 拓扑", "设备网络拓扑页面"]
  },
  {
    id: "video_analysis",
    title: "视频分析页",
    url: "http://127.0.0.1:5000",
    aliases: ["视频分析", "视频分析页面", "视频分析工具"]
  },
  {
    id: "github_redyuan43",
    title: "GitHub 代码仓库",
    url: "https://github.com/redyuan43",
    aliases: ["github", "github 仓库", "我的 github", "代码仓库", "github 主页"]
  },
  {
    id: "chatgpt",
    title: "ChatGPT",
    url: "https://chatgpt.com",
    aliases: ["chatgpt", "chat gpt", "gpt", "chatgpt 网站"]
  },
  {
    id: "gmail",
    title: "Gmail 邮箱",
    url: "https://mail.google.com/mail/u/0/#inbox",
    aliases: ["gmail", "gmail 邮箱", "邮箱", "我的邮箱", "邮件", "收件箱"]
  },
  {
    id: "design_systems",
    title: "设计风格选择页",
    url: "http://127.0.0.1:17573/design-systems",
    aliases: [
      "设计风格",
      "设计风格页",
      "设计风格页面",
      "设计风格选择",
      "风格选择",
      "风格选择页",
      "风格页面",
      "设计系统",
      "设置系统",
      "样式系统",
      "design systems"
    ]
  },
  {
    id: "task_check_panel",
    title: "任务检查面板",
    url: "http://100.82.207.44:8788",
    aliases: ["任务检查", "任务检查面板", "检查面板", "任务面板", "检查任务", "切割板"]
  },
  {
    id: "tts_dashboard",
    title: "TTS 生成页面",
    url: "http://127.0.0.1:8787/tts-dashboard.html",
    aliases: [
      "tts",
      "tts 生成",
      "tts 生成页面",
      "t t s 生成",
      "t t s 生成页面",
      "ttx 生成",
      "ttx 生成页面",
      "t t x 生成",
      "t t x 生成页面",
      "语音生成页面",
      "语音合成页面",
      "音频生成页面"
    ]
  }
];

function expandHome(value) {
  return String(value || "").replace(/^~(?=$|\/)/, os.homedir());
}

function uniqueStrings(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = normalizePhrase(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function slugifyTitle(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return normalized || `link_${Date.now()}`;
}

class LinkBookmarkManager {
  constructor({ logger = null, bookmarksPath = "" } = {}) {
    this.logger = logger;
    this.bookmarksPath = expandHome(
      bookmarksPath || process.env.CAPSWRITER_LINK_BOOKMARKS_PATH || DEFAULT_BOOKMARKS_PATH
    );
  }

  initializeDefaults() {
    const existing = this.loadRaw();
    const now = new Date().toISOString();
    const bookmarks = Array.isArray(existing.bookmarks) ? existing.bookmarks : [];
    const existingIds = new Set(bookmarks.map((bookmark) => bookmark?.id).filter(Boolean));
    const normalizedUrlToIndex = new Map();
    bookmarks.forEach((bookmark, index) => {
      const url = String(bookmark?.url || "").trim();
      if (url && !normalizedUrlToIndex.has(url)) {
        normalizedUrlToIndex.set(url, index);
      }
    });
    let changed = !existing.version;

    for (const seed of DEFAULT_BOOKMARKS) {
      const existingIndex = existingIds.has(seed.id)
        ? bookmarks.findIndex((bookmark) => bookmark?.id === seed.id)
        : normalizedUrlToIndex.get(String(seed.url || "").trim());
      if (existingIndex >= 0) {
        const current = this.normalizeBookmark(bookmarks[existingIndex]);
        const aliases = uniqueStrings([...(current.aliases || []), ...(seed.aliases || [])]);
        if (aliases.length !== (current.aliases || []).length) {
          bookmarks[existingIndex] = {
            ...current,
            aliases,
            updatedAt: current.updatedAt || now
          };
          changed = true;
        }
        continue;
      }
      bookmarks.push(this.normalizeBookmark({
        ...seed,
        enabled: true,
        createdAt: now,
        updatedAt: now
      }));
      changed = true;
    }

    const next = { version: 1, bookmarks: bookmarks.map((item) => this.normalizeBookmark(item)) };
    if (changed || !fs.existsSync(this.bookmarksPath)) {
      this.saveRaw(next);
    }
    return next;
  }

  loadRaw() {
    try {
      return JSON.parse(fs.readFileSync(this.bookmarksPath, "utf8"));
    } catch (_) {
      return { version: 1, bookmarks: [] };
    }
  }

  saveRaw(data) {
    fs.mkdirSync(path.dirname(this.bookmarksPath), { recursive: true });
    fs.writeFileSync(this.bookmarksPath, JSON.stringify(data, null, 2) + "\n");
  }

  listBookmarks({ includeDisabled = true } = {}) {
    const data = this.initializeDefaults();
    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks.map((item) => this.normalizeBookmark(item)) : [];
    return includeDisabled ? bookmarks : bookmarks.filter((item) => item.enabled !== false);
  }

  saveBookmark(bookmark) {
    const data = this.initializeDefaults();
    const now = new Date().toISOString();
    const normalized = this.normalizeBookmark({
      ...bookmark,
      id: bookmark?.id || slugifyTitle(bookmark?.title || bookmark?.url),
      createdAt: bookmark?.createdAt || now,
      updatedAt: now
    });
    if (!normalized.title) {
      return { success: false, error: "缺少链接名称" };
    }
    if (!isHttpUrl(normalized.url)) {
      return { success: false, error: "只支持 http/https 链接" };
    }

    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
    const index = bookmarks.findIndex((item) => item?.id === normalized.id);
    if (index >= 0) {
      bookmarks[index] = { ...this.normalizeBookmark(bookmarks[index]), ...normalized };
    } else {
      bookmarks.push(normalized);
    }
    this.saveRaw({ version: 1, bookmarks: bookmarks.map((item) => this.normalizeBookmark(item)) });
    return { success: true, bookmark: normalized };
  }

  deleteBookmark(id) {
    const data = this.initializeDefaults();
    const bookmarks = (Array.isArray(data.bookmarks) ? data.bookmarks : []).filter((item) => item?.id !== id);
    this.saveRaw({ version: 1, bookmarks: bookmarks.map((item) => this.normalizeBookmark(item)) });
    return { success: true };
  }

  getBookmark(id) {
    return this.listBookmarks().find((bookmark) => bookmark.id === id) || null;
  }

  matchBookmark(text) {
    const normalizedText = this.normalizeOpenPhrase(text);
    if (!normalizedText) return null;

    const candidates = this.listBookmarks({ includeDisabled: false }).map((bookmark) => ({
      bookmark,
      keys: this.getSearchKeys(bookmark).map((key) => this.normalizeOpenPhrase(key)).filter(Boolean)
    }));

    const exact = candidates.find(({ keys }) => keys.some((key) => normalizedText === key));
    if (exact) {
      return { bookmark: exact.bookmark, confidence: 1, source: "link_exact" };
    }

    const scored = candidates
      .map(({ bookmark, keys }) => ({
        bookmark,
        score: Math.max(0, ...keys.map((key) => this.scoreKey(normalizedText, key)))
      }))
      .filter((item) => item.score >= 0.72)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return null;
    if (scored[1] && scored[0].score - scored[1].score < 0.08) {
      return {
        routeType: "ask",
        confidence: scored[0].score,
        source: "link_ambiguous",
        question: `你是指 ${scored[0].bookmark.title} 还是 ${scored[1].bookmark.title}？`
      };
    }
    return { bookmark: scored[0].bookmark, confidence: scored[0].score, source: "link_fuzzy" };
  }

  getModelCandidates() {
    return this.listBookmarks({ includeDisabled: false }).map((bookmark) => ({
      id: bookmark.id,
      title: bookmark.title,
      aliases: bookmark.aliases,
      url: bookmark.url
    }));
  }

  normalizeBookmark(bookmark = {}) {
    const title = String(bookmark.title || "").trim();
    const url = String(bookmark.url || "").trim();
    const id = String(bookmark.id || slugifyTitle(title || url)).trim();
    const aliases = uniqueStrings([
      ...(Array.isArray(bookmark.aliases) ? bookmark.aliases : []),
      ...this.generateAliases(title)
    ]);
    return {
      id,
      title,
      url,
      aliases,
      enabled: bookmark.enabled !== false,
      createdAt: bookmark.createdAt || "",
      updatedAt: bookmark.updatedAt || ""
    };
  }

  generateAliases(title) {
    const trimmed = String(title || "").trim();
    if (!trimmed) return [];
    const compact = trimmed.replace(/(页面|网页|网站|面板|系统|工具|选择页|主页)$/g, "").trim();
    return uniqueStrings([
      trimmed,
      compact,
      `打开${trimmed}`,
      compact ? `打开${compact}` : "",
      compact ? `${compact}页面` : ""
    ]);
  }

  getSearchKeys(bookmark) {
    return uniqueStrings([
      bookmark.title,
      ...(bookmark.aliases || []),
      ...this.generateAliases(bookmark.title)
    ]);
  }

  normalizeOpenPhrase(value) {
    return normalizePhrase(value)
      .replace(/^(帮我|请|麻烦|给我)?(打开|开启|访问|进入|看看|看一下|跳到|去到|转到|打开一下)/, "")
      .replace(/^(这个|那个|当前|我的|我那个)/, "")
      .replace(/的/g, "")
      .replace(/(页面|网页|网站)$/g, "");
  }

  scoreKey(text, key) {
    if (!text || !key) return 0;
    if (text === key) return 1;
    if (text.includes(key) || key.includes(text)) {
      return Math.min(text.length, key.length) / Math.max(text.length, key.length);
    }
    return 0;
  }
}

module.exports = {
  DEFAULT_BOOKMARKS,
  DEFAULT_BOOKMARKS_PATH,
  LinkBookmarkManager,
  isHttpUrl
};
