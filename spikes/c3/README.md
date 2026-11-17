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
