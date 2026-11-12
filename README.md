# Claudex

本机 Claude Code 的桌面图形界面（Windows）。外观参照 Codex 桌面版。

Claudex 自己不实现智能体：实际干活的是本机的 Claude Code（通过官方的 Claude Agent SDK 调起），所以你的 Skills、MCP、CLAUDE.md、`~/.claude/settings.json` 里的中转 API 配置都会照常生效。

> 当前进度：M1 第一步（能用的聊天）+ C1 内置终端。方案、决定和进度见 [PROJECT_STATUS.md](PROJECT_STATUS.md)，技术验证报告见 [docs/m0-report.md](docs/m0-report.md)。

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
- 输入框：`/` 打开命令和 Skills，`@` 引用文件，可以直接粘贴图片；停止按钮（Esc）；上下文用量
- 内置终端：顶栏「终端」按钮或 Ctrl+` 打开；每个对话有自己的终端，就在项目目录里；可选 PowerShell、Git Bash、命令提示符；Ctrl+V 粘贴，选中文字时 Ctrl+C 复制；结束终端会把里面跑着的程序一起结束
- 安全：新对话默认“询问”模式；保底黑名单（删除盘根或用户目录、强制推送、格式化磁盘、删除 ~/.claude）任何模式下都拦截；项目自带的 MCP 服务器第一次使用前先问你；添加带 hooks 的项目前先提醒

## 开发

```bash
npm run typecheck   # 类型检查
npm run test:unit   # 单元测试：保底黑名单、Skills 配置模式规则、时间线
npm run test:e2e    # 端到端测试：真正启动 App 并调用 Claude（会花少量 token），截图在 tests/e2e/.out/
node tests/e2e/run.mjs 01,02,17,18,19,20,21,22,23,24,25   # 只跑指定的步骤（这里是终端相关的几步，其中只有第 22 步调用 Claude）
```

代码结构：

| 目录 | 内容 |
|---|---|
| `src/main/` | 主进程：窗口、IPC、对话进程管理（`claude/`）、保底黑名单和模式规则（`guard/`）、内置终端（`terminal.ts`） |
| `src/preload/` | 把主进程能力安全地暴露给界面（`window.claudex`） |
| `src/renderer/` | 界面（React）：状态在 `store.ts`，消息流整理在 `timeline.ts` |
| `src/shared/` | 三方共用的类型和 IPC 通道 |
| `tests/` | 单元测试和端到端测试 |
| `prototype/` | 界面原型（静态网页） |
| `spikes/m0/` | M0 技术验证脚本 |
| `spikes/c1/` | C1 内置终端排查问题时的验证脚本（结论见 PROJECT_STATUS.md 的 C1 进度） |

Electron 本体从国内镜像下载（本机直连 GitHub 不通），见 `scripts/install-electron.mjs`。
