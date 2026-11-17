# Claudex

本机 Claude Code 的桌面图形界面（Windows）。外观参照 Codex 桌面版。

Claudex 自己不实现智能体：实际干活的是本机的 Claude Code（通过官方的 Claude Agent SDK 调起），所以你的 Skills、MCP、CLAUDE.md、`~/.claude/settings.json` 里的中转 API 配置都会照常生效。

> 当前进度：M1 第一步（能用的聊天）+ C1 内置终端 + C2 Git 审查和提交 + C3 worktree 并行对话 + 项目环境（conda）+ 团队（老板-员工）。方案、决定和进度见 [PROJECT_STATUS.md](PROJECT_STATUS.md)，技术验证报告见 [docs/m0-report.md](docs/m0-report.md)。

## 使用

**双击 `Claudex.cmd`** 就能启动。第一次会自动安装依赖，需要几分钟。

或者在终端里：

```bash
npm install
npm start        # 构建并启动
npm run dev      # 开发模式（改代码后界面自动刷新）
```

需要：Node.js 22 以上、Git for Windows（Claude 运行 Bash 命令要用 Git Bash）、已配置好的 Claude Code（`~/.claude/settings.json`）。

## 现在能做什么

- 打开项目文件夹，在项目里开多个对话；对话列表重启后还在，打开能看到历史并接着聊
- Claude 的回复逐字显示，读文件、改文件、跑命令显示成一行一行的活动记录；改代码显示红绿对比
- 审批框：允许一次、总是允许、拒绝（可以附上原因）；计划模式的计划卡片；Claude 向你提问时的选项卡片
- 5 个模式：默认（询问）、自动接受编辑、计划模式、完全访问（切换前确认）、Skills 配置（自定义）；Shift+Tab 依次切换
- 模型选择器：模型、思考强度；走中转时快速模式置灰并说明原因
- 输入框：`/` 打开命令和 Skills，`@` 引用文件；停止按钮（Esc）；上下文用量
- 附件：Word、PDF、Excel、PPT、录音、视频、图片拖进对话区（或点 +、粘贴）就能交给 Claude；图片直接发，其他文件只带路径、不复制。Claude 用全局配置好的工具读（见 [docs/file-reading.md](docs/file-reading.md)）
- 内置终端：顶栏「终端」按钮或 Ctrl+` 打开；每个对话有自己的终端，就在项目目录里；可选 PowerShell、Git Bash、命令提示符；Ctrl+V 粘贴，选中文字时 Ctrl+C 复制；结束终端会把里面跑着的程序一起结束
- 改动面板（Git 审查和提交）：顶栏「改动」按钮显示未提交改动的行数，点开按“上一轮 / 未暂存 / 已暂存 / 整个分支”看改动；暂存、撤销（新文件进回收站）；鼠标移到某一行点 + 写评论发给 Claude；写提交说明或留空让 Claude 写；提交、推送、开 PR（用 gh）
- worktree 并行对话：新对话可以在输入框下面选“新 worktree”，在项目的独立副本里改代码，几个对话同时改同一个项目互不干扰；改完点顶栏的“接手到本地”，改动搬回项目文件夹成为未提交的改动
- 团队（老板-员工）：主对话是负责人，和你沟通需求、把能并行的活派给员工；员工是项目里的专职 Claude，各有档案（角色提示词、模型、能用的 Skills、长期记忆），存在项目的 `.claude/agents/` 和 `.claude/agent-memory/` 里。派活不用等，员工每个活开一个新对话去做，做完结果自动送回主对话；员工一律完全访问、全部工具（不用审批，保底黑名单照样拦截）；招人、改档案先弹卡片给你确认。左栏每个项目下面有“团队”，可以点开员工看他的对话、直接和他聊、改他的档案。员工的 Skills 从全局和项目现有的 Skill 里选（档案只记用哪些），他也可以自己调整（直接生效，只留记录）。员工之间可以转交、请同事帮忙；左栏“任务看板”看全部员工和任务
- 搜索和历史：左栏“搜索”（Ctrl+K）搜全部对话，包括在命令行里用过的 Claude Code 会话，打开就能接着聊；顶栏的“…”可以改名、置顶、分叉（复制一份试别的方向）、导出 Markdown 或 HTML
- 自动化：左栏“自动化”里设定时任务（每天 / 工作日 / 每周 / 每小时），每次运行开一个新对话，默认在新的 worktree 里；跑完、暂停等审批的结果进审查队列；关掉窗口缩到托盘在后台运行，App 没开时错过的下次打开补跑一次
- 项目环境（conda）：输入框下面给项目指定一个 conda 环境，项目里所有对话和终端都用它；没指定时 Claude 需要 Python 会先找现有的环境、没有就新建，再登记成项目环境
- 安全：新对话默认“询问”模式；保底黑名单（删除盘根或用户目录、强制推送、格式化磁盘、删除 ~/.claude）任何模式下都拦截；项目自带的 MCP 服务器第一次使用前先问你；添加带 hooks 的项目前先提醒

## 开发

```bash
npm run typecheck   # 类型检查
npm run test:unit   # 单元测试：保底黑名单、Skills 配置模式规则、时间线、附件、git diff 解析、git 操作、worktree、项目环境、员工档案、读附件命令、自动化的运行时刻、对话历史
npm run test:e2e    # 端到端测试：真正启动 App 并调用 Claude（会花少量 token），截图在 tests/e2e/.out/
node tests/e2e/run.mjs 01,02,17,18,19,20,21,22,23,24,25   # 只跑指定的步骤（这里是终端相关的几步，其中只有第 22 步调用 Claude）
```

代码结构：

| 目录 | 内容 |
|---|---|
| `src/main/` | 主进程：窗口、IPC、对话进程管理（`claude/`）、保底黑名单和模式规则（`guard/`）、内置终端（`terminal.ts`）、Git 操作（`git.ts`）、“上一轮”快照和文件监视（`review.ts`）、worktree（`worktree.ts`）、项目的 conda 环境（`conda.ts`）、团队（`team.ts`） |
| `src/preload/` | 把主进程能力安全地暴露给界面（`window.claudex`） |
| `src/renderer/` | 界面（React）：状态在 `store.ts`，消息流整理在 `timeline.ts` |
| `src/shared/` | 三方共用的类型和 IPC 通道 |
| `tests/` | 单元测试和端到端测试 |
| `prototype/` | 界面原型（静态网页） |
| `spikes/m0/` | M0 技术验证脚本 |
| `spikes/c1/` | C1 内置终端排查问题时的验证脚本（结论见 PROJECT_STATUS.md 的 C1 进度） |
| `spikes/files/` | 读取本地文件（文档、录音）的验证脚本 |
| `spikes/api/` | 换 API 的可行性验证（2026-11-17 决定不做，留作记录） |
| `spikes/c3/` | C3 的验证：跨 worktree 续接会话、SDK 默认系统提示 |

Electron 本体从国内镜像下载（本机直连 GitHub 不通），见 `scripts/install-electron.mjs`。
