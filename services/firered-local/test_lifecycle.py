"""模型生命周期回归：用假模型检查时间边界和取消，不发送音频。"""
import asyncio
import json
import threading
import time
import unittest
from unittest.mock import patch
import server


class LifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        server.engine = None
        server.busy = server.loading = server.unloading = False
        server.model_lock = asyncio.Lock()
        server.last_used = time.monotonic()

    async def asyncTearDown(self):
        await server.run(server.release_model)

    async def test_status_does_not_load_or_refresh_idle_timer(self):
        before = server.last_used
        with patch.object(server, 'Engine') as factory:
            status = await server.status()
            self.assertEqual(status['status'], 'idle')
            self.assertTrue(status['service_ready'])
            self.assertEqual(status['idle_unload_seconds'], 600)
            factory.assert_not_called()
        self.assertEqual(server.last_used, before)

    async def test_load_once_unload_after_ten_minutes_then_reload(self):
        with patch.object(server, 'Engine', side_effect=object) as factory:
            await asyncio.gather(server.ensure_model(), server.ensure_model())
            self.assertEqual(factory.call_count, 1)
            server.last_used = time.monotonic() - 599
            self.assertFalse(await server.unload_if_idle())
            server.last_used = time.monotonic() - 601
            server.busy = True
            self.assertFalse(await server.unload_if_idle())
            server.busy = False
            self.assertTrue(await server.unload_if_idle())
            self.assertIsNone(server.engine)
            await server.ensure_model()
            self.assertEqual(factory.call_count, 2)

    async def test_loading_failure_can_retry(self):
        with patch.object(server, 'Engine', side_effect=[RuntimeError('load failed'), object()]):
            with self.assertRaises(RuntimeError):
                await server.ensure_model()
            self.assertFalse(server.loading)
            self.assertIsNone(server.engine)
            await server.ensure_model()
            self.assertIsNotNone(server.engine)

    async def test_cancel_during_cold_start_never_emits_ready(self):
        entered, release = threading.Event(), threading.Event()
        messages = []
        incoming = asyncio.Queue()

        class Socket:
            headers = {'origin': 'file://'}
            scope = {}
            async def accept(self, **kwargs): pass
            async def receive(self): return await incoming.get()
            async def send_json(self, value): messages.append(value)
            async def close(self, **kwargs): pass

        def load():
            entered.set()
            if not release.wait(3):
                raise TimeoutError('test worker timed out')
            return object()

        incoming.put_nowait({'type': 'websocket.receive', 'text': json.dumps({'type': 'start', 'sample_rate': 16000})})
        with patch.object(server, 'Engine', side_effect=load):
            session = asyncio.create_task(server.realtime(Socket()))
            try:
                for _ in range(100):
                    if entered.is_set(): break
                    await asyncio.sleep(.01)
                self.assertTrue(entered.is_set())
                incoming.put_nowait({'type': 'websocket.receive', 'text': '{"type":"cancel"}'})
                await asyncio.sleep(.02)
                self.assertTrue(server.busy)
                release.set()
                await asyncio.wait_for(session, 2)
                self.assertFalse(server.busy)
                self.assertEqual([event['type'] for event in messages], ['loading'])
            finally:
                release.set()
                await asyncio.wait_for(session, 2)


if __name__ == '__main__':
    unittest.main()
