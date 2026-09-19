"""仅在 Tailscale 地址监听的腾讯 ASR 兼容服务。"""
import asyncio
from state import STATE, Runtime
import logging
import os
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
from aiohttp import web

from files import file_handler, MAX_UPLOAD
from provider import Tencent, ProviderError
from quota import Quota, free_seconds
from realtime import ProtocolError, serve_realtime

LOG = logging.getLogger("capswriter.tencent")


def allowed_origin(origin):
    if not origin or origin in ("null", "file://"):
        return True
    parsed = urlparse(origin)
    return parsed.scheme in ("http", "https") and parsed.hostname in ("localhost", "127.0.0.1", "::1")


@web.middleware
async def errors_and_origin(request, handler):
    origin = request.headers.get("Origin", "")
    if not allowed_origin(origin):
        return web.json_response({"success": False, "error": "不允许的客户端来源"}, status=403)
    try:
        response = web.Response(status=204) if request.method == "OPTIONS" else await handler(request)
    except web.HTTPException:
        raise
    except (ProtocolError, ProviderError) as error:
        response = web.json_response({"success": False, "error": str(error)}, status=400 if isinstance(error, ProtocolError) else 502)
    except Exception as error:
        # 不记录第三方异常正文：其中可能包含签名 URL 或密钥。
        LOG.warning("request_failed type=%s", type(error).__name__)
        response = web.json_response({"success": False, "error": "ASR 请求失败或超时"}, status=502)
    if origin:
        response.headers.update({"Access-Control-Allow-Origin": origin, "Vary": "Origin",
                                 "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                                 "Access-Control-Allow-Headers": "Content-Type,Accept"})
    return response


async def status(request):
    selection = request.app[STATE].quota.status()
    return web.json_response({"success": True, "status": "ready", "provider": "tencent",
                              "model_loaded": True, "route": "china_direct",
                              "services": {"asr": {"status": "ready", "managed": False,
                                                    "provider": "tencent", "loaded": True}},
                              "capabilities": {"asr": True, "optimize": False, "translate": False},
                              "active_sessions": len(request.app[STATE].sockets),
                              "active_files": request.app[STATE].file_active, **selection})


async def realtime(request):
    if len(request.app[STATE].sockets) >= 4:
        return web.json_response({"success": False, "error": "实时识别繁忙，请稍后重试"}, status=429)
    ws = web.WebSocketResponse(max_msg_size=320000, heartbeat=20)
    request.app[STATE].sockets.add(ws)
    try:
        await ws.prepare(request)
        await serve_realtime(ws, request.app[STATE].provider, request.app[STATE].quota)
    except (ProtocolError, ProviderError) as error:
        if not ws.closed:
            await ws.send_json({"type": "error", "success": False, "error": str(error)})
    except Exception as error:
        if not ws.prepared:
            raise
        LOG.warning("realtime_failed type=%s", type(error).__name__)
        if not ws.closed:
            await ws.send_json({"type": "error", "success": False, "error": f"ASR 连接失败或超时（{type(error).__name__}）"})
    finally:
        request.app[STATE].sockets.discard(ws)
        if ws.prepared:
            await ws.close()
    return ws


async def refresh_quota(app):
    try:
        packages = await app[STATE].provider.resources()
        app[STATE].quota.observe(free_seconds(packages, app[STATE].quota.clock()))
    except Exception as error:
        app[STATE].quota.fail()
        LOG.warning("quota_unavailable type=%s", type(error).__name__)


async def lifecycle(app):
    # trust_env=False 覆盖 HTTP(S)_PROXY、ALL_PROXY；TLS 证书校验保持开启。
    async with aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(total=120)) as http:
        app[STATE].provider = app[STATE].provider or Tencent(http)
        await refresh_quota(app)

        async def poll():
            while True:
                await asyncio.sleep(60)
                await refresh_quota(app)

        polling = asyncio.create_task(poll())
        try:
            yield
        finally:
            polling.cancel()
            await asyncio.gather(polling, return_exceptions=True)
            app[STATE].quota.close()


async def shutdown(app):
    await asyncio.gather(*(ws.close(code=1001, message=b"Service restarting") for ws in list(app[STATE].sockets)), return_exceptions=True)


async def options(request):
    return web.Response(status=204)


def create_app(state_path, provider=None):
    app = web.Application(client_max_size=MAX_UPLOAD + 1024 * 1024, middlewares=[errors_and_origin])
    app[STATE] = Runtime(Quota(state_path), provider)
    app.cleanup_ctx.append(lifecycle)
    app.on_shutdown.append(shutdown)
    for path in ("/api/health", "/api/status", "/api/services/status"):
        app.router.add_get(path, status)
    app.router.add_get("/api/asr/realtime", realtime)
    for path in ("/api/asr/transcribe", "/api/asr/transcribe-and-optimize", "/api/asr/transcribe-and-optimize-stream"):
        app.router.add_post(path, file_handler)
    app.router.add_route("OPTIONS", "/{tail:.*}", options)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    state = os.environ.get("ASR_STATE_PATH", str(Path.home() / ".local/share/capswriter-tencent-asr/usage.sqlite3"))
    host = os.environ.get("ASR_BIND_HOST", "127.0.0.1")
    web.run_app(create_app(state), host=host, port=int(os.environ.get("ASR_PORT", "18011")), access_log=None)
