/**
 * 退出兜底看门狗（两层）。
 *
 * 1) 进程内定时器（尽力而为）：到点调 `app.exit(0)`。只在事件循环还活着时有效。
 * 2) 进程外杀手（真正的兜底）：`before-quit` 时 fork 一个脱离会话的 `sh`，
 *    到期后先校验「还是同一个进程」（比对 `/proc/<pid>/stat` 的 starttime，避免 pid 复用误杀），
 *    再 `kill -9`。即使主线程阻塞在内核调用里（NX6 实测卡在 `fuse_dev_release`）也能结束进程。
 *
 * 为什么必须要有第 2 层：2026-09-30 在 NX6 上实测，托盘「退出」把主线程卡在 AppImage 的 FUSE 卸载
 * 内核调用上，事件循环完全停摆 —— JS 定时器与 `app.exit(0)` 都执行不到，进程挂住 7 分钟以上。
 * 代价：被 SIGKILL 时 AppImage 挂载可能留残留，由部署脚本/手动清理收尾。
 *
 * 相关环境变量：
 *   CAPSWRITER_QUIT_WATCHDOG_MS  硬杀宽限毫秒数，默认 6000
 *   CAPSWRITER_QUIT_HARD_KILL=0  关闭进程外杀手（只保留进程内定时器）
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_QUIT_WATCHDOG_MS = 6000;
const DEFAULT_GRACEFUL_MARGIN_MS = 1000;
const MIN_GRACEFUL_MS = 1000;
const HARD_KILL_DISABLE_ENV = "CAPSWRITER_QUIT_HARD_KILL";
const QUIT_MARKER_FILE_NAME = "intentional-quit";

function resolveTimeoutMs(explicitTimeout, env) {
  const fromEnv = Number(env?.CAPSWRITER_QUIT_WATCHDOG_MS);
  const candidate = Number.isFinite(explicitTimeout) && explicitTimeout > 0
    ? explicitTimeout
    : fromEnv;
  if (!Number.isFinite(candidate) || candidate <= 0) return DEFAULT_QUIT_WATCHDOG_MS;
  return Math.round(candidate);
}

/** 进程内的优雅退出尝试要早于硬杀，给 app.exit(0) 一次机会。 */
function resolveGracefulMs(totalMs) {
  return Math.max(MIN_GRACEFUL_MS, totalMs - DEFAULT_GRACEFUL_MARGIN_MS);
}

/** 读 /proc/<pid>/stat 的 starttime（第 22 个字段），unix 下用于识别 pid 复用。 */
function readProcessStartTime(pid, fsRef = fs, logger = null) {
  try {
    const stat = fsRef.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    // 去掉 "pid (comm)" 后第一个字段是 state（原第 3 个字段），starttime 是原第 22 个。
    const startTime = afterComm[19] || "";
    if (!startTime) {
      logger?.warn?.("starttime 字段缺失，外部杀手将放弃身份校验（读不到即不杀）", { pid });
    }
    return startTime;
  } catch (error) {
    // 不吞异常：读不到 /proc 说明进程可能已退出或权限不足，必须留痕而非静默返回空值。
    logger?.warn?.("读取 /proc/<pid>/stat 失败，外部杀手将放弃身份校验（读不到即不杀）", {
      pid,
      error: error?.message || String(error),
    });
    return "";
  }
}

function buildKillerScript({ pid, startTime, graceSeconds }) {
  // 身份校验一律「失败即放弃」：expected / actual 任一为空都不能杀，
  // 否则 pid 被系统复用后会误杀无关进程（原写法用 && 串联，短路后反而落到 kill）。
  // 放弃击杀不影响退出：进程内定时器仍会 app.exit(0)，systemd 侧还有 TimeoutStopSec 兜底。
  return [
    `sleep ${graceSeconds}`,
    `pid=${pid}`,
    `expected='${startTime}'`,
    '[ -r "/proc/$pid/stat" ] || exit 0',
    `actual="$(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | cut -d' ' -f20)"`,
    '[ -n "$expected" ] || exit 0',
    '[ -n "$actual" ] || exit 0',
    '[ "$actual" = "$expected" ] || exit 0',
    'kill -9 "$pid" 2>/dev/null || true',
  ].join("\n");
}

function hardKillDisabled(env) {
  return String(env?.[HARD_KILL_DISABLE_ENV] ?? "1").trim() === "0";
}

/** node:test 会设置 NODE_TEST_CONTEXT；测试里不加这层保护会真的 kill 掉测试进程。 */
function isTestContext(env) {
  return String(env?.NODE_TEST_CONTEXT ?? "").trim() !== "";
}

function createQuitWatchdog({
  app,
  logger = null,
  timeoutMs,
  env = process.env,
  timerRef = setTimeout,
  clearRef = clearTimeout,
  spawnRef = spawn,
  platform = process.platform,
  pid = process.pid,
  fsRef = fs,
} = {}) {
  let timer = null;
  let hardKillChild = null;

  return {
    /** 装看门狗；重复调用只装一次。返回进程内定时器句柄（环境不支持时返回 null）。 */
    arm() {
      if (!app || typeof app.exit !== "function") return null;
      if (timer || hardKillChild) return timer;
      const totalMs = resolveTimeoutMs(timeoutMs, env);
      const gracefulMs = resolveGracefulMs(totalMs);

      timer = timerRef(() => {
        logger?.warn?.("退出收尾超时，先尝试强制结束进程", { timeoutMs: gracefulMs });
        app.exit(0);
      }, gracefulMs);
      timer?.unref?.();

      if (platform === "linux" && !hardKillDisabled(env) && !isTestContext(env)) {
        const startTime = readProcessStartTime(pid, fsRef, logger);
        const script = buildKillerScript({
          pid,
          startTime,
          graceSeconds: Math.max(1, Math.ceil(totalMs / 1000)),
        });
        try {
          hardKillChild = spawnRef("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
          hardKillChild?.unref?.();
          logger?.info?.("已装载退出外部杀手", { pid, timeoutMs: totalMs });
        } catch (error) {
          hardKillChild = null;
          logger?.warn?.("装载退出外部杀手失败，仅保留进程内看门狗", {
            error: error?.message || String(error),
          });
        }
      }

      return timer;
    },

    /** 取消进程内定时器（进程外杀手会自查进程是否仍存活，无需也无法取消）。 */
    disarm() {
      let cancelled = false;
      if (timer) {
        clearRef(timer);
        timer = null;
        cancelled = true;
      }
      if (hardKillChild) {
        hardKillChild = null;
      }
      return cancelled;
    },

    isArmed() {
      return Boolean(timer) || Boolean(hardKillChild);
    },
  };
}

/** 有意退出的标记文件路径；与启动器里的检查保持同一位置。 */
function resolveQuitMarkerPath(env = process.env) {
  const base = String(
    env.CAPSWRITER_QUIT_MARKER_DIR
      || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "capswriter-agx-client")
  );
  return path.join(base, QUIT_MARKER_FILE_NAME);
}

/**
 * 记下「这次是用户主动退出」。
 *
 * 为什么需要：systemd 单元按异常终止策略重启进程。托盘退出若最终以 SIGKILL 收尾（外部杀手兜底时），
 * 即使把 Restart 调成 on-abnormal 也会被当成异常而重新拉起，用户看到的就是「点了退出它又回来了」。
 * 启动器看到这个标记就消费掉并拒绝启动一次，从而保证主动退出真的退出；随后手动启动照常工作。
 */
function markIntentionalQuit({
  env = process.env,
  fsRef = fs,
  logger = null,
  now = () => new Date(),
  platform = process.platform,
} = {}) {
  // 只有 Linux 的安装/部署脚本会生成读取该标记的启动器；其它平台写标记只会留下无用文件。
  if (platform !== "linux") return null;
  const marker = resolveQuitMarkerPath(env);
  try {
    fsRef.mkdirSync(path.dirname(marker), { recursive: true });
    fsRef.writeFileSync(marker, `${now().toISOString()}\n`, "utf8");
    logger?.info?.("已标记有意退出（启动器据此不再自动拉起）", { marker });
    return marker;
  } catch (error) {
    logger?.warn?.("写入退出标记失败", { marker, error: error?.message || String(error) });
    return null;
  }
}

module.exports = {
  createQuitWatchdog,
  DEFAULT_QUIT_WATCHDOG_MS,
  resolveTimeoutMs,
  resolveGracefulMs,
  readProcessStartTime,
  buildKillerScript,
  resolveQuitMarkerPath,
  markIntentionalQuit,
  QUIT_MARKER_FILE_NAME,
};
