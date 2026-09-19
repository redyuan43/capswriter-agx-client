"""以云端免费资源包为准，本地账本防止并发或重启重复使用已计入的额度。"""
import math
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from provider import STANDARD, MODEL2

CHINA = ZoneInfo("Asia/Shanghai")
RESERVE_SECONDS = 120


def month_at(stamp):
    return datetime.fromtimestamp(stamp, CHINA).strftime("%Y-%m")


def free_seconds(packages, stamp, product="sp_asr_realtime_prepay"):
    """DescribePidOrders 的 RestNumFloat 单位为秒；付费包和过期包不能充当免费额度。"""
    now = datetime.fromtimestamp(stamp, CHINA)
    balances = []
    for package in packages:
        if package.get("SubProductCode") != product or not package.get("Unit", "").startswith("free|"):
            continue
        start = datetime.strptime(package["EffectiveTime"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=CHINA)
        end = datetime.strptime(package["ExpiryTime"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=CHINA)
        if not start <= now <= end:
            continue
        value = float(package.get("RestNumFloat", package["RestNum"]))
        total = float(package.get("TotalNumFloat", package["TotalNum"]))
        if not math.isfinite(value) or not 0 <= value <= total:
            raise ValueError("资源包余额无效")
        balances.append(value)
    return sum(balances) if balances else None


class Quota:
    def __init__(self, path, clock=time.time):
        self.clock = clock
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, month TEXT, engine TEXT,
                seconds REAL DEFAULT 0, state TEXT DEFAULT 'active');
            CREATE TABLE IF NOT EXISTS credits (
                month TEXT PRIMARY KEY, remaining REAL, baseline REAL, blocked INTEGER DEFAULT 0);
        """)
        # 崩溃中断的会话按至少预留时长保守计入；不在重启时凭空恢复额度。
        self.db.execute("UPDATE sessions SET seconds=max(seconds, ?), state='interrupted' WHERE state='active'", (RESERVE_SECONDS,))
        self.db.commit()
        self.checked_at = 0
        self.checked_month = ""
        self.known = False
        self.reason = "尚未取得云端免费额度"
        self.cloud_seconds = None

    def total(self, month, engine=STANDARD):
        return self.db.execute("SELECT coalesce(sum(seconds),0) FROM sessions WHERE month=? AND engine=?", (month, engine)).fetchone()[0]

    def observe(self, seconds):
        stamp = self.clock()
        month = month_at(stamp)
        self.checked_at, self.checked_month = stamp, month
        self.known = seconds is not None
        self.cloud_seconds = seconds
        if seconds is None:
            self.reason = "未查到当前有效免费资源包，使用 2.0"
            return
        if not math.isfinite(seconds) or seconds < 0:
            self.fail("云端额度数据无效，使用 2.0")
            return
        used = self.total(month)
        old = self.db.execute("SELECT remaining,baseline FROM credits WHERE month=?", (month,)).fetchone()
        # 云端计费可能延迟，同月余额只收紧，不因旧读数回弹。
        remaining = min(seconds, max(0, old[0] - (used - old[1]))) if old else seconds
        self.db.execute("INSERT INTO credits(month,remaining,baseline) VALUES(?,?,?) ON CONFLICT(month) DO UPDATE SET remaining=excluded.remaining, baseline=excluded.baseline", (month, remaining, used))
        self.db.commit()
        self.reason = "已确认云端免费额度"

    def fail(self, reason="额度查询失败，使用 2.0"):
        self.known = False
        self.reason = reason

    def status(self):
        now = self.clock()
        month = month_at(now)
        fresh = self.known and self.checked_month == month and now - self.checked_at <= 90
        row = self.db.execute("SELECT remaining,baseline,blocked FROM credits WHERE month=?", (month,)).fetchone()
        remaining = None
        if fresh and row:
            remaining = max(0, row[0] - (self.total(month) - row[1]))
            reserved = self.db.execute("SELECT coalesce(sum(max(0, ?-seconds)),0) FROM sessions WHERE month=? AND engine=? AND state='active'", (RESERVE_SECONDS, month, STANDARD)).fetchone()[0]
            available = max(0, remaining - reserved)
            if row[2]:
                available = remaining = 0
        else:
            available = 0
        engine = STANDARD if fresh and available >= RESERVE_SECONDS else MODEL2
        if fresh:
            message = f"免费余量约 {int(remaining or 0)} 秒"
            if engine == MODEL2:
                message += "，已耗尽或接近耗尽，使用 2.0"
        else:
            message = self.reason if not self.known else "额度已过期，使用 2.0"
        return {"engine": engine, "quota": {"known": bool(fresh), "remaining_seconds": remaining,
                "cloud_remaining_seconds": self.cloud_seconds if fresh else None,
                "checked_at": self.checked_at, "month": month, "message": message,
                "reserve_seconds": RESERVE_SECONDS}, "usage_seconds": {
                    "standard": self.total(month), "model2": self.total(month, MODEL2),
                    "flash": self.total(month, "flash_16k_zh")}}

    def begin(self, session_id, engine=None):
        engine = engine or self.status()["engine"]
        self.db.execute("INSERT INTO sessions(id,month,engine) VALUES(?,?,?)", (session_id, month_at(self.clock()), engine))
        self.db.commit()
        return engine

    def record(self, session_id, seconds, state="active"):
        self.db.execute("UPDATE sessions SET seconds=max(seconds,?),state=? WHERE id=?", (seconds, state, session_id))
        self.db.commit()

    def exhausted(self):
        month = month_at(self.clock())
        self.db.execute("INSERT INTO credits(month,remaining,baseline,blocked) VALUES(?,0,?,1) ON CONFLICT(month) DO UPDATE SET blocked=1", (month, self.total(month)))
        self.db.commit()

    def close(self):
        self.db.close()
