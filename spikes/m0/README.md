# M0 技术验证脚本

验证 Claude Agent SDK 在本机 + 中转 API 下的关键能力。结论见 [`docs/m0-report.md`](../../docs/m0-report.md)。

| 脚本 | 验证什么 |
|---|---|
| `01-connect.mjs` | 经中转跑通；会话加载了哪些 Skills / 插件 / MCP；不传权限模式会怎样；改用本机已装的 Claude Code |
| `01b-shell-tools.mjs` | 为什么没有 Bash 工具（要设 `CLAUDE_CODE_GIT_BASH_PATH`） |
| `02-gitbash.mjs` | 用的是 Git Bash，不是 WSL |
| `03-edit-resume.mjs` | 读改文件、续接、分叉、会话历史接口 |
| `04-permissions.mjs` | 审批回调、中途切模式、完全访问下的保底黑名单 |
| `05-models.mjs` / `05b-fast.mjs` | 模型、思考强度、快速模式 |
| `06-skills-mcp.mjs` / `06b` / `06c` | 关闭 / 限定 Skills、项目级 MCP 和拦截、结构化输出 |
| `07-parallel.mjs` | 多个对话并行 + worktree + 内存 |
| `08-suspend.mjs` | 审批长时间不回答；等审批时退出再续接 |
| `pty/main.mjs` | node-pty 和 SDK 在 Electron 主进程里 |
| `summary.mjs` | 汇总 `results/` 下的结果 |

运行：`npm install`，然后 `node <脚本>`。`pty/` 用 `./node_modules/electron/dist/electron.exe main.mjs` 运行。测试默认用 Haiku 5.5，`M0_MODEL` 环境变量可以换模型。运行时生成的 `sandbox/` 不进 git。
