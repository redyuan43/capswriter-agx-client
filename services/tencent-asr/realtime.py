"""CapsWriter PCM 协议到腾讯 WebSocket 的适配。"""
import asyncio
import json
import math
import time
import uuid

from aiohttp import WSMsgType
from provider import STANDARD, MODEL2, ProviderError

FRAME_BYTES = 6400
BYTES_PER_SECOND = 32000
MAX_PENDING = BYTES_PER_SECOND * 10


class ProtocolError(Exception):
    pass


def result_payload(kind, text, engine, session_id, seconds):
    return {"type": kind, "success": True, "text": text, "asr_text": text,
            "final_text": text, "partial_text": text if kind == "partial" else "",
            "engine": engine, "provider": "tencent", "session_id": session_id,
            "duration": seconds, "optimize_mode": "none", "optimized_text": ""}


def hotwords(value):
    # 腾讯格式为“词|权重”，沿用明确权重；普通逗号分隔词统一赋予 5。
    if not value:
        return ""
    if not isinstance(value, str) or len(value) > 10000:
        raise ProtocolError("热词格式或长度无效")
    entries = []
    for word in value.replace("，", ",").replace("\n", ",").split(","):
        word = word.strip()
        if not word:
            continue
        if "|" in word:
            term, weight = word.rsplit("|", 1)
            if not term or not weight.isdigit() or not 1 <= int(weight) <= 11:
                raise ProtocolError("热词权重必须为 1 到 11")
            entries.append(word)
        else:
            entries.append(word + "|5")
    if len(entries) > 128:
        raise ProtocolError("热词最多 128 个")
    return ",".join(entries)


async def serve_realtime(client, provider, quota):
    session_id = str(uuid.uuid4())
    message = await client.receive(timeout=10)
    if message.type != WSMsgType.TEXT:
        raise ProtocolError("首条消息必须是 start")
    try:
        start = json.loads(message.data)
    except (ValueError, TypeError):
        raise ProtocolError("start 消息不是有效 JSON") from None
    if not isinstance(start, dict) or start.get("type") != "start" or start.get("sample_rate", 16000) != 16000:
        raise ProtocolError("需要 start 消息和 16000 Hz 单声道 PCM16 音频")
    # 这是纯 ASR 服务。告知客户端能力，不伪装成已完成润色或翻译。
    if start.get("optimize_mode", "none") not in ("none", "", None, False):
        raise ProtocolError("腾讯连接仅提供 ASR，请关闭润色/翻译模式")
    words = hotwords(start.get("hotword", ""))
    engine = quota.status()["engine"]
    for attempt in range(2):
        # 4004 仅在尚未发送音频时允许换到 2.0，不重放已收费音频。
        async with provider.realtime(engine, str(uuid.uuid4()), words) as upstream:
            hello = json.loads(await asyncio.wait_for(upstream.recv(), 10))
            if hello.get("code") != 0:
                if hello.get("code") == 4004 and engine == STANDARD and attempt == 0:
                    quota.exhausted()
                    engine = MODEL2
                    continue
                raise ProviderError(hello.get("code", "handshake_invalid"))
            quota.begin(session_id, engine)
            await client.send_json({"type": "ready", "success": True, "engine": engine,
                                    "provider": "tencent", "session_id": session_id,
                                    "quota": quota.status()["quota"],
                                    "capabilities": {"asr": True, "optimize": False, "translate": False}})
            await relay(client, upstream, quota, session_id, engine)
            return


async def relay(client, upstream, quota, session_id, engine):
    queue = asyncio.Queue()
    pending = sent = 0
    finishing = False
    cancelled = False
    sent_end = asyncio.Event()
    slices = {}
    state = "failed"
    last_recorded = 0
    tasks = set()

    async def receive_client():
        nonlocal pending, finishing, cancelled
        while True:
            msg = await client.receive(timeout=15)
            if msg.type == WSMsgType.BINARY:
                if finishing:
                    raise ProtocolError("finish 之后不能再发送音频")
                if len(msg.data) % 2:
                    raise ProtocolError("PCM16 音频字节数必须为偶数")
                if pending + len(msg.data) > MAX_PENDING:
                    raise ProtocolError("音频发送过快，积压超过 10 秒")
                pending += len(msg.data)
                queue.put_nowait(msg.data)
            elif msg.type == WSMsgType.TEXT:
                try:
                    command = json.loads(msg.data)
                except ValueError:
                    raise ProtocolError("控制消息不是有效 JSON") from None
                if not isinstance(command, dict):
                    raise ProtocolError("控制消息必须是 JSON 对象")
                if command.get("type") == "finish" and not finishing:
                    finishing = True
                    queue.put_nowait(None)
                elif command.get("type") == "cancel":
                    cancelled = True
                    return
                else:
                    raise ProtocolError("不支持的或重复的控制消息")
            else:
                cancelled = True
                return

    async def send_audio():
        nonlocal pending, sent, last_recorded
        buffer = bytearray()
        beginning = None
        eof = False
        while not eof or buffer:
            if not eof and len(buffer) < FRAME_BYTES:
                chunk = await queue.get()
                if chunk is None:
                    eof = True
                else:
                    buffer.extend(chunk)
                if len(buffer) < FRAME_BYTES and not eof:
                    continue
            if not buffer:
                break
            frame = bytes(buffer[:FRAME_BYTES])
            del buffer[:len(frame)]
            if beginning is None:
                beginning = time.monotonic()
            await asyncio.sleep(max(0, beginning + sent / BYTES_PER_SECOND - time.monotonic()))
            await upstream.send(frame)
            sent += len(frame)
            pending -= len(frame)
            if sent - last_recorded >= BYTES_PER_SECOND:
                quota.record(session_id, math.ceil(sent / BYTES_PER_SECOND))
                last_recorded = sent
            if sent > BYTES_PER_SECOND * 7200:
                raise ProtocolError("单次录音不能超过 2 小时")
        if beginning is not None:
            await asyncio.sleep(max(0, beginning + sent / BYTES_PER_SECOND - time.monotonic()))
        await upstream.send('{"type":"end"}')
        sent_end.set()

    async def receive_results():
        async for raw in upstream:
            data = json.loads(raw)
            if data.get("code", 0) != 0:
                if data.get("code") == 4004 and engine == STANDARD:
                    quota.exhausted()
                raise ProviderError(data.get("code"))
            result = data.get("result") or {}
            if "voice_text_str" in result:
                # index 是分句编号，同一编号的新内容覆盖旧内容，避免 partial 重复拼接。
                slices[int(result.get("index", 0))] = str(result["voice_text_str"])
                text = "".join(slices[index] for index in sorted(slices))
                if text and data.get("final") != 1:
                    await client.send_json(result_payload("partial", text, engine, session_id, sent / BYTES_PER_SECOND))
            if data.get("final") == 1:
                if not finishing:
                    raise ProtocolError("腾讯在录音结束前关闭了会话")
                return "".join(slices[index] for index in sorted(slices))
        raise ProviderError("closed_before_final")

    async def final_deadline():
        await sent_end.wait()
        await asyncio.sleep(12)
        raise ProviderError("final_timeout")

    try:
        reader = asyncio.create_task(receive_client())
        sender = asyncio.create_task(send_audio())
        receiver = asyncio.create_task(receive_results())
        deadline = asyncio.create_task(final_deadline())
        tasks = {reader, sender, receiver, deadline}
        waiting = set(tasks)
        while waiting:
            done, waiting = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
            # 先传播异常，避免某个任务失败而另一个成功导致吞错。
            for task in done:
                task.result()
            if reader in done:
                state = "cancelled"
                return
            if receiver in done:
                state = "completed"
                await client.send_json(result_payload("final", receiver.result(), engine, session_id, sent / BYTES_PER_SECOND))
                return
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        quota.record(session_id, math.ceil(sent / BYTES_PER_SECOND), "cancelled" if cancelled else state)
