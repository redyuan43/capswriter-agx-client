const { ipcMain, shell } = require("electron");
const { isHttpUrl } = require("../../../helpers/linkBookmarkManager");

function registerLinkBookmarkHandlers(ctx) {
  ipcMain.handle("get-link-bookmarks", () => {
    return {
      success: true,
      bookmarks: ctx.linkBookmarkManager.listBookmarks(),
      path: ctx.linkBookmarkManager.bookmarksPath
    };
  });

  ipcMain.handle("save-link-bookmark", (_event, bookmark = {}) => {
    return ctx.linkBookmarkManager.saveBookmark(bookmark);
  });

  ipcMain.handle("delete-link-bookmark", (_event, id) => {
    return ctx.linkBookmarkManager.deleteBookmark(String(id || ""));
  });

  ipcMain.handle("reload-link-bookmarks", () => {
    return {
      success: true,
      bookmarks: ctx.linkBookmarkManager.listBookmarks(),
      path: ctx.linkBookmarkManager.bookmarksPath
    };
  });

  ipcMain.handle("open-link-bookmark", async (_event, payload = {}) => {
    const id = typeof payload === "string" ? payload : payload.id;
    const bookmark = ctx.linkBookmarkManager.getBookmark(String(id || ""));
    if (!bookmark) {
      return { success: false, error: "链接不存在" };
    }
    if (bookmark.enabled === false) {
      return { success: false, error: "链接已禁用" };
    }
    if (!isHttpUrl(bookmark.url)) {
      return { success: false, error: "只支持 http/https 链接" };
    }
    await shell.openExternal(bookmark.url);
    return { success: true, bookmark };
  });
}

module.exports = { registerLinkBookmarkHandlers };
