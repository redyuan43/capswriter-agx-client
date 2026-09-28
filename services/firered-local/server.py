"""NX6 回环 ASR 服务。复用客户端协议，模型之外的处理全部留在客户端。"""
import asyncio
import json
import logging
import os
import threading
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from engine import Engine

log = logging.getLogger('firered-local')
pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='firered')
engine = None
busy = False
CAPABILITIES = {'asr': True, 'optimize': False, 'translate': False, 'native_hotwords': False}


async def run(fn, *args):
    future = asyncio.get_running_loop().run_in_executor(pool, fn, *args)
    try:
        return await asyncio.shield(future)
    except asyncio.CancelledError:
        await future
        raise


@asynccontextmanager
async def lifespan(app):
    global engine
    engine = await run(Engine)
    log.info('FireRed2 模型已就绪，仅接受本机连接')
    yield
    pool.shutdown(wait=True)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(CORSMiddleware, allow_origins=['null', 'file://'],
                   allow_origin_regex=r'http://(localhost|127\.0\.0\.1)(:\d+)?',
                   allow_methods=['GET', 'POST'], allow_headers=['Content-Type', 'Accept'])


@app.get('/health')
@app.get('/api/health')
@app.get('/api/status')
@app.get('/api/asr/status')
async def status():
    return {'status': 'ready' if engine else 'loading', 'ready': engine is not None,
            'asr_ready': engine is not None, 'provider': 'firered2', 'busy': busy,
            'partial_mode': 'vad_segment', 'capabilities': CAPABILITIES}


def payload(kind, text, raw, session_id, samples):
    return {'type': kind, 'stage': 'done' if kind == 'final' else 'transcribing',
            'success': True, 'text': text, 'asr_text': text, 'raw_text': raw,
            'final_text': text, 'partial_text': text if kind == 'partial' else '',
            'provider': 'firered2', 'engine': 'FireRedASR2-AED', 'session_id': session_id,
            'duration': samples / 16000, 'optimize_mode': 'none', 'postprocess_mode': 'none',
            'partial_mode': 'vad_segment'}


def allowed_origin(origin):
    import re
    return not origin or origin in ('null', 'file://') or bool(re.fullmatch(
        r'http://(?:localhost|127\.0\.0\.1)(?::\d+)?', origin))


@app.post('/api/asr/transcribe')
@app.post('/api/asr/transcribe-and-optimize')
@app.post('/api/asr/transcribe-and-optimize-stream')
async def transcribe_file(request: Request):
    global busy
    if not allowed_origin(request.headers.get('origin')):
        raise HTTPException(403, '仅允许本机客户端')
    if busy:
        raise HTTPException(409, 'FireRed2 正在处理另一段录音')
    busy = True
    cancelled = threading.Event()
    form = None
    temporary = None
    try:
        form = await request.form(max_files=1, max_fields=16)
        upload = form.get('audio')
        if not hasattr(upload, 'read'):
            raise HTTPException(400, '缺少音频文件')
        if form.get('optimize_mode') == 'translate':
            raise HTTPException(400, 'FireRed2 本机服务不提供翻译')
        temporary = tempfile.NamedTemporaryFile(prefix='caps-firered-', suffix='.audio')
        size = 0
        while chunk := await upload.read(65536):
            size += len(chunk)
            if size > 100 * 1024 * 1024:
                raise HTTPException(413, '上传文件不能超过 100 MB')
            temporary.write(chunk)
        temporary.flush()
    except BaseException:
        if temporary:
            temporary.close()
        busy = False
        raise
    finally:
        if form:
            await form.close()

    async def events():
        global busy
        process = None
        session_id = str(uuid4())
        samples = 0
        try:
            yield {'stage': 'processing'}
            await run(engine.new_session)
            # 只读临时本地文件，禁止解码器访问外部网络。
            process = await asyncio.create_subprocess_exec('ffmpeg', '-v', 'error', '-nostdin',
                '-protocol_whitelist', 'file,pipe', '-i', temporary.name,
                '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            carry = b''
            while chunk := await asyncio.wait_for(process.stdout.read(32000), timeout=30):
                if await request.is_disconnected():
                    return
                chunk = carry + chunk
                carry = chunk[len(chunk) // 2 * 2:]
                chunk = chunk[:len(chunk) // 2 * 2]
                samples += len(chunk) // 2
                await run(engine.process, chunk, False, cancelled)
                yield {'stage': 'processing', 'duration': samples / 16000}
            if await process.wait() != 0 or carry or not samples:
                raise ValueError('音频解码失败或文件为空')
            text, raw = await run(engine.process, b'', True, cancelled)
            yield payload('final', text, raw, session_id, samples)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception('文件识别失败 session=%s', session_id)
            yield {'stage': 'error', 'success': False, 'error': 'FireRed2 文件识别失败，请检查本机服务日志'}
        finally:
            cancelled.set()
            if process and process.returncode is None:
                process.kill()
                await process.wait()
            temporary.close()
            busy = False

    if request.url.path.endswith('-stream'):
        async def stream():
            async for event in events():
                yield 'data: ' + json.dumps(event, ensure_ascii=False) + '\n\n'
        return StreamingResponse(stream(), media_type='text/event-stream')
    result = None
    error = None
    async for event in events():
        if event.get('stage') == 'error':
            error = event['error']
        if event.get('stage') == 'done':
            result = event
    if error:
        raise HTTPException(500, error)
    if result is None:
        raise HTTPException(400, '文件识别已取消')
    return result


@app.websocket('/api/asr/realtime')
async def realtime(ws: WebSocket):
    global busy
    origin = ws.headers.get('origin')
    if not allowed_origin(origin):
        await ws.close(code=1008)
        return
    await ws.accept(subprotocol='qwen3-asr-v1' if 'qwen3-asr-v1' in ws.scope.get('subprotocols', []) else None)
    cancelled = threading.Event()
    queue = asyncio.Queue()
    worker = None
    owned = False
    finishing = False
    pending = 0
    samples = 0
    session_id = str(uuid4())

    async def consume():
        nonlocal pending
        previous = ''
        try:
            while not cancelled.is_set():
                pcm, finish = await queue.get()
                if cancelled.is_set():
                    return
                text, raw = await run(engine.process, pcm, finish, cancelled)
                pending -= len(pcm)
                if cancelled.is_set():
                    return
                if finish or text != previous:
                    await ws.send_json(payload('final' if finish else 'partial', text, raw, session_id, samples))
                    previous = text
                if finish:
                    await ws.close()
                    return
        except Exception:
            log.exception('识别失败 session=%s', session_id)
            cancelled.set()
            try:
                await ws.send_json({'type': 'error', 'success': False, 'error': 'FireRed2 识别失败，请检查本机服务日志'})
                await ws.close(code=1011)
            except (RuntimeError, WebSocketDisconnect):
                pass

    try:
        while True:
            message = await asyncio.wait_for(ws.receive(), timeout=300)
            if message['type'] == 'websocket.disconnect':
                break
            pcm = message.get('bytes')
            if pcm is not None:
                if not owned or finishing or len(pcm) % 2 or len(pcm) > 320000:
                    raise ValueError('需要开始会话后发送 16 kHz 单声道 PCM16 音频')
                pending += len(pcm)
                if pending > 4 * 1024 * 1024:
                    raise ValueError('识别处理速度不足，音频队列已满，请重试')
                samples += len(pcm) // 2
                if pcm:
                    queue.put_nowait((pcm, False))
                continue
            command = json.loads(message.get('text') or '{}')
            if not isinstance(command, dict):
                raise ValueError('录音控制消息必须是 JSON 对象')
            kind = command.get('type')
            if kind == 'cancel':
                break
            if kind == 'start' and not owned:
                if busy:
                    raise ValueError('FireRed2 正在处理另一段录音，请稍后重试')
                if command.get('sample_rate') != 16000:
                    raise ValueError('FireRed2 需要 16000 Hz PCM')
                if command.get('optimize_mode') not in (None, '', 'none', False):
                    raise ValueError('本机服务只识别语音，文字整理请使用客户端')
                busy = owned = True
                await run(engine.new_session)
                worker = asyncio.create_task(consume())
                await ws.send_json({'type': 'ready', 'success': True, 'provider': 'firered2',
                                    'session_id': session_id, 'partial_mode': 'vad_segment',
                                    'capabilities': CAPABILITIES})
            elif kind == 'finish' and owned and not finishing:
                finishing = True
                queue.put_nowait((b'', True))
            else:
                raise ValueError('录音控制消息顺序无效')
    except (WebSocketDisconnect, RuntimeError):
        pass
    except (ValueError, asyncio.TimeoutError) as exc:
        await ws.send_json({'type': 'error', 'success': False, 'error': str(exc) or '录音会话超时'})
    finally:
        cancelled.set()
        if worker:
            queue.put_nowait((b'', True))
            # CUDA 运算不能强行取消；完成前保持独占，避免下一次会话污染模型状态。
            await asyncio.shield(worker)
        if owned:
            busy = False
        try:
            await ws.close()
        except RuntimeError:
            pass


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ.get('FIRERED_PORT', '18011')),
                ws_max_size=320000, ws_max_queue=16)
