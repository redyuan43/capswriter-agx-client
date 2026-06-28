#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_BOOKMARKS, LinkBookmarkManager } = require("../../src/helpers/linkBookmarkManager");

function createTempPath(name) {
  return path.join(os.tmpdir(), `capswriter-${name}-${process.pid}-${Date.now()}.json`);
}

async function run() {
  {
    const bookmarksPath = createTempPath("links");
    const manager = new LinkBookmarkManager({ bookmarksPath });
    const data = manager.initializeDefaults();

    assert.ok(fs.existsSync(bookmarksPath));
    assert.strictEqual(data.bookmarks.length, DEFAULT_BOOKMARKS.length);
    assert.ok(data.bookmarks.some((item) => item.id === "task_check_panel"));
  }

  {
    const bookmarksPath = createTempPath("links-existing");
    fs.writeFileSync(
      bookmarksPath,
      JSON.stringify({
        version: 1,
        bookmarks: [
          {
            id: "custom_daily",
            title: "日报系统",
            url: "http://127.0.0.1:9999/report",
            aliases: ["日报"],
            enabled: true
          }
        ]
      })
    );
    const manager = new LinkBookmarkManager({ bookmarksPath });
    const bookmarks = manager.listBookmarks();

    assert.ok(bookmarks.some((item) => item.id === "custom_daily"));
    assert.ok(bookmarks.some((item) => item.id === "gmail"));
    assert.strictEqual(
      bookmarks.find((item) => item.id === "custom_daily").url,
      "http://127.0.0.1:9999/report"
    );
  }

  {
    const manager = new LinkBookmarkManager({ bookmarksPath: createTempPath("links-match") });
    manager.saveBookmark({
      id: "daily_report",
      title: "日报系统",
      url: "http://127.0.0.1:9999/report",
      aliases: ["日报", "工作日报"],
      enabled: true
    });

    const match = manager.matchBookmark("打开日报页面");
    assert.strictEqual(match.bookmark.id, "daily_report");
    assert.ok(match.confidence >= 0.72);
  }

  {
    const manager = new LinkBookmarkManager({ bookmarksPath: createTempPath("links-natural") });

    assert.strictEqual(manager.matchBookmark("打开设计风格的选择。").bookmark.id, "design_systems");
    assert.strictEqual(manager.matchBookmark("设计风格。").bookmark.id, "design_systems");
    assert.strictEqual(manager.matchBookmark("打开设置系统。").bookmark.id, "design_systems");
    assert.strictEqual(manager.matchBookmark("打开任务检查的面板。").bookmark.id, "task_check_panel");
    assert.strictEqual(manager.matchBookmark("打开任务面板。").bookmark.id, "task_check_panel");
    assert.strictEqual(manager.matchBookmark("打开切割板。").bookmark.id, "task_check_panel");
    assert.strictEqual(manager.matchBookmark("打开T T X生成页面。").bookmark.id, "tts_dashboard");
    assert.strictEqual(manager.matchBookmark("打开我的 Gmail 邮箱。").bookmark.id, "gmail");
    assert.strictEqual(manager.matchBookmark("打开ChatGPT网页").bookmark.id, "chatgpt");
    assert.strictEqual(manager.matchBookmark("打开ChatGPT页面").bookmark.id, "chatgpt");
    assert.strictEqual(manager.matchBookmark("打开 chat gpt 页面").bookmark.id, "chatgpt");
  }

  {
    const bookmarksPath = createTempPath("links-merge-default-aliases");
    fs.writeFileSync(
      bookmarksPath,
      JSON.stringify({
        version: 1,
        bookmarks: [
          {
            id: "design_systems",
            title: "设计风格选择页",
            url: "http://127.0.0.1:17573/design-systems",
            aliases: ["设计风格"],
            enabled: true
          }
        ]
      })
    );
    const manager = new LinkBookmarkManager({ bookmarksPath });

    assert.strictEqual(manager.matchBookmark("打开设置系统。").bookmark.id, "design_systems");
  }

  {
    const bookmarksPath = createTempPath("links-merge-default-url");
    fs.writeFileSync(
      bookmarksPath,
      JSON.stringify({
        version: 1,
        bookmarks: [
          {
            id: "tts生成页面",
            title: "tts生成页面",
            url: "http://127.0.0.1:8787/tts-dashboard.html",
            aliases: ["tts生成"],
            enabled: true
          }
        ]
      })
    );
    const manager = new LinkBookmarkManager({ bookmarksPath });
    const bookmarks = manager.listBookmarks();
    const ttsBookmarks = bookmarks.filter((item) => item.url === "http://127.0.0.1:8787/tts-dashboard.html");

    assert.strictEqual(ttsBookmarks.length, 1);
    assert.strictEqual(ttsBookmarks[0].id, "tts生成页面");
    assert.strictEqual(manager.matchBookmark("打开T T X生成页面。").bookmark.id, "tts生成页面");
  }

  {
    const manager = new LinkBookmarkManager({ bookmarksPath: createTempPath("links-disabled") });
    manager.saveBookmark({
      id: "disabled_link",
      title: "停用页面",
      url: "http://127.0.0.1:9998",
      aliases: ["停用页面"],
      enabled: false
    });

    const match = manager.matchBookmark("打开停用页面");
    assert.strictEqual(match, null);
  }

  console.log("PASS link bookmarks");
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
