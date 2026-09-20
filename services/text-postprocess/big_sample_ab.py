#!/usr/bin/env python3
"""大样本热词对照实验：每术语 20 条，基线(无热词) vs 128词热词表。

- 样本从 /tmp/big_sample_picks.json 读取（按术语预选，取较短音频省额度）
- 两组跑同一批音频，同样本对照
- 结果落 /tmp/big_sample_result.jsonl（可中断续跑）
"""
import json
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ENDPOINT = "http://100.91.42.28:18011/api/asr/transcribe"
DATASET = Path("/home/ivan/Documents/CapsWriter-Voice-Dataset")
PICKS = Path("/tmp/big_sample_picks.json")
OUT = Path("/tmp/big_sample_result.jsonl")
HOTWORDS = Path("/tmp/hotwords_full.txt").read_text(encoding="utf-8").strip().replace("\n", ",")


def post_audio(path, hotword="", retries=4):
    boundary = uuid.uuid4().hex
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="audio"; filename="audio.webm"\r\n',
        b"Content-Type: audio/webm\r\n\r\n", path.read_bytes(), b"\r\n",
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="optimize_mode"\r\n\r\nnone\r\n',
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="hotword"\r\n\r\n{hotword}\r\n'.encode(),
        f"--{boundary}--\r\n".encode(),
    ])
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                ENDPOINT, data=body, method="POST",
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8")), None
        except Exception as exc:  # noqa: BLE001
            if attempt == retries:
                return None, f"{type(exc).__name__}"
            time.sleep(3 + 3 * attempt)
    return None, "unreachable"


def hit(term, text):
    """术语是否被 ASR 正确说出（大小写不敏感，允许空格/连字符差异）"""
    import re
    t = (text or "")
    # 归一化：去掉空格、连字符、点
    def norm(s):
        return re.sub(r"[\s\-_.]", "", s).lower()
    return norm(term) in norm(t)


def load_done():
    done = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                done[(r["term"], r["audio_path"], r["group"])] = r
    return done


def main():
    picks = json.loads(PICKS.read_text(encoding="utf-8"))
    done = load_done()
    tasks = []
    for term, items in picks.items():
        for it in items:
            for group in ("baseline", "hotword"):
                if (term, it["audio_path"], group) not in done:
                    tasks.append((term, it, group))
    print(f"总任务 {len(tasks)}（已完成 {len(done)}，跳过）", flush=True)
    print(f"热词表词条数: {len(HOTWORDS.split(','))}", flush=True)

    results = []
    lock = __import__("threading").Lock()

    def work(task):
        term, it, group = task
        audio = DATASET / it["audio_path"]
        if not audio.exists():
            return None
        hw = HOTWORDS if group == "hotword" else ""
        payload, err = post_audio(audio, hw)
        if err or not payload or not payload.get("success"):
            print(f"FAIL {term} {group} {err or (payload or {}).get('error')}", flush=True)
            return None
        text = payload.get("asr_text", "")
        rec = {
            "term": term, "audio_path": it["audio_path"], "group": group,
            "truth": it["text"], "asr": text, "hit": hit(term, text),
        }
        with lock:
            with OUT.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return rec

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=2) as ex:
        for i, r in enumerate(ex.map(work, tasks), 1):
            if r:
                results.append(r)
            if i % 40 == 0:
                el = time.time() - t0
                print(f"  进度 {i}/{len(tasks)}  用时{el:.0f}s  预计剩余{el/i*(len(tasks)-i):.0f}s", flush=True)
            time.sleep(1.2)  # 腾讯限流保护

    print(f"\n完成：新增 {len(results)} 条，总耗时 {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
