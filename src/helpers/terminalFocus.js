/**
 * 判断当前焦点窗口是不是终端
 *
 * 为什么需要这个：长文本整理会给文本加换行。但粘贴到终端里，
 * **换行等于回车**——一段带换行的文本会变成连续执行多条命令。
 * 所以终端场景必须降级成"不排版"，而不是"少排版"。
 *
 * 判据以 WM_CLASS 为主。窗口标题只做兜底，且用更严格的模式：
 * 标题里出现 bash / zsh 之类的词太常见（浏览器标签、文档正文），
 * 拿它当主判据会误伤。
 */

const TERMINAL_CLASS_PATTERN = new RegExp(
  [
    "gnome-terminal",
    "ptyxis",
    "kgx",
    "konsole",
    "xterm",
    "alacritty",
    "kitty",
    "wezterm",
    "terminator",
    "tilix",
    "urxvt",
    "rxvt",
    "st-256color",
    "qterminal",
    "lxterminal",
    "mate-terminal",
    "xfce4-terminal",
    "hyper",
    "tabby",
  ].join("|")
);

// 标题兜底：要求"纯词 + 可能带路径/参数"，避免匹配到正文里的普通句子。
const TERMINAL_TITLE_PATTERN = /(?:^|[\s\-–—|:])(?:bash|zsh|fish|sh|tmux|ssh|gdb|python3?|node|vim?|nvim|ipython|pwsh|powershell|cmd)(?:\s|$|[:@.])/i;

// 终端标题都很短。设个上限，避免拿"如何处理 bash 脚本"这种
// 浏览器标签或文档标题去匹配。含中日韩字符的一律排除。
const TERMINAL_TITLE_MAX_CHARS = 60;
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

// shell 提示符形态：user@host: ~/path
const SHELL_PROMPT_PATTERN = /^[\w.-]+@[\w.-]+:/;

function normalizeWindowClass(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeWindowTitle(value) {
  return String(value || "").trim();
}

/**
 * @param {string} windowClass WM_CLASS（形如 "gnome-terminal-server gnome-terminal"）
 * @param {string} [windowTitle] _NET_WM_NAME，可选
 * @returns {boolean}
 */
function isTerminalWindow(windowClass, windowTitle) {
  const cls = normalizeWindowClass(windowClass);
  if (cls && TERMINAL_CLASS_PATTERN.test(cls)) return true;

  // class 缺失或未命中时才看标题，降低误伤面
  if (!cls) {
    const title = normalizeWindowTitle(windowTitle);
    if (
      title &&
      title.length <= TERMINAL_TITLE_MAX_CHARS &&
      !CJK_PATTERN.test(title) &&
      (SHELL_PROMPT_PATTERN.test(title) || TERMINAL_TITLE_PATTERN.test(title))
    ) {
      return true;
    }
  }
  return false;
}

module.exports = {
  isTerminalWindow,
  normalizeWindowClass,
  TERMINAL_CLASS_PATTERN,
  TERMINAL_TITLE_PATTERN,
};
