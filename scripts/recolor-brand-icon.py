#!/usr/bin/env python3
"""把品牌图标从旧配色确定性换色为「波尔多酒红」配色。

设计依据：SIYUAN 配色第三迭代 · 方向 II（Editorial Oxblood），原则是
「结构不变、只换配色」——主色 波尔多 #691E2E、底色 象牙白 #F7F2EE。

做法：现有素材只由两个基色构成（旧绿 #16A34A 与白 #FFFFFF），抗锯齿像素是
这两个基色的线性混合。脚本对每个不透明像素最小二乘求解混合系数 a，
再按新基色重投影，因此圆盘半径、S 字形几何、边缘灰阶过渡全部保持原样，
不重绘、不生成新图。

用法：
    python3 scripts/recolor-brand-icon.py            # 换色并写入（幂等，已换色时跳过）
    python3 scripts/recolor-brand-icon.py --check    # 只校验配色，不写文件
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent

# 旧基色（当前素材实测）与新基色（设计规范，以实测出图色 #691E2E 为准）
SOURCE_BASE = (22, 163, 74)      # #16A34A
SOURCE_MARK = (255, 255, 255)    # #FFFFFF
TARGET_BASE = (105, 30, 46)      # #691E2E 主色 · 波尔多
TARGET_MARK = (247, 242, 238)    # #F7F2EE 底色 · 象牙白

TARGETS = (
    ("assets/icon.png", (512, 512)),
    ("assets/tray-icon.png", (64, 64)),
)

# 落盘为 8 位整数后的允许通道误差
COLOR_TOLERANCE = 2
# 反向投影容许误差：512px 主图标只有取整误差（实测 1）；64px 托盘图标另有
# 历史缩放留下的少量非基色混合像素，实测上限 4，故留到 6。
MAX_ROUNDTRIP_DRIFT = 6


def solve_mix(
    pixel: tuple[int, int, int],
    base: tuple[int, int, int] = SOURCE_BASE,
    mark: tuple[int, int, int] = SOURCE_MARK,
) -> float:
    """求解 pixel = a * base + (1 - a) * mark 中的 a，并夹到 [0, 1]。"""
    deltas = [b - m for b, m in zip(base, mark)]
    denom = sum(d * d for d in deltas)
    numerator = sum((p - m) * d for p, m, d in zip(pixel, mark, deltas))
    return min(1.0, max(0.0, numerator / denom))


def project(mix: float, base: tuple[int, int, int], mark: tuple[int, int, int]) -> tuple[int, int, int]:
    return tuple(round(mix * b + (1 - mix) * m) for b, m in zip(base, mark))


def recolor(pixels: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """按两个基色重投影，保留原 alpha 通道。"""
    output = []
    for r, g, b, alpha in pixels:
        if alpha == 0:
            output.append((0, 0, 0, 0))
            continue
        mix = solve_mix((r, g, b))
        output.append(project(mix, TARGET_BASE, TARGET_MARK) + (alpha,))
    return output


def count_color(pixels, color: tuple[int, int, int], tolerance: int) -> int:
    return sum(
        1
        for r, g, b, alpha in pixels
        if alpha > 0
        and abs(r - color[0]) <= tolerance
        and abs(g - color[1]) <= tolerance
        and abs(b - color[2]) <= tolerance
    )


def relative_luminance(color: tuple[int, int, int]) -> float:
    channels = []
    for value in color:
        v = value / 255
        channels.append(v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast_ratio(foreground: tuple[int, int, int], background: tuple[int, int, int]) -> float:
    lighter, darker = sorted((relative_luminance(foreground), relative_luminance(background)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def reversible_drift(source_pixels, target_pixels) -> tuple[int, int]:
    """把换色结果反投影回旧基色，与旧图逐通道比对，用于验证「结构不变」。

    返回 (最大通道偏差, 偏差大于 1 的像素数)。
    """
    max_drift = 0
    drifted_pixels = 0
    for (r, g, b, alpha), (nr, ng, nb, _) in zip(source_pixels, target_pixels):
        if alpha == 0:
            continue
        restored = project(solve_mix((nr, ng, nb), TARGET_BASE, TARGET_MARK), SOURCE_BASE, SOURCE_MARK)
        drift = max(abs(x - y) for x, y in zip(restored, (r, g, b)))
        max_drift = max(max_drift, drift)
        if drift > 1:
            drifted_pixels += 1
    return max_drift, drifted_pixels


def process(relative_path: str, expected_size: tuple[int, int], check_only: bool) -> int:
    path = REPO_ROOT / relative_path
    if not path.exists():
        print(f"❌ 缺少图标文件：{relative_path}")
        return 1

    with Image.open(path) as source_image:
        image = source_image.convert("RGBA")
    if image.size != expected_size:
        print(f"❌ {relative_path} 尺寸异常：{image.size}，期望 {expected_size}")
        return 1

    source_pixels = list(image.getdata())
    source_base_pixels = count_color(source_pixels, SOURCE_BASE, COLOR_TOLERANCE)
    target_pixels = count_color(source_pixels, TARGET_BASE, COLOR_TOLERANCE)
    transparent_pixels = sum(1 for (*_, alpha) in source_pixels if alpha == 0)

    if target_pixels > 0 and source_base_pixels == 0:
        print(f"✅ {relative_path} 已是波尔多配色（圆底 #691E2E {target_pixels} 像素），跳过写入")
        return 0

    if check_only:
        print(f"❌ {relative_path} 仍为旧配色：旧绿像素 {source_base_pixels}，波尔多像素 {target_pixels}")
        return 1

    recolored_pixels = recolor(source_pixels)
    recolored = Image.new("RGBA", image.size)
    recolored.putdata(recolored_pixels)
    recolored.save(path, format="PNG", optimize=True)

    new_base = count_color(recolored_pixels, TARGET_BASE, COLOR_TOLERANCE)
    new_mark = count_color(recolored_pixels, TARGET_MARK, COLOR_TOLERANCE)
    leftover_green = count_color(recolored_pixels, SOURCE_BASE, COLOR_TOLERANCE)
    new_transparent = sum(1 for (*_, alpha) in recolored_pixels if alpha == 0)
    alpha_drift = sum(
        1
        for (_, _, _, old_alpha), (_, _, _, new_alpha) in zip(source_pixels, recolored_pixels)
        if old_alpha != new_alpha
    )
    roundtrip_drift, drifted_pixels = reversible_drift(source_pixels, recolored_pixels)

    problems = []
    if alpha_drift:
        problems.append(f"alpha 通道有 {alpha_drift} 个像素发生变化")
    if new_transparent != transparent_pixels:
        problems.append(f"透明像素 {new_transparent} != {transparent_pixels}")
    if new_base == 0:
        problems.append("未生成波尔多主色像素")
    if leftover_green:
        problems.append(f"仍残留旧绿像素 {leftover_green} 个")
    if roundtrip_drift > MAX_ROUNDTRIP_DRIFT:
        problems.append(f"反向投影最大通道误差 {roundtrip_drift} > {MAX_ROUNDTRIP_DRIFT}（结构被改变）")

    ratio = contrast_ratio(TARGET_MARK, TARGET_BASE)
    print(
        f"{'❌' if problems else '✅'} {relative_path} {image.size[0]}×{image.size[1]}："
        f"圆底 #691E2E {new_base} 像素、S #F7F2EE {new_mark} 像素、透明 {new_transparent} 像素，"
        f"反向投影最大通道误差 {roundtrip_drift}（偏差 >1 的像素 {drifted_pixels}）"
    )
    print(f"   酒红/象牙白对比度 {ratio:.2f}:1（设计规范对象牙白底 10.35:1 · AAA）")
    for problem in problems:
        print(f"   ⚠️ {problem}")
    return 1 if problems else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="品牌图标换色为波尔多酒红配色")
    parser.add_argument("--check", action="store_true", help="只校验配色，不修改文件")
    args = parser.parse_args()

    exit_code = 0
    for relative_path, expected_size in TARGETS:
        exit_code |= process(relative_path, expected_size, args.check)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
