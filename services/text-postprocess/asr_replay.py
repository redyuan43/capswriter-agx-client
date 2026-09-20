"""真实回放：把语音数据集的真音频送到 ai 机器上的腾讯 ASR 服务（100.91.42.28:18011），
拿到真实 ASR 原文，再用本机 hot-rule 管线处理，做真实数据上的前后对比。

用法: python3 asr_replay.py <样本数>
"""
import json
import os
import re
import sys
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DATASET = Path("/home/ivan/Documents/CapsWriter-Voice-Dataset")
ENDPOINT = "http://100.91.42.28:18011/api/asr/transcribe"
OUT = Path("/tmp/asr_replay_result.jsonl")


def post_audio(path, retries=2):
    """multipart/form-data 上传音频，字段名为 audio。"""
    boundary = uuid.uuid4().hex
    data = path.read_bytes()
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="audio"; filename="audio.webm"\r\n',
        b"Content-Type: audio/webm\r\n\r\n",
        data, b"\r\n",
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="optimize_mode"\r\n\r\nnone\r\n',
        f"--{boundary}--\r\n".encode(),
    ])
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                ENDPOINT, data=body, method="POST",
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8")), None
        except Exception as exc:  # noqa: BLE001
            if attempt == retries:
                return None, f"{type(exc).__name__}: {exc}"
            time.sleep(1.5 * (attempt + 1))
    return None, "unreachable"


def pick_samples():
    rows = [json.loads(l) for l in (DATASET / "metadata.jsonl").open(encoding="utf-8") if l.strip()]
    ok = [r for r in rows if (DATASET / r["audio_path"]).exists()]

    def is_target(r):
        t = r.get("text", "")
        return len(t) >= 25 and re.search(r"[A-Za-z]{2,}", t)

    targets = sorted((r for r in ok if is_target(r)), key=lambda r: -len(r.get("text", "")))
    # 目标场景 + 随机回归，去重
    import random
    random.seed(20260920)
    others = [r for r in ok if not is_target(r)]
    random.shuffle(others)
    n_target = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    n_reg = max(10, n_target // 2)
    selected = targets[:n_target] + others[:n_reg]
    seen, uniq = set(), []
    for r in selected:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        uniq.append(r)
    return uniq


def main():
    samples = pick_samples()
    print(f"待回放样本: {len(samples)} 条", flush=True)
    results = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [(r, pool.submit(post_audio, DATASET / r["audio_path"])) for r in samples]
        for i, (row, fut) in enumerate(futures, 1):
            payload, err = fut.result()
            if err or not payload or not payload.get("success"):
                print(f"[{i}/{len(samples)}] FAIL {row['id']} {err or (payload and payload.get('error'))}", flush=True)
                continue
            results.append({
                "id": row["id"],
                "audio_path": row["audio_path"],
                "dataset_text": row.get("text", ""),
                "dataset_raw_asr": row.get("raw_asr_text", ""),
                "dataset_final_text": row.get("final_text", ""),
                "asr_text": payload.get("asr_text", ""),
                "final_text": payload.get("final_text", ""),
                "duration": payload.get("duration", 0),
                "engine": payload.get("engine", ""),
            })
            if i % 10 == 0:
                print(f"[{i}/{len(samples)}] ok  {payload.get('asr_text','')[:30]}", flush=True)

    with OUT.open("w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    total_audio = sum(r["duration"] for r in results)
    print(f"\n完成 {len(results)}/{len(samples)} 条，耗时 {time.time()-t0:.1f}s，累计音频 {total_audio:.1f}s（约消耗同等额度）")
    print(f"结果: {OUT}")


if __name__ == "__main__":
    main()
