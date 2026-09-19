"""有界文件上传和音频格式转换，不允许 ffmpeg 从网络读取媒体。"""
import asyncio
from state import STATE, Runtime
import json
import math
import tempfile
import uuid
from pathlib import Path

from aiohttp import web
from realtime import ProtocolError, hotwords, result_payload

MAX_UPLOAD = 100 * 1024 * 1024


async def run_process(*args):
    process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 120)
        if process.returncode:
            raise ProtocolError("音频格式无效或转换失败")
        return output
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def read_upload(request, target):
    reader = await request.multipart()
    options = {}
    found = False
    total = 0
    count = 0
    async for part in reader:
        count += 1
        if count > 20:
            raise ProtocolError("上传表单字段过多")
        if part.name == "audio":
            if found:
                raise ProtocolError("只能上传一个音频文件")
            found = True
            with target.open("wb") as stream:
                while chunk := await part.read_chunk(64 * 1024):
                    total += len(chunk)
                    if total > MAX_UPLOAD:
                        raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD, actual_size=total)
                    stream.write(chunk)
        else:
            value = bytearray()
            while chunk := await part.read_chunk():
                value.extend(chunk)
                if len(value) > 32768:
                    raise ProtocolError("上传参数过长")
            options[part.name] = value.decode("utf-8")
    if not found or not total:
        raise ProtocolError("缺少或上传了空音频文件")
    if options.get("optimize_mode", "none") not in ("none", ""):
        raise ProtocolError("腾讯连接仅提供 ASR，请关闭润色/翻译模式")
    return options


async def transcribe_file(source, output, options, provider, quota):
    await run_process("ffmpeg", "-nostdin", "-v", "error", "-y",
                      "-protocol_whitelist", "file,pipe",
                      "-format_whitelist", "wav,mp3,ogg,matroska,webm,mov,aac,amr,flac",
                      "-i", str(source), "-t", "7201", "-vn", "-ac", "1", "-ar", "16000",
                      "-c:a", "libmp3lame", "-b:a", "64k", str(output))
    duration = float((await run_process("ffprobe", "-v", "error", "-show_entries", "format=duration",
                                      "-of", "default=nw=1:nk=1", str(output))).decode().strip())
    if not math.isfinite(duration) or not 0 < duration <= 7200:
        raise ProtocolError("文件音频时长必须在 0 到 2 小时之间")
    if output.stat().st_size > MAX_UPLOAD:
        raise ProtocolError("转换后音频超过 100 MB")
    session_id = str(uuid.uuid4())
    quota.begin(session_id, "flash_16k_zh")
    try:
        result = await provider.flash(output.read_bytes(), "mp3", hotwords(options.get("hotword", "")))
        text = "".join(item.get("text", "") for item in result.get("flash_result", []))
        quota.record(session_id, math.ceil(duration), "completed")
        return result_payload("final", text, "16k_zh", session_id, duration)
    except BaseException:
        # 请求可能已经在云端计费，保守记录；不自动重传。
        quota.record(session_id, math.ceil(duration), "failed")
        raise


async def file_handler(request):
    app = request.app
    if app[STATE].file_active >= 2:
        return web.json_response({"success": False, "error": "文件识别繁忙，请稍后重试"}, status=429)
    app[STATE].file_active += 1
    try:
        with tempfile.TemporaryDirectory(prefix="capswriter-asr-") as folder:
            source, output = Path(folder) / "upload.bin", Path(folder) / "audio.mp3"
            options = await asyncio.wait_for(read_upload(request, source), 120)
            if not request.path.endswith("-stream"):
                result = await transcribe_file(source, output, options, app[STATE].provider, app[STATE].quota)
                return web.json_response(result)
            response = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"})
            # CORS 必须在 prepare 前设置，普通 middleware 在返回时已经太晚。
            if request.headers.get("Origin"):
                response.headers["Access-Control-Allow-Origin"] = request.headers["Origin"]
            await response.prepare(request)
            task = asyncio.create_task(transcribe_file(source, output, options, app[STATE].provider, app[STATE].quota))
            try:
                while not task.done():
                    await response.write(b'data: {"stage":"processing"}\n\n')
                    await asyncio.wait({task}, timeout=5)
                result = {**task.result(), "stage": "done"}
                await response.write(("data: " + json.dumps(result, ensure_ascii=False) + "\n\n").encode())
            except Exception as error:
                from provider import ProviderError
                message = str(error) if isinstance(error, (ProviderError, ProtocolError)) else "文件识别失败"
                await response.write(("data: " + json.dumps({"stage": "error", "success": False, "error": message}) + "\n\n").encode())
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            await response.write_eof()
            return response
    finally:
        app[STATE].file_active -= 1
