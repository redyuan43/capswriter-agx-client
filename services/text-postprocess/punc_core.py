"""标点恢复核心：只回填标点，绝不改写正文字符。

腾讯 ASR 输出的断句常有错误（例如「看到状态的。上同步也…」）。
CT-Punc 能重新判断句读，但它会顺手吞掉英文单词间的空格
（「PDF 文件」→「PDF文件」），这在技术口述里属于改坏正文。

因此这里不直接采用模型返回的文本，而是：
    1. 剥离腾讯原有标点（保护版本号/小数/网址/路径等结构）
    2. 交给 CT-Punc 预测
    3. 只把预测的标点「回填」到原文对应位置，原文字符一字不动
"""

import re

def _is_ascii_alnum(ch):
    """是否为 ASCII 字母或数字（CJK 字符一律返回 False）。"""
    return bool(ch) and ("a" <= ch <= "z" or "A" <= ch <= "Z" or "0" <= ch <= "9")


# CT-Punc 的输出类别（config.yaml 的 punc_list）
PUNCS = "，。？、"

# 受保护片段：这些内部的标点（小数点、路径分隔符、URL 的 : / .）不能被剥离，
# 也不能被模型重新加标点破坏。
PROTECTED_PATTERNS = [
    # URL / 邮箱
    r"(?:https?|ftp)://[^\s，。？、]+",
    r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b",
    # 版本号 / IP / 小数：数字之间带点
    r"\b\d+(?:\.\d+)+\b",
    # Windows 路径 / Unix 路径
    r"[A-Za-z]:[\\/][^\s，。？、]*",
    r"(?:/[\w.\-]+){2,}",
    # 代码标识符：含下划线、点号、连字符的英文串（如 AGENTS.md、foo_bar）
    r"\b[A-Za-z][\w]*(?:[._-][\w]+)+\b",
]


def split_protected(text):
    """把文本切成 [(片段, 是否受保护)]，受保护片段原样保留。"""
    spans = []
    for pattern in PROTECTED_PATTERNS:
        for m in re.finditer(pattern, text):
            spans.append((m.start(), m.end()))
    if not spans:
        return [(text, False)]

    # 合并重叠区间
    spans.sort()
    merged = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    result = []
    cursor = 0
    for start, end in merged:
        if start > cursor:
            result.append((text[cursor:start], False))
        result.append((text[start:end], True))
        cursor = end
    if cursor < len(text):
        result.append((text[cursor:], False))
    return result


def strip_punctuation(text):
    """剥离标点，受保护片段内部保持原样。"""
    out = []
    for chunk, protected in split_protected(text):
        if protected:
            out.append(chunk)
        else:
            # 只删中英文标点，保留空格与字母数字
            out.append(re.sub(r"[，。？、,.;:!?！？]+", "", chunk))
    return "".join(out)


def restore_punctuation(original, punctuated):
    """把 punctuated 中的标点回填到 original，original 的字符（含空格）一字不改。

    双指针扫描：punctuated 去重空格后应与 original 去重空格后同序，
    遇到 punctuated 的标点就插入，其余字符一律取自 original。
    """
    result = []
    i = 0  # original 指针
    j = 0  # punctuated 指针
    n = len(original)
    m = len(punctuated)

    while j < m:
        pch = punctuated[j]
        if pch in PUNCS:
            # 标点：插入（若上一位已是标点则跳过，避免重复）
            if result and result[-1] in PUNCS:
                # 特例：「。」后接「？」时升级为问号，疑问句语气优先
                if result[-1] == "。" and pch == "？":
                    result[-1] = "？"
                j += 1
                continue
            # 硬保护：绝不在数字之间插入标点（「18081」不能被切成「180。81」）
            prev_ch = result[-1] if result else ""
            k = i
            while k < n and original[k] in PUNCS:
                k += 1
            next_ch = original[k] if k < n else ""
            if prev_ch.isdigit() and next_ch.isdigit():
                j += 1
                continue
            # 硬保护：数字与其紧邻的小数点之间也不插入
            if prev_ch.isdigit() and next_ch == ".":
                j += 1
                continue
            if prev_ch == "." and next_ch.isdigit():
                j += 1
                continue
            # 硬保护：绝不在英文单词内部插入标点
            # 实测踩到过「empty response」被切成「empty respons。e」——
            # 相邻两个 ASCII 字母/数字之间一定属于同一个 token（真正的词边界处原文有空格）。
            if _is_ascii_alnum(prev_ch) and _is_ascii_alnum(next_ch):
                j += 1
                continue
            result.append(pch)
            j += 1
            continue

        # 非标点字符：从 original 取，跳过 original 里的旧标点与多余空格
        while i < n and original[i] in PUNCS:
            i += 1
        if i >= n:
            break

        if original[i] == pch:
            result.append(original[i])
            i += 1
            j += 1
        elif original[i] == " " and pch != " ":
            # original 有空格而模型输出没有（如「PDF 文件」→「PDF文件」）：保留空格
            result.append(" ")
            i += 1
            # 不推进 j，下一轮再比对
        elif pch == " " and original[i] != " ":
            # 模型多出空格：丢弃
            j += 1
        else:
            # 不匹配（罕见）：以 original 为准，同步推进避免死循环
            result.append(original[i])
            i += 1
            j += 1

    # 补上 original 剩余部分
    while i < n:
        result.append(original[i])
        i += 1

    text = "".join(result)
    # 清理：行首标点、连续重复标点
    text = re.sub(r"^[，。？、]+", "", text)
    text = re.sub(r"([，。？、])\1+", r"\1", text)
    # 「，。」「，？」：逗号/顿号后紧跟句末标点时，删掉前者
    text = re.sub(r"[，、]+(?=[。？])", "", text)
    # 句末连续多个句号/问号（如「。？」「？。」）收敛为一个，问号优先
    tail = re.search(r"[。？]{2,}$", text)
    if tail:
        text = text[: tail.start()] + ("？" if "？" in tail.group(0) else "。")
    return text


def apply_punc(model, text):
    """对一句文本执行标点恢复。失败时返回原文。"""
    if not text or not text.strip():
        return text

    stripped = strip_punctuation(text)
    if not stripped.strip():
        return text

    try:
        output = model(stripped)
        punctuated = output[0] if isinstance(output, (list, tuple)) else output
    except Exception:
        return text

    if not punctuated:
        return text

    return restore_punctuation(text, punctuated)
