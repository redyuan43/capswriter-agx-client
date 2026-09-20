#!/usr/bin/env python3
"""从语音数据集挖掘高频术语，生成腾讯 ASR 热词表（词|权重，上限 128）。

用法:
    python3 mine_hotwords.py [--min-count 2] [--limit 128] [--out hot-words.txt]

输出直接可作为 ~/.config/语音转写/hot-words.txt 使用。

⚠️ 清洗规则只有两条：长度 >= 2、必须含 ASCII 字母。
   不要再自作聪明加「无元音即噪音」这类规则 —— 会误杀 SSH / TTS / VNC / GPT / PDF
   这些真实缩写（踩过）。要剔除噪音就靠频次阈值（默认出现 >= 2 次）。
"""
from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path

DEFAULT_DATASET = Path.home() / "Documents" / "CapsWriter-Voice-Dataset"

# 通用英文词黑名单：这些不是术语，加进热词表只会干扰语言模型
STOP = set("""
the a an is are was were be been being to of in on at for and or but if then than
that this these those it its you your my me we our he she they them i do does did
done doing have has had having will would can could should shall may might must not
no yes ok okay new old good bad big small now please thanks thank just very more
most some any all one two three get got go going make made take took use used want
need like well how what when where why who there here from with without about into
out up down over under again really also too only even still let lets run running
stop start end begin first last next day time way thing things maybe sure right
wrong true false yeah hmm let's okay okay
""".split())


def extract_terms(rows: list[dict], min_count: int) -> list[tuple[str, int]]:
    counter: collections.Counter = collections.Counter()
    for row in rows:
        text = row.get("text") or ""
        for token in re.findall(r"[A-Za-z][A-Za-z0-9_\-\.]*", text):
            token = token.strip("-_.")
            if len(token) < 2:
                continue
            if not re.search(r"[A-Za-z]", token):
                continue
            if re.search(r"[^\x00-\x7F]", token):
                continue
            if token.lower() in STOP:
                continue
            counter[token] += 1

    # 大小写归并：保留出现次数最多的写法；次数相同时优先保留含大写的（更像专有名词）
    merged: dict[str, tuple[str, int]] = {}
    for token, count in counter.items():
        key = token.lower()
        current = merged.get(key)
        if current is None or count > current[1]:
            merged[key] = (token, count)
        elif count == current[1] and re.search(r"[A-Z]", token) and not re.search(r"[A-Z]", current[0]):
            merged[key] = (token, count)

    items = [(t, c) for t, c in merged.values() if c >= min_count]
    items.sort(key=lambda x: (-x[1], x[0]))
    return items


def weight_for(count: int) -> int:
    """分级权重。实验结论：权重越高越好（11 > 5），但过高会在个别样本上过拟合。"""
    if count >= 10:
        return 11
    if count >= 4:
        return 8
    return 5


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    ap.add_argument("--min-count", type=int, default=2)
    ap.add_argument("--limit", type=int, default=128, help="腾讯热词上限 128")
    ap.add_argument("--out", type=Path, default=Path("hot-words.txt"))
    args = ap.parse_args()

    meta = args.dataset / "metadata.jsonl"
    rows = [json.loads(line) for line in meta.read_text(encoding="utf-8").splitlines() if line.strip()]
    print(f"数据集样本: {len(rows)}")

    items = extract_terms(rows, args.min_count)
    top = items[: args.limit]
    lines = [f"{term}|{weight_for(count)}" for term, count in top]

    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")

    hi = sum(1 for _, c in top if c >= 10)
    mid = sum(1 for _, c in top if 4 <= c < 10)
    low = sum(1 for _, c in top if c < 4)
    print(f"候选 {len(items)} → 取前 {len(top)}（上限 {args.limit}）")
    print(f"分档: 权重11 {hi} 个 | 权重8 {mid} 个 | 权重5 {low} 个")
    print(f"频次范围: {top[0][1]} ~ {top[-1][1]}" if top else "无结果")
    print(f"\n已写入 {args.out}")
    print("前 15 个:", ", ".join(lines[:15]))


if __name__ == "__main__":
    main()
