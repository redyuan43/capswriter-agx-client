#!/usr/bin/env python3
"""hot-rule 候选规则的真实数据回归：拿 3807 条真实 ASR 输出逐条跑，
统计改动量、抽样人工核对，并检查误伤。

用法:
    python3 rule_regression.py [--dataset DIR] [--show K]
"""
import argparse
import json
import os
import re
import sys

# ---- 候选新规则（顺序即应用顺序；与 hot-rule.txt 保持一致）----
# 注意：本脚本用 Python re，且刻意不用 \b（Python 的 \w 含中文，语义与 JS 不同）
NEW_RULES = [
    ("Tailscale 统一写法",
     r"[Tt][Aa][Ii][Ll]\s*[Ss][Cc][Aa][Ll][Ee]",
     "Tailscale"),
    ("tcale -> Tailscale",
     r"(?<![A-Za-z])tcale(?![A-Za-z])",
     "Tailscale"),
    ("github 统一写法",
     r"[Gg][Ii][Tt]\s*[Hh][Uu][Bb](?![A-Za-z])",
     "GitHub"),
    ("webstick -> VibeStick",
     r"(?<![A-Za-z])webstick(?![A-Za-z])",
     "VibeStick"),
    ("agx -> AGX",
     r"(?<![A-Za-z])agx(?![A-Za-z])",
     "AGX"),
    ("中英之间补空格（中文→拉丁）",
     r"([\u3400-\u4dbf\u4e00-\u9fff])([A-Za-z])",
     r"\1 \2"),
    ("中英之间补空格（拉丁→中文）",
     r"([A-Za-z])([\u3400-\u4dbf\u4e00-\u9fff])",
     r"\1 \2"),
]


def load(ds):
    out = []
    p = os.path.join(ds, "metadata.jsonl")
    for line in open(p, encoding="utf-8"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        t = d.get("final_text") or d.get("text") or ""
        if t.strip():
            out.append((d.get("created_at", ""), t))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=os.path.expanduser("~/Documents/CapsWriter-Voice-Dataset"))
    ap.add_argument("--show", type=int, default=6)
    args = ap.parse_args()

    recs = load(args.dataset)
    total = len(recs)
    print(f"样本 {total} 条  —  hot-rule 候选规则回归")
    print("=" * 74)

    changed = []
    per_rule = {name: 0 for name, _, _ in NEW_RULES}
    for ts, t in recs:
        cur = t
        for name, pat, rep in NEW_RULES:
            nxt = re.sub(pat, rep, cur)
            if nxt != cur:
                per_rule[name] += 1
                cur = nxt
        if cur != t:
            changed.append((ts, t, cur))

    print("\n【逐条规则命中条目数】")
    for name, _, _ in NEW_RULES:
        print(f"  {name:36s} {per_rule[name]:5d}")

    print(f"\n【汇总】改动条目 {len(changed)} / {total}  ({len(changed)/total*100:.1f}%)")

    print(f"\n【改动实拍（最新 {args.show} 条）】")
    for ts, before, after in sorted(changed)[-args.show:]:
        print(f"  [{ts[:16]}]")
        print(f"    - {before[:110]}")
        print(f"    + {after[:110]}")

    # ---- 误伤检查 ----
    print("\n【误伤检查】")
    # 1) 改动只应发生在：空格插入 / 指定专名替换。逐条 diff 到字符级，看有没有别的字符被动
    def strip_all(s):
        return re.sub(r"[\s]", "", s)

    suspicious = []
    for ts, before, after in changed:
        b, a = strip_all(before), strip_all(after)
        if len(b) != len(a):
            suspicious.append(("长度变化", before, after))
            continue
        # 逐字符比较（去空格后应完全一致，除了专名大小写替换）
        diffs = [(x, y) for x, y in zip(b, a) if x != y]
        # 允许的差异：大小写转换，或 Tailscale/VibeStick/AGX 这类替换
        for x, y in diffs:
            if x.lower() == y.lower():
                continue
            suspicious.append(("非大小写差异", before, after))
            break
    if not suspicious:
        print("  ✓ 无：所有改动都是插入空格或大小写/专名规范化，没有增删汉字与字母")
    else:
        print(f"  ! 可疑 {len(suspicious)} 条（需人工核对）：")
        seen = set()
        for kind, before, after in suspicious:
            key = after[:30]
            if key in seen:
                continue
            seen.add(key)
            print(f"    [{kind}] - {before[:90]}")
            print(f"               + {after[:90]}")
            if len(seen) >= 6:
                break

    # 2) 空格重复 / 空格紧贴标点
    bad_space = [a for _, _, a in changed if re.search(r"  |\s[，。！？、；：]|[，。！？、；：]\s", a)]
    print(f"  连续空格或空格紧贴标点: {len(bad_space)}")
    for s in bad_space[:3]:
        print(f"    {s[:90]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
