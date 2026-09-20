#!/usr/bin/env python3
"""标点质量审计：直接分析 metadata.jsonl 里的真实 ASR 输出，不重新跑 ASR。

关注四件事：
  1. 完全没有标点的条目占比（"一坨话"）
  2. 长片段只在末尾有标点、中间不断句（句读缺失）
  3. 中英混排处缺空格（中文紧贴拉丁字母/数字）
  4. 异常标点形态（重复标点、半角句号混用、连续逗号等）

用法：
    python3 punc_audit.py [--dataset DIR] [--since 2026-09-01] [--limit N] [--samples K]
"""
import argparse
import json
import os
import re
import sys
from collections import Counter

# 中文标点 + 英文标点（中文引号用转义写，避免源码里引号嵌套歧义）
CJK_PUNCT = "\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a\u201c\u201d\u2018\u2019\uff08\uff09\u300a\u300b\u3010\u3011\u2026\u2014"
ASCII_PUNCT = ",.!?;:'\"()[]{}<>"
ALL_PUNCT = set(CJK_PUNCT + ASCII_PUNCT)

# 句末标点（用于判断"有没有断句"）
SENT_END = set("。！？.!?;；")

# 中文紧贴拉丁/数字：左边中文右边拉丁，或左边拉丁右边中文，中间无空格
CJK_LATIN_NOSPACE = re.compile(r"[\u4e00-\u9fff][A-Za-z0-9]|[A-Za-z0-9][\u4e00-\u9fff]")
# 允许的例外：常见中英混排本来就紧贴的词（如 5G、AI 等由 ASR 直接产出），这里先全量统计再看样本

REPEAT_PUNCT = re.compile(r"([，。！？、；：,.!?;:])\1+")
HALF_DOT = re.compile(r"[A-Za-z0-9]\.[A-Za-z]")  # 英文里的点，正常


def load_records(path, since=None):
    out = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if since and (d.get("created_at") or "") < since:
                continue
            text = d.get("final_text") or d.get("asr_text") or d.get("text") or ""
            if not isinstance(text, str) or not text.strip():
                continue
            out.append(d)
    return out


def strip_punct(s):
    return "".join(ch for ch in s if ch not in ALL_PUNCT)


def split_on_punct(s):
    """以任意标点为界切段，返回非空片段。"""
    parts = []
    cur = []
    for ch in s:
        if ch in ALL_PUNCT:
            if cur:
                parts.append("".join(cur))
                cur = []
        else:
            cur.append(ch)
    if cur:
        parts.append("".join(cur))
    return parts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=os.path.expanduser("~/Documents/CapsWriter-Voice-Dataset"))
    ap.add_argument("--since", default=None)
    ap.add_argument("--limit", type=int, default=0, help="只分析最近 N 条（0=全部）")
    ap.add_argument("--samples", type=int, default=8, help="每类问题打印几条样本")
    ap.add_argument("--long", type=int, default=25, help="长片段阈值（去标点后字符数）")
    args = ap.parse_args()

    meta = os.path.join(args.dataset, "metadata.jsonl")
    if not os.path.exists(meta):
        print(f"找不到 {meta}", file=sys.stderr)
        return 1

    recs = load_records(meta, since=args.since)
    if args.limit:
        recs = recs[-args.limit:]

    total = len(recs)
    print("=" * 72)
    print(f"标点质量审计  样本 {total} 条   since={args.since or '(全部)'}   长片段阈值={args.long} 字")
    print("=" * 72)

    # ---- 1. 有无标点 ----
    no_punct = [r for r in recs if not any(ch in ALL_PUNCT for ch in (r.get("final_text") or r.get("text") or ""))]
    # ---- 2. 句末标点缺失 ----
    no_end = []
    for r in recs:
        t = (r.get("final_text") or r.get("text") or "").rstrip()
        if t and t[-1] not in SENT_END and len(strip_punct(t)) >= 6:
            no_end.append(r)

    # ---- 3. 长片段中间无断句 ----
    long_segs = []          # (片段, 记录)
    for r in recs:
        t = r.get("final_text") or r.get("text") or ""
        for seg in split_on_punct(t):
            if len(seg) >= args.long:
                long_segs.append((seg, r))

    # 只有末尾一个句末标点、中间没有任何逗号/顿号等
    tail_only = []
    for r in recs:
        t = (r.get("final_text") or r.get("text") or "").strip()
        if not t or t[-1] not in SENT_END:
            continue
        body = t[:-1]
        if len(strip_punct(body)) >= args.long and not any(ch in ALL_PUNCT for ch in body):
            tail_only.append(r)

    # ---- 4. 中英混排缺空格 ----
    nospace = []
    for r in recs:
        t = r.get("final_text") or r.get("text") or ""
        if CJK_LATIN_NOSPACE.search(t):
            nospace.append(r)

    # ---- 5. 异常标点 ----
    repeat = [(r, REPEAT_PUNCT.findall(r.get("final_text") or r.get("text") or "")) for r in recs]
    repeat = [(r, m) for r, m in repeat if m]

    punct_counter = Counter(ch for r in recs for ch in (r.get("final_text") or r.get("text") or "") if ch in ALL_PUNCT)

    def pct(n):
        return f"{n:5d}  ({n/total*100:5.1f}%)" if total else "    0"

    print()
    print("【1】标点总体")
    print(f"  完全无标点        : {pct(len(no_punct))}")
    print(f"  结尾缺句末标点    : {pct(len(no_end))}")
    print(f"  有句末标点但中间无断句(≥{args.long}字): {pct(len(tail_only))}")
    print(f"  中英混排缺空格    : {pct(len(nospace))}")
    print(f"  重复标点          : {pct(len(repeat))}")
    print()
    print("  标点符号使用频次（前 12）:")
    for ch, cnt in punct_counter.most_common(12):
        print(f"    {ch!r:10s} {cnt:6d}")
    print()
    print(f"  超长片段数（≥{args.long} 字）: {len(long_segs)}")

    def show(title, items, getter, k):
        if not items:
            print(f"\n--- {title}: 无")
            return
        print(f"\n--- {title}（共 {len(items)}，示 {min(k,len(items))}）")
        for r in items[:k]:
            t = getter(r)
            print(f"    {t}")
            if not t.rstrip().endswith(("。", "？", "！", ".")):
                pass

    show("无标点样本", no_punct, lambda r: r.get("final_text") or r.get("text"), args.samples)
    show("结尾缺句末标点", no_end, lambda r: r.get("final_text") or r.get("text"), args.samples)
    show("长句只在末尾断", tail_only, lambda r: r.get("final_text") or r.get("text"), args.samples)
    show("中英混排缺空格", nospace, lambda r: r.get("final_text") or r.get("text"), args.samples)
    show("重复标点", [r for r, _ in repeat], lambda r: r.get("final_text") or r.get("text"), args.samples)

    if long_segs:
        print(f"\n--- 最长的 5 个片段（无内部标点）")
        for seg, _ in sorted(long_segs, key=lambda x: -len(x[0]))[:5]:
            print(f"    [{len(seg)}字] {seg}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
