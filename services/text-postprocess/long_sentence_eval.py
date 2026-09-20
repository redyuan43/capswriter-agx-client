"""长片段定向标点恢复实验（离线评测，不进运行时链路）

动机：全量重预测会把腾讯已经正确的短句也拆坏（实测超长片段数从 23 涨到 38）。
       但腾讯的失败集中在「长时间没有标点」的片段上——看真实数据：
       按腾讯标点切分后，≥30字的无标点片段只占 2.4%，≥40字仅 0.4%。

       所以策略应该是：**只对超长片段下手，其余片段一个标点都不动。**

做法：
  1. 用腾讯已有的标点把文本切成片段
  2. 只有「去标点后长度 ≥ threshold」的片段才交给模型重排
  3. 其余片段连同腾讯标点原样拼接回去
  → 腾讯的标点在结构上不可能丢失

运行：
  .../python3 long_sentence_eval.py --limit 300 --threshold 30 --show 8
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from funasr_onnx import CT_Transformer  # noqa: E402

from punc_core import restore_punctuation, strip_punctuation  # noqa: E402

DATASET = Path("/home/ivan/Documents/CapsWriter-Voice-Dataset/metadata.jsonl")
MODEL_DIR = Path(__file__).resolve().parent / "models" / "ct-punc"

SPLIT_PUNC = "。？！；，、"


def segment_long(text, threshold=30):
    """按腾讯标点切分，返回 [(片段, 分隔符)]。re.split 带捕获组时奇数下标是分隔符。"""
    parts = re.split(f"([{SPLIT_PUNC}])", text)
    segments = []
    for i in range(0, len(parts), 2):
        body = parts[i]
        sep = parts[i + 1] if i + 1 < len(parts) else ""
        segments.append((body, sep))
    return segments


def body_of(text):
    return re.sub(rf"[\s{SPLIT_PUNC}]", "", text)


def apply_long_only(model, text, threshold=30):
    """只对超长片段做标点恢复，短片段保持腾讯原样。"""
    segments = segment_long(text, threshold)
    out = []
    touched = 0
    for body, sep in segments:
        core = re.sub(rf"[\s{SPLIT_PUNC}]", "", body)
        if len(core) < threshold or not core:
            out.append(body + sep)
            continue
        stripped = strip_punctuation(body)
        if not stripped.strip():
            out.append(body + sep)
            continue
        try:
            output = model(stripped)
            punctuated = output[0] if isinstance(output, (list, tuple)) else output
        except Exception:
            out.append(body + sep)
            continue
        if not punctuated:
            out.append(body + sep)
            continue
        touched += 1
        out.append(restore_punctuation(body, punctuated) + sep)
    return "".join(out), touched


def apply_full(model, text):
    """对照：整段重预测。"""
    stripped = strip_punctuation(text)
    if not stripped.strip():
        return text
    try:
        output = model(stripped)
    except Exception:
        return text
    punctuated = output[0] if isinstance(output, (list, tuple)) else output
    if not punctuated:
        return text
    return restore_punctuation(text, punctuated)


def longest_run(text):
    segs = [s for s in re.split(f"[{SPLIT_PUNC}]", text) if s.strip()]
    return max((len(s) for s in segs), default=0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=300)
    ap.add_argument("--threshold", type=int, default=30)
    ap.add_argument("--show", type=int, default=8)
    args = ap.parse_args()

    rows = []
    with DATASET.open() as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    samples = [r["text"].replace("\n", " ") for r in rows if len(r.get("text", "")) >= 15]
    samples = samples[: args.limit]

    print(f"样本 {len(samples)} 条 | 长片段阈值 {args.threshold} 字")
    print("载入模型中…", file=sys.stderr)
    t0 = time.time()
    model = CT_Transformer(str(MODEL_DIR), quantize=True)
    print(f"载入耗时 {time.time() - t0:.1f}s", file=sys.stderr)

    base_long = sum(longest_run(t) for t in samples)
    base_punc = sum(len(re.findall(f"[{SPLIT_PUNC}]", t)) for t in samples)

    full_long = long_long = 0
    full_punc = long_punc = 0
    full_body_bad = long_body_bad = 0
    full_lost = long_lost = 0
    full_changed = long_changed = 0
    touched_total = 0
    examples = []

    t_start = time.time()
    for t in samples:
        nb = len(re.findall(f"[{SPLIT_PUNC}]", t))

        f = apply_full(model, t)
        full_long += longest_run(f)
        np_ = len(re.findall(f"[{SPLIT_PUNC}]", f))
        full_punc += np_
        if body_of(f) != body_of(t):
            full_body_bad += 1
        if np_ < nb:
            full_lost += 1
        if f != t:
            full_changed += 1

        c, touched = apply_long_only(model, t, args.threshold)
        touched_total += touched
        long_long += longest_run(c)
        nc = len(re.findall(f"[{SPLIT_PUNC}]", c))
        long_punc += nc
        if body_of(c) != body_of(t):
            long_body_bad += 1
        if nc < nb:
            long_lost += 1
        if c != t:
            long_changed += 1
            if len(examples) < args.show:
                examples.append((t, c))

    elapsed = time.time() - t_start
    n = len(samples)

    print(f"（推理总耗时 {elapsed:.1f}s，平均 {elapsed / n * 1000:.1f}ms/条）\n")

    print("=== 汇总 ===")
    print(f"{'':16s} {'超长片段总和':>12s} {'标点总数':>10s} {'正文被改':>8s} {'标点变少':>8s} {'被改动条数':>10s}")
    print(f"{'腾讯原文':16s} {base_long:12d} {base_punc:10d} {'-':>8s} {'-':>8s} {'-':>10s}")
    print(f"{'全量重预测':16s} {full_long:12d} {full_punc:10d} {full_body_bad:8d} {full_lost:8d} {full_changed:10d}")
    print(f"{'只处理长片段':16s} {long_long:12d} {long_punc:10d} {long_body_bad:8d} {long_lost:8d} {long_changed:10d}")
    print(f"\n触发了长片段处理的样本片段数: {touched_total}")

    if examples:
        print("\n=== 改动样例 ===")
        for old, new in examples:
            print(f"  原: {old}")
            print(f"  新: {new}")
            print()


if __name__ == "__main__":
    main()
