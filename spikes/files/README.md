# 读取本地文件：验证脚本

结论汇总见 [docs/file-reading.md](../../docs/file-reading.md)。在仓库根目录运行。

| 脚本 | 做什么 |
|---|---|
| `make-sample.ps1`、`make-sample-en.ps1` | 用 Windows 自带的语音合成生成中文、英文测试录音 |
| `make_samples.py` | 生成 docx、pptx、xlsx，再用 LibreOffice 转出 pdf、doc、xls、ppt（每个文件里有一个标记词） |
| `bench_whisper.py` | 本机 CPU 上比较 faster-whisper small 和 large-v3 的速度和准确度 |
| `sdk-read.mjs` | 像 Claudex 一样起“默认：询问”模式的会话，把项目外的各种文件交给 Claude，看它怎么读、弹几次审批、读得对不对 |
| `sdk-powershell.mjs` | 指定用 PowerShell 工具跑 doc2md、audio-transcribe，验证 `PowerShell(...)` 自动放行规则生效 |

生成的样本文件（`samples/`、`*.wav`、`*.mp4`）和临时目录 `proj/` 不进仓库。
