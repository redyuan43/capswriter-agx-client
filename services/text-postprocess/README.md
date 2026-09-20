# 转写文本整理（text-postprocess）

腾讯 ASR 输出后的本地整理层。ASR 仍走 `ssh ai` 上的腾讯适配服务，本模块只负责
拿到识别文本之后的整理。

## 目录

- `punc_core.py` — 标点恢复核心：**只回填标点，绝不改写正文字符**
- `punc_server.py` — 常驻进程，stdin/stdout JSON 协议（不开放端口）
- `models/ct-punc/` — CT-Punc 量化模型（软链到旧 CapsWriter 目录）
- `evaluate.py` — 回归评估脚本，用真实录音对比各阶段效果

## 重要实测结论（2026-09-20）

**CT-Punc 接在腾讯 ASR 之后是净退化，默认关闭。**

测试集：本机 `~/Documents/CapsWriter-Voice-Dataset` 3786 条真实录音。

| 现象 | 例子 |
|---|---|
| 吞掉英文单词间空格 | `有三个 PDF 文件` → `有三个PDF文件` |
| 删掉腾讯正确的标点 | `安装、部署、使用流程` → `安装部署使用流程` |
| 丢失问号 | `是不是？你也可以考虑` → `是不是你也可以考虑` |
| 切碎英文标识符 | `走线上TTS` → `走线，上TTS` |
| 重复标点 | `全部扫描完？` → `全部扫描完。？` |
| 长数字中间插句号 | `18081` → `180。81` |

统计：200 条样本里标点减少 42 条、增加 30 条，而"增加"的样本同样是退化。
根因是分布不匹配——CT-Punc 训练来给**无标点**文本加标点，腾讯已经给过标点了，
再全量重预测就是破坏。**腾讯自带标点质量高于这个 2020 年的模型。**

因此：`punctuation` 默认 `off`。`full` 模式保留，供后续换模型时对比评估。

## 已解决的两个坑

1. **空格被吞**：不采用模型返回文本，改用双指针把预测的标点回填到原文，
   原文字符（含空格、英文标识符）一字不动。`punc_core.restore_punctuation`
2. **数字被切断**：回填时禁止在「数字-数字」「数字-小数点」之间插入标点。
   实测 200 条真实样本，正文字符（去标点去空格）改变数 = **0**。

## 性能（本机 CPU 实测）

| 模式 | 冷启动 | 预热后 p50 | 预热后 p95 |
|---|---|---|---|
| 仅规则（默认） | 0 | 0ms | 0ms |
| 标点 full | ~14s（模型加载） | 4ms | 7ms |

冷启动 14s 只在首次发生，进程常驻后不再付这个成本。

## 模型来源

旧 CapsWriter 目录 `CapsWriter-Offline-Windows-64bit/models/punc_ct-transformer_cn-en/`
里的 `model_quant.onnx` 就是官方 `funasr/ct-punc` 的量化版，但**缺 `config.yaml` 和
`tokens.json`**，原样加载会报 `The ./config.yaml does not exist`。

已补齐：从 `https://huggingface.co/funasr/ct-punc` 下载这两个文件放进 `models/ct-punc/`
（vocab 471067，与旧 onnx 输出维度 6 完全匹配）。模型本体用软链，不额外占 1GB。

## 独立环境

```
/home/ivan/.workbuddy/binaries/python/envs/caps-punc
```

依赖见 `requirements.txt`。不修改客户端或其他模型服务的现有环境。

## 评估

```bash
cd services/text-postprocess
/path/to/caps-punc/bin/python3 evaluate.py --limit 200
```

输出腾讯原文 / 规则处理 / 标点恢复三者的差异统计，用于判断整理是否真的有收益。
