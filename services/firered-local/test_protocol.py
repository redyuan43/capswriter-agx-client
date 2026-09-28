"""无模型、无音频的控制协议回归检查。"""
import json
import unittest
import server


class Socket:
    headers = {'origin': 'file://'}
    scope = {'subprotocols': ['qwen3-asr-v1']}

    def __init__(self, command):
        self.command = command
        self.messages = []
        self.closed = False

    async def accept(self, **kwargs):
        pass

    async def receive(self):
        return {'type': 'websocket.receive', 'text': json.dumps(self.command)}

    async def send_json(self, payload):
        self.messages.append(payload)

    async def close(self, **kwargs):
        self.closed = True


class ProtocolTest(unittest.IsolatedAsyncioTestCase):
    async def test_non_object_commands_report_error_and_release_connection(self):
        for command in (None, [], 'start', 42):
            with self.subTest(command=command):
                socket = Socket(command)
                await server.realtime(socket)
                self.assertTrue(socket.closed)
                self.assertEqual(socket.messages[0]['type'], 'error')
                self.assertIn('JSON 对象', socket.messages[0]['error'])
                self.assertFalse(server.busy)

    async def test_rejected_connection_does_not_release_another_sessions_lock(self):
        server.busy = True
        try:
            socket = Socket({'type': 'start', 'sample_rate': 16000})
            await server.realtime(socket)
            self.assertEqual(socket.messages[0]['type'], 'error')
            self.assertTrue(server.busy)
        finally:
            server.busy = False


if __name__ == '__main__':
    unittest.main()
