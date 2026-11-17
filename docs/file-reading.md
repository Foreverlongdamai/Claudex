# 读取本地文件：Claudex 附件 + Claude Code 全局环境

2026-11-17 做的。目标：Word、PDF、Excel、PPT、录音、视频等本地文件拖进 Claudex 就能交给 Claude；Claude 每次都按固定的方法读，不用重新摸索，也不弹审批。

## 一、Claudex 里（在本仓库）

- 拖文件到对话区任意位置（或点输入框左下角的 +、或在资源管理器里复制后粘贴）就成为附件
  - 图片（png、jpg、gif、webp，5 MB 以内）直接作为图片发给 Claude 看
  - 其他文件**不复制、不上传内容**，消息里只带完整路径（原地引用），包在 `<claudex-attachments>` 里放在消息开头；界面上显示成文件小卡片
  - 拖到终端上则把路径（按当前 shell 加好引号）粘贴进终端
- Claude 用 Read 工具读附件时自动放行（项目目录外的文件 Claude Code 默认会问）
- 代码：`src/shared/attachments.ts`（包和拆）、`src/renderer/src/drop.ts`、`App.tsx`（接住拖放）、`Composer.tsx`、`FileChip.tsx`、`session.ts`（`isAttached`）

## 二、Claude Code 全局环境（不在本仓库，对命令行和 Claudex 都生效）

| 位置 | 改了什么 | 为什么 |
|---|---|---|
| `~/.claude/CLAUDE.md`（新建） | “读取本地文件”规则表：文件类型 → 用什么读 | 每次会话都会加载，Claude 不用再想怎么读 |
| `~/.claude/settings.json` 的 `env` | 加 `PYTHONUTF8=1` | Windows 上 Python 输出到管道默认是 GBK，Claude 读到的中文是乱码（实测 markitdown 输出全乱） |
| `~/.claude/settings.json` 的 `permissions.allow` | `Bash(...)` 和 `PowerShell(...)` 各一组：`doc2md`、`markitdown`、`audio-transcribe`、`pdftotext`、`pdfinfo` | 这些命令只读不写，自动放行。Windows 上 Claude 有时用 Bash 工具、有时用 PowerShell 工具，两种都要写（实测只写 Bash 时用 PowerShell 照样弹审批） |
| `~/.claude/skills/audio-transcribe/`（新建 skill） | 录音/视频转文字：本机 faster-whisper large-v3，CPU 约 0.7 倍速；结果缓存在 `~/.claude/skill-cache/transcripts/` | 本机装了 faster-whisper 和模型，但没有 skill 包装，Claude 不知道 |
| `~/.claude/skill-bin/doc2md/`（新命令） | 一步把 Word/PPT/Excel（含 .doc .ppt 等老格式）转成 Markdown；老格式自动用 LibreOffice 转换（专用配置目录 + 排队，结果缓存） | markitdown 不认老格式；同时转两个老格式文件时 LibreOffice 必定失败一个（实测）；命令里带 `$TEMP` 这类变量时自动放行规则不生效 |
| `claude-skills` Python 环境 | 装了 `pdfplumber`、`xlrd`，以及上面两个命令（可编辑安装，改源文件即生效） | office-pdf skill 依赖 pdfplumber；markitdown 读 .xls 要 xlrd |

改之前的 `settings.json` 备份在 `~/.claude/settings.json.bak-20261117`。

还原：删掉 `~/.claude/CLAUDE.md` 和 `~/.claude/skills/audio-transcribe/`，用备份恢复 `settings.json`，
`D:\Anaconda\envs\claude-skills\python.exe -m pip uninstall claude-audio-transcribe claude-doc2md`。

## 三、实测（验证脚本在 `spikes/files/`）

| 文件 | 读法 | 结果 |
|---|---|---|
| docx、pptx、xlsx、xls、pdf | doc2md / markitdown | ✅ |
| doc、ppt（老格式） | doc2md（LibreOffice 转换 4–8 秒，之后有缓存） | ✅；3 个同时转也都成功 |
| PDF | Claude 的 Read 工具 | ✅ |
| 录音（wav）、视频（mp4） | audio-transcribe | ✅ 中英文自动识别；38 秒录音 large-v3 用 57 秒，第二次走缓存 2 秒 |

转写速度（Ryzen 9 8945HX，无独显）：large-v3 约 0.7 倍速（1 小时录音约 85 分钟），small 约 3.2 倍速但错字多；用户选了一律 large-v3。
专有名词容易听错（“Claude” 听成 “Cloud”），skill 里要求 Claude 结合上下文纠正并说明。

端到端测试第 26、27 步覆盖：附件放在项目目录外、路径带空格和中文，整轮不能弹任何审批、模式不能变，回复里要有每个文件的标记词。
