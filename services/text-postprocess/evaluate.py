"""回归评估：用真实录音对比「腾讯原文 / 规则替换 / 标点恢复」三者差异。

用法：
    python3 evaluate.py                 # 默认跑 200 条
    python3 evaluate.py --limit 500     # 跑 500 条
    python3 evaluate.py --show 10       # 多打印几条样例

判定标准（与接入方案一致）：
    - 正文字符（去标点去空格）发生任何改变 = 严重违规，必须为 0
    - 数字、英文标识符被改动 = 严重违规
    - 标点数量变化只作参考，不代表变好
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEFAULT_DATASET = os.path.expanduser("~/Documents/CapsWriter-Voice-Dataset/metadata.jsonl")
PUNC_RE = re.compile(r"[，。？、,.;:!?！？]")


def normalize(text):
    """去掉标点与空白，只留正文字符，用于校验正文是否被改写。"""
    return re.sub(r"[\s，。？、,.;:!?！？]+", "", text or "")


def load_samples(path, limit, min_len=10):
    samples = []
    if not os.path.exists(path):
        print(f"数据集不存在: {path}")
        return samples
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            text = (row.get("text") or "").replace("\n", " ").strip()
            if len(text) >= min_len:
                samples.append(text)
            if limit and len(samples) >= limit:
                break
    return samples


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--show", type=int, default=6)
    parser.add_argument("--punctuation", action="store_true", help="同时评估标点恢复（默认关闭）")
    args = parser.parse_args()

    samples = load_samples(args.dataset, args.limit)
    if not samples:
        print("没有可用样本")
        return 1

    print(f"样本数: {len(samples)}  数据集: {args.dataset}")

    model = None
    if args.punctuation:
        try:
            from funasr_onnx import CT_Transformer

            model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "ct-punc")
            model = CT_Transformer(model_dir, quantize=True)
        except Exception as error:
            print(f"标点模型不可用，跳过标点评估: {error}")
            model = None

    body_violations = []
    punc_stats = {"reduced": 0, "increased": 0, "same": 0}
    examples = []

    for text in samples:
        baseline = text
        if model is not None:
            try:
                from punc_core import apply_punc

                baseline = apply_punc(model, text)
            except Exception as error:
                print(f"标点处理失败: {error}")
                model = None
                baseline = text

        if normalize(baseline) != normalize(text):
            body_violations.append((text, baseline))

        before = len(PUNC_RE.findall(text))
        after = len(PUNC_RE.findall(baseline))
        if after < before:
            punc_stats["reduced"] += 1
        elif after > before:
            punc_stats["increased"] += 1
        else:
            punc_stats["same"] += 1

        if baseline != text and len(examples) < args.show:
            examples.append((text, baseline))

    print()
    print("=== 正文完整性（最关键） ===")
    print(f"正文字符被改写的样本数: {len(body_violations)}   <-- 必须为 0")
    for original, changed in body_violations[:5]:
        print(f"  原: {original}")
        print(f"  改: {changed}")

    print()
    print("=== 标点数量变化（仅供参考，不等于变好） ===")
    print(f"减少: {punc_stats['reduced']}  增加: {punc_stats['increased']}  不变: {punc_stats['same']}")

    print()
    print("=== 差异样例 ===")
    if not examples:
        print("（无差异）")
    for original, changed in examples:
        print(f"  原: {original}")
        print(f"  新: {changed}")
        print()

    return 0 if not body_violations else 2


if __name__ == "__main__":
    sys.exit(main())
