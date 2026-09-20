"""长句断句优化实验（离线评测用，不进运行时链路）

对比三种策略在真实腾讯 ASR 输出上的表现：
  A 原文基线           —— 腾讯自己给的标点
  B 全量重预测          —— 整句 strip 后交给 CT-Punc，再回填（已知会丢腾讯标点）
  C 分段保守（可设阈值）—— 以腾讯已有标点为硬边界切段，只有超长段才让模型重排，
                          腾讯原始标点一个不丢

运行：
  .../python3 long_eval.py --limit 200 --threshold 20 --show 6
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from funasr_onnx import CT_Transformer  # noqa: E402

from punc_core import PUNCS, restore_punctuation, strip_punctuation  # noqa: E402

DATASET = Path("/home/ivan/Documents/CapsWriter-Voice-Dataset/metadata.jsonl")
MODEL_DIR = Path(__file__).resolve().parent / "models" / "ct-punc"

SENT_END = "。？！"


def metric(text):
    """无标点连续片段的长度分布：越短说明断句越细。"""
    runs = [len(r) for r in re.split(r"[，。？、！；：]", text) if r.strip()]
    return {
        "punc_count": len(re.findall(r"[，。？、！；：]", text)),
        "max_run": max(runs) if runs else 0,
        "avg_run": round(sum(runs) / len(runs), 1) if runs else 0,
        "long_runs": sum(1 for r in runs if r >= 25),
    }


def body_of(text):
    """去掉标点与空格后的正文指纹，用于校验正文是否被改写。"""
    return re.sub(r"[\s，。？、！；：]", "", text)


def full_predict(model, text):
    """策略 B：整句重预测 + 回填。"""
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


def segment_predict(model, text, threshold=20):
    """策略 C：以腾讯标点为硬边界切段，只有「去标点后长度 ≥ threshold」的段才重排。

    腾讯的标点因此在结构上不可能丢失——它们是拼接时的分隔符。
    """
    parts = re.split(r"([，。？、！；：])", text)
    # re.split 带捕获组：偶数下标是片段，奇数下标是分隔符
    out = []
    for idx, chunk in enumerate(parts):
        if idx % 2 == 1:
            out.append(chunk)  # 腾讯原始标点，原样保留
            continue
        core = re.sub(r"[\s，。？、！；：]", "", chunk)
        if len(core) < threshold:
            out.append(chunk)
            continue
        stripped = strip_punctuation(chunk)
        if not stripped.strip():
            out.append(chunk)
            continue
        try:
            output = model(stripped)
        except Exception:
            out.append(chunk)
            continue
        punctuated = output[0] if isinstance(output, (list, tuple)) else output
        if not punctuated:
            out.append(chunk)
            continue
        rendered = restore_punctuation(chunk, punctuated)
        # 段尾若被模型加了标点，而紧随其后就是腾讯的原始分隔符，则删掉模型那个：
        # 腾讯的边界是原文既有信息，优先级更高，否则会出现「打成包。，在不同」这类叠加。
        nxt = parts[idx + 1] if idx + 1 < len(parts) else None
        if nxt and nxt in PUNCS and rendered and rendered[-1] in PUNCS:
            rendered = rendered[:-1]
        out.append(rendered)
    return "".join(out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--threshold", type=int, default=20)
    parser.add_argument("--show", type=int, default=6)
    args = parser.parse_args()

    rows = []
    with DATASET.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue

    samples = [r["text"].replace("\n", " ") for r in rows if len(r.get("text", "")) >= 15]
    samples = samples[: args.limit]

    print(f"样本 {len(samples)} 条 | 阈值 threshold={args.threshold}")
    print("载入模型中…", file=sys.stderr)
    t0 = time.time()
    model = CT_Transformer(str(MODEL_DIR), quantize=True)
    print(f"载入耗时 {time.time() - t0:.1f}s", file=sys.stderr)

    def summarize(name, texts, expect_preserved=False):
        agg = {"punc_count": 0, "max_run": 0, "avg_run": 0.0, "long_runs": 0}
        for t in texts:
            m = metric(t)
            for k, v in m.items():
                agg[k] += v
        n = len(texts)
        print(
            f"{name:14s} 标点总数={agg['punc_count']:5d} | 最长无标点片段={agg['max_run']:6d} "
            f"| 平均片段={agg['avg_run']/n:5.1f} | 超长片段(≥25字)={agg['long_runs']:4d}"
        )
        return agg

    base = samples
    print("\n=== 断句形态（数值越小说明停顿越密） ===")
    summarize("A 腾讯原文", base)

    b_texts, c_texts = [], []
    b_body_bad = c_body_bad = 0
    b_lost = c_lost = 0
    b_changed = c_changed = 0
    examples = []

    t_start = time.time()
    for t in samples:
        nb = len(re.findall(r"[，。？、！；：]", t))

        b = full_predict(model, t)
        b_texts.append(b)
        if body_of(b) != body_of(t):
            b_body_bad += 1
        if len(re.findall(r"[，。？、！；：]", b)) < nb:
            b_lost += 1
        if b != t:
            b_changed += 1

        c = segment_predict(model, t, args.threshold)
        c_texts.append(c)
        if body_of(c) != body_of(t):
            c_body_bad += 1
        if len(re.findall(r"[，。？、！；：]", c)) < nb:
            c_lost += 1
        if c != t:
            c_changed += 1
            if len(examples) < args.show:
                mark = "CUT" if metric(c)["long_runs"] < metric(t)["long_runs"] else "add"
                examples.append((f"[{mark}] 原: {t}", f"     新: {c}"))

    print(f"（推理总耗时 {time.time() - t_start:.1f}s）")
    summarize("B 全量重预测", b_texts)
    summarize(f"C 分段>{args.threshold}", c_texts)

    print("\n=== 安全性 ===")
    print(f"{'':14s} 正文被改写  标点变少  文本有变化")
    print(f"{'B 全量':14s} {b_body_bad:8d}  {b_lost:8d}  {b_changed:8d}")
    print(f"{'C 分段':14s} {c_body_bad:8d}  {c_lost:8d}  {c_changed:8d}")

    if examples:
        print("\n=== C 策略改善样例（长片段被切开） ===")
        for old, new in examples:
            print(f"  原: {old}")
            print(f"  新: {new}")
            print()

    # 分长度档看改善幅度
    print("=== 按原文长度分档：最长无标点片段均值 ===")
    buckets = {"15-30字": [], "31-60字": [], ">60字": []}
    idx_map = {"15-30字": [], "31-60字": [], ">60字": []}
    for i, t in enumerate(samples):
        key = "15-30字" if len(t) <= 30 else ("31-60字" if len(t) <= 60 else ">60字")
        idx_map[key].append(i)
        buckets[key].append(metric(t)["max_run"])
    for key in buckets:
        if not idx_map[key]:
            continue
        idxs = idx_map[key]
        b_vals = [metric(b_texts[i])["max_run"] for i in idxs]
        c_vals = [metric(c_texts[i])["max_run"] for i in idxs]
        base_val = sum(buckets[key]) / len(buckets[key])
        print(
            f"  {key:9s} n={len(idxs):4d} | 原文平均最长片段={base_val:5.1f} "
            f"| B={sum(b_vals)/len(b_vals):5.1f} | C={sum(c_vals)/len(c_vals):5.1f}"
        )


if __name__ == "__main__":
    main()
