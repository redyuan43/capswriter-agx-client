from state import STATE, Runtime
import asyncio
import contextlib
import io
import json
import tempfile
import time
import unittest
import wave
from datetime import datetime
from pathlib import Path

import aiohttp
from aiohttp.test_utils import TestClient, TestServer

from app import create_app
from provider import STANDARD, MODEL2
from quota import CHINA, Quota, free_seconds


def package(rest=18000, month="2026-09", **overrides):
    return dict(Name="实时语音识别免费包5小时", SubProductCode="sp_asr_realtime_prepay",
                Unit="free|v3|715|monthly|test|1|", RestNum=rest, TotalNum=18000,
                EffectiveTime=f"{month}-01 00:00:00", ExpiryTime=f"{month}-30 23:59:59", **overrides)


class QuotaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "usage.db")
        self.now = datetime(2026, 9, 19, tzinfo=CHINA).timestamp()
        self.quota = Quota(self.path, lambda: self.now)

    def tearDown(self):
        self.quota.close()
        self.tmp.cleanup()

    def test_filters_paid_expired_other_products(self):
        paid = {**package(), "Unit": "paid|123"}
        wrong = {**package(), "SubProductCode": "sp_asr_offline_flash"}
        self.assertEqual(free_seconds([package(17992), package(month="2026-08"), paid, wrong], self.now), 17992)
        self.assertIsNone(free_seconds([paid, wrong], self.now))
        self.assertEqual(free_seconds([package(0)], self.now), 0)
        with self.assertRaises(ValueError):
            free_seconds([package(-1)], self.now)

    def test_unknown_failed_stale_and_month_rollover(self):
        self.assertEqual(self.quota.status()["engine"], MODEL2)
        self.quota.observe(18000)
        self.assertEqual(self.quota.status()["engine"], STANDARD)
        self.quota.fail()
        self.assertEqual(self.quota.status()["engine"], MODEL2)
        self.quota.observe(18000)
        self.now += 91
        self.assertEqual(self.quota.status()["engine"], MODEL2)
        self.quota.observe(18000)
        self.quota.exhausted()
        self.assertEqual(self.quota.status()["engine"], MODEL2)
        self.now = datetime(2026, 10, 1, tzinfo=CHINA).timestamp()
        self.assertFalse(self.quota.status()["quota"]["known"])
        self.quota.observe(18000)
        self.assertEqual(self.quota.status()["engine"], STANDARD)

    def test_concurrent_reservation_released_and_usage_not_double_counted(self):
        self.quota.observe(180)
        self.assertEqual(self.quota.begin("first"), STANDARD)
        self.assertEqual(self.quota.begin("second"), MODEL2)
        self.quota.record("first", 10, "completed")
        self.assertEqual(self.quota.status()["quota"]["remaining_seconds"], 170)
        self.quota.observe(180)  # 云端仍然返回旧读数。
        self.assertEqual(self.quota.status()["quota"]["remaining_seconds"], 170)
        self.quota.observe(170)
        self.assertEqual(self.quota.status()["quota"]["remaining_seconds"], 170)

    def test_restart_does_not_restore_consumed_or_inflight_credits(self):
        self.quota.observe(180)
        self.quota.begin("interrupted")
        self.quota.record("interrupted", 5)
        self.quota.close()
        self.quota = Quota(self.path, lambda: self.now)
        self.assertEqual(self.quota.status()["engine"], MODEL2)
        self.quota.observe(180)
        self.assertEqual(self.quota.status()["quota"]["remaining_seconds"], 60)
        self.assertEqual(self.quota.status()["engine"], MODEL2)


class FakeUpstream:
    def __init__(self, hello=0, hang=False):
        self.hello = hello
        self.hang = hang
        self.messages = asyncio.Queue()
        self.frames = []
        self.times = []
        self.closed = False

    async def recv(self):
        return json.dumps({"code": self.hello})

    async def send(self, value):
        if isinstance(value, bytes):
            self.frames.append(value)
            self.times.append(time.monotonic())
            if any(value):
                n = len(self.frames)
                result = {"index": 0 if n < 3 else 1, "voice_text_str": "老" if n == 1 else "老王" if n == 2 else "你好"}
                await self.messages.put({"code": 0, "result": result})
        elif not self.hang:
            await self.messages.put({"code": 0, "final": 1})

    def __aiter__(self):
        return self

    async def __anext__(self):
        return json.dumps(await self.messages.get())


class FakeProvider:
    def __init__(self):
        self.connections = []
        self.unknown = False
        self.reject_standard = False
        self.hang = False
        self.flash_inputs = []

    async def resources(self):
        if self.unknown:
            raise OSError("quota unavailable")
        return [package()]

    @contextlib.asynccontextmanager
    async def realtime(self, engine, voice_id, hotword=""):
        upstream = FakeUpstream(4004 if self.reject_standard and engine == STANDARD else 0, self.hang)
        self.connections.append((engine, upstream))
        try:
            yield upstream
        finally:
            upstream.closed = True

    async def flash(self, audio, voice_format, hotword=""):
        self.flash_inputs.append((audio, voice_format))
        return {"code": 0, "flash_result": [{"text": "测试文件"}]}


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.provider = FakeProvider()
        self.app = create_app(str(Path(self.tmp.name) / "db"), self.provider)
        self.app[STATE].quota.clock = lambda: datetime(2026, 9, 19, tzinfo=CHINA).timestamp()
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def connect(self):
        ws = await self.client.ws_connect("/api/asr/realtime")
        await ws.send_json({"type": "start", "sample_rate": 16000})
        ready = await ws.receive_json()
        self.assertEqual(ready["type"], "ready")
        return ws, ready

    async def collect(self, ws):
        events = []
        while True:
            event = await ws.receive_json(timeout=15)
            events.append(event)
            if event["type"] in ("final", "error"):
                return events

    async def test_burst_is_paced_and_partial_revisions_are_not_duplicated(self):
        ws, ready = await self.connect()
        self.assertEqual(ready["engine"], STANDARD)
        await ws.send_bytes(b"\x01\x00" * 16000)
        await ws.send_json({"type": "finish"})
        events = await self.collect(ws)
        self.assertEqual(events[-1]["text"], "老王你好")
        _, upstream = self.provider.connections[-1]
        self.assertEqual(len(b"".join(upstream.frames)), 32000)
        self.assertGreaterEqual(upstream.times[-1] - upstream.times[0], .75)
        self.assertEqual(events[-1]["duration"], 1)
        await ws.close()

    async def test_silence_returns_successful_empty_final(self):
        ws, _ = await self.connect()
        await ws.send_bytes(bytes(6400))
        await ws.send_json({"type": "finish"})
        result = (await self.collect(ws))[-1]
        self.assertTrue(result["success"])
        self.assertEqual(result["text"], "")
        await ws.close()

    async def test_legacy_connection_probe_accepts_false_optimization(self):
        ws = await self.client.ws_connect("/api/asr/realtime")
        await ws.send_json({"type": "start", "sample_rate": 16000, "language": "zh", "optimize_mode": False})
        self.assertEqual((await ws.receive_json())["type"], "ready")
        for _ in range(10):
            await ws.send_bytes(bytes(3200))
        await ws.send_json({"type": "finish"})
        self.assertEqual((await self.collect(ws))[-1]["type"], "final")
        await ws.close()

    async def test_quota_failure_uses_model2(self):
        self.app[STATE].quota.fail()
        ws, ready = await self.connect()
        self.assertEqual(ready["engine"], MODEL2)
        await ws.send_json({"type": "cancel"})
        await ws.close()

    async def test_standard_exhaustion_retries_only_before_audio(self):
        self.provider.reject_standard = True
        ws, ready = await self.connect()
        self.assertEqual(ready["engine"], MODEL2)
        self.assertEqual([x[0] for x in self.provider.connections], [STANDARD, MODEL2])
        self.assertEqual(self.provider.connections[0][1].frames, [])
        await ws.send_json({"type": "cancel"})
        await ws.close()

    async def test_cancel_releases_connection(self):
        ws, _ = await self.connect()
        await ws.send_bytes(bytes(6400))
        await ws.send_json({"type": "cancel"})
        await ws.receive()
        await ws.close()
        self.assertTrue(self.provider.connections[-1][1].closed)

    async def test_concurrent_admission_is_bounded(self):
        async def open_one():
            try:
                return await self.client.ws_connect("/api/asr/realtime")
            except aiohttp.WSServerHandshakeError as error:
                return error.status
        connections = await asyncio.gather(*(open_one() for _ in range(6)))
        accepted = [connection for connection in connections if not isinstance(connection, int)]
        self.assertEqual(len(accepted), 4)
        self.assertEqual([connection for connection in connections if isinstance(connection, int)], [429, 429])
        for ws in accepted:
            await ws.close()

    async def test_invalid_sample_rate_and_foreign_origin_rejected(self):
        ws = await self.client.ws_connect("/api/asr/realtime")
        await ws.send_json({"type": "start", "sample_rate": 48000})
        self.assertEqual((await ws.receive_json())["type"], "error")
        await ws.close()
        response = await self.client.get("/api/status", headers={"Origin": "https://untrusted.example"})
        self.assertEqual(response.status, 403)
        self.assertEqual(self.provider.connections, [])

    async def test_audio_backlog_is_rejected_instead_of_silently_dropped(self):
        ws, _ = await self.connect()
        for _ in range(3):
            await ws.send_bytes(bytes(160000))
        result = (await self.collect(ws))[-1]
        self.assertEqual(result["type"], "error")
        await ws.close()

    async def test_file_upload_converts_and_uses_ordinary_flash(self):
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(bytes(32000))
        for endpoint in ("/api/asr/transcribe", "/api/asr/transcribe-and-optimize-stream"):
            form = aiohttp.FormData()
            form.add_field("audio", audio.getvalue(), filename="audio.wav", content_type="audio/wav")
            response = await self.client.post(endpoint, data=form)
            self.assertEqual(response.status, 200)
            body = await response.text()
            self.assertIn("测试文件", body if "stream" in endpoint else json.loads(body)["text"])
        self.assertTrue(all(fmt == "mp3" for _, fmt in self.provider.flash_inputs))

    async def test_final_timeout_closes_upstream_without_fabricated_success(self):
        self.provider.hang = True
        ws, _ = await self.connect()
        await ws.send_bytes(bytes(6400))
        await ws.send_json({"type": "finish"})
        result = (await self.collect(ws))[-1]
        self.assertEqual(result["type"], "error")
        self.assertIn("final_timeout", result["error"])
        await ws.close()


if __name__ == "__main__":
    unittest.main()
