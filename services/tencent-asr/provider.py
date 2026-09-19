"""腾讯中国大陆接口；禁止继承系统代理或输出签名 URL。"""
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlencode

import aiohttp
from websockets.asyncio.client import connect

STANDARD = "16k_zh"
MODEL2 = "16k_zh_en_2.0"
ASR_HOST = "asr.cloud.tencent.com"


class ProviderError(Exception):
    def __init__(self, code):
        self.code = str(code)
        messages = {
            "4002": "腾讯鉴权失败", "4003": "腾讯语音服务未开通",
            "4004": "腾讯资源包耗尽且后付费不可用", "4005": "腾讯账号欠费",
            "4006": "腾讯并发额度已满", "4007": "腾讯无法解码音频",
        }
        super().__init__(messages.get(self.code, "腾讯 ASR 请求失败") + f"（{self.code}）")


class Tencent:
    def __init__(self, http):
        self.http = http
        self.app_id = os.environ["TENCENTCLOUD_APP_ID"]
        self.secret_id = os.environ["TENCENTCLOUD_SECRET_ID"]
        self.secret_key = os.environ["TENCENTCLOUD_SECRET_KEY"]
        if not self.app_id.isdigit() or not self.secret_id or not self.secret_key:
            raise ValueError("腾讯凭据未配置")

    def signature(self, value):
        return base64.b64encode(hmac.new(self.secret_key.encode(), value.encode(), hashlib.sha1).digest()).decode()

    def realtime_url(self, engine, voice_id, hotword=""):
        now = int(time.time())
        params = dict(engine_model_type=engine, expired=now + 600,
                      secretid=self.secret_id, timestamp=now, nonce=uuid.uuid4().int % 10**9,
                      voice_id=voice_id, voice_format=1, needvad=1,
                      sub_service_type=1, word_info=0, convert_num_mode=1,
                      filter_dirty=0, filter_modal=0, filter_punc=0)
        if hotword:
            params["hotword_list"] = hotword
        path = f"{ASR_HOST}/asr/v2/{self.app_id}"
        raw = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
        params["signature"] = self.signature(f"{path}?{raw}")
        return f"wss://{path}?{urlencode(sorted(params.items()))}"

    def realtime(self, engine, voice_id, hotword=""):
        return connect(self.realtime_url(engine, voice_id, hotword), proxy=None,
                       open_timeout=10, close_timeout=2, max_size=4 * 1024 * 1024)

    async def flash(self, audio, voice_format="wav", hotword=""):
        params = dict(engine_type=STANDARD, secretid=self.secret_id,
                      timestamp=int(time.time()), voice_format=voice_format,
                      filter_punc=0, convert_num_mode=1)
        if hotword:
            params["hotword_list"] = hotword
        path = f"{ASR_HOST}/asr/flash/v1/{self.app_id}"
        raw = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
        url = f"https://{path}?{urlencode(sorted(params.items()))}"
        headers = {"Authorization": self.signature(f"POST{path}?{raw}"),
                   "Content-Type": "application/octet-stream"}
        async with self.http.post(url, data=audio, headers=headers,
                                  timeout=aiohttp.ClientTimeout(total=120), allow_redirects=False) as response:
            if response.status != 200:
                raise ProviderError(f"HTTP_{response.status}")
            result = await response.json(content_type=None)
        if result.get("code") != 0:
            raise ProviderError(result.get("code", "invalid_response"))
        return result

    async def resources(self):
        rows = []
        for page in range(1, 21):
            data = await self.cloud_api("DescribePidOrders", {"AvailableType": 0, "Page": page, "PageSize": 100})
            rows.extend(data["PidOrders"])
            if len(rows) >= data["TotalCount"]:
                return rows
            if not data["PidOrders"]:
                break
        raise ProviderError("quota_incomplete")

    async def cloud_api(self, action, params):
        host = "asr.tencentcloudapi.com"
        stamp = int(time.time())
        date = datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%d")
        payload = json.dumps(params, separators=(",", ":")).encode()
        content_type = "application/json; charset=utf-8"
        canonical = (f"POST\n/\n\ncontent-type:{content_type}\nhost:{host}\n\n"
                     "content-type;host\n" + hashlib.sha256(payload).hexdigest())
        scope = f"{date}/asr/tc3_request"
        source = f"TC3-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
        key = ("TC3" + self.secret_key).encode()
        for part in (date, "asr", "tc3_request"):
            key = hmac.new(key, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(key, source.encode(), hashlib.sha256).hexdigest()
        headers = {
            "Content-Type": content_type, "X-TC-Action": action,
            "X-TC-Version": "2019-06-14", "X-TC-Timestamp": str(stamp),
            "X-TC-Region": "ap-guangzhou",
            "Authorization": f"TC3-HMAC-SHA256 Credential={self.secret_id}/{scope}, SignedHeaders=content-type;host, Signature={signature}",
        }
        async with self.http.post(f"https://{host}", data=payload, headers=headers,
                                  timeout=aiohttp.ClientTimeout(total=4), allow_redirects=False) as response:
            if response.status != 200:
                raise ProviderError(f"HTTP_{response.status}")
            data = (await response.json())["Response"]
        if "Error" in data:
            raise ProviderError(data["Error"].get("Code", "quota_error"))
        return data
