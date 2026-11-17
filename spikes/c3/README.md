# C3 worktree：验证脚本（2026-11-17）

`resume-across-dirs.mjs`：在 worktree 里开始的对话，接手（删掉 worktree）以后能不能换到本地目录接着聊。用 Haiku，花费很少。

实测（Claude Agent SDK 0.3.321）：

| 做法 | 结果 |
|---|---|
| `getSessionMessages(id, { dir: worktree })` / `{ dir: 本地 }` / 不给目录 | 都能读到（Claude Code 会把同一个仓库的 worktree 当成一个项目来找会话） |
| worktree 还在，`cwd = 本地` + `resume` | 续接成功，记得之前的内容 |
| **删掉 worktree 以后**，`cwd = 本地` + `resume` | 续接成功 |
| `forkSession` 后用本地目录续接 | 也行，但没必要 |

结论：接手到本地以后，对话的工作目录直接改成本地项目目录，会话 ID 不变，不用复制或分叉会话记录。

## 顺带发现：SDK 不传 systemPrompt 时，没有 Claude Code 的默认系统提示

`system-prompt-default.mjs`：SDK 0.3.321 在 `systemPrompt` 没传时，初始化请求里发的是空字符串（`sdk.mjs` 里 `if(i===void 0)f=""`）。实测同一个问题第一次请求的输入：

| 设置 | 输入 token |
|---|---|
| 不传 systemPrompt（M1–C2 的 Claudex 就是这样） | 2269（只有工作目录、平台、CLAUDE.md 这些环境信息） |
| `{ type: 'preset', preset: 'claude_code' }` | 4863（多了 Claude Code 默认的那套使用说明） |

结论：Claudex 的对话改用 `preset: 'claude_code'`，和命令行里的 Claude Code 一致；项目环境的说明用 `append` 加在后面，并设 `snapshot: false`（不然续接旧会话时用的是第一次录下的提示，环境改了也不生效）。
