/**
 * 退出兜底看门狗。
 *
 * 托盘「退出」走 Electron 的 app.quit()：before-quit → 关闭所有窗口 → will-quit → 进程退出。
 * 收尾阶段在 AppImage(FUSE) 环境下可能卡死（NX6 实测主线程停在 fuse_dev_release，
 * will-quit 的清理日志之后进程既不退出也不再输出），用户侧表现为「点了退出退不掉」。
 *
 * 这里在退出一开始就装一个定时器：到点仍未退出就 app.exit(0) 强制结束，
 * 让任何清理环节挂死都不再把用户困在进程里。定时器 unref，不会反过来拖住正常退出。
 */

const DEFAULT_QUIT_WATCHDOG_MS = 5000;

function resolveTimeoutMs(explicitTimeout, env) {
  const fromEnv = Number(env?.CAPSWRITER_QUIT_WATCHDOG_MS);
  const candidate = Number.isFinite(explicitTimeout) && explicitTimeout > 0
    ? explicitTimeout
    : fromEnv;
  if (!Number.isFinite(candidate) || candidate <= 0) return DEFAULT_QUIT_WATCHDOG_MS;
  return Math.round(candidate);
}

function createQuitWatchdog({
  app,
  logger = null,
  timeoutMs,
  env = process.env,
  timerRef = setTimeout,
  clearRef = clearTimeout,
} = {}) {
  let timer = null;

  return {
    /** 装看门狗；重复调用只装一次。返回定时器句柄（不可用环境返回 null）。 */
    arm() {
      if (!app || typeof app.exit !== "function") return null;
      if (timer) return timer;
      const budget = resolveTimeoutMs(timeoutMs, env);
      timer = timerRef(() => {
        logger?.warn?.("退出收尾超时，强制结束进程", { timeoutMs: budget });
        app.exit(0);
      }, budget);
      timer?.unref?.();
      return timer;
    },

    /** 取消看门狗（正常退出时不需要，留给测试与将来的显式收尾）。 */
    disarm() {
      if (!timer) return false;
      clearRef(timer);
      timer = null;
      return true;
    },

    isArmed() {
      return Boolean(timer);
    },
  };
}

module.exports = { createQuitWatchdog, DEFAULT_QUIT_WATCHDOG_MS, resolveTimeoutMs };
