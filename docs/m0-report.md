# M0 技术验证报告

日期：2026-11-10
结论：**桌面 App 依赖的关键能力，在你的电脑和中转 API 下全部能跑通，可以进入 M1。** 有 8 条发现必须落实到设计里（第 2 节）。还有几条好消息，能让后面的工作更简单（第 3 节）。

验证脚本在 `spikes/m0/`，每项结果在 `spikes/m0/results/*.json`。共 59 项检查，通过 55 项；没通过的 4 项见第 5 节，其中只有"快速模式"是真的不可用。总花费约 $0.48（按官方价估算，实际以中转计费为准）。

---

## 1. 验证点逐项结果

| # | 验证点 | 结果 | 说明 |
|---|---|---|---|
| 1 | 经中转 API 调用 Claude Code | ✅ | 启动约 1 秒，首字 1.4–3.2 秒（因模型而异） |
| 2 | 加载你的 Skills、插件、MCP | ✅ | 191 个 Skills、8 个插件、codex MCP 已连接 |
| 3 | 读文件、改文件 | ✅ | |
| 4 | 续接、分叉会话 | ✅ | 续接沿用原会话 ID，分叉生成新 ID，都带着原来的记忆 |
| 5 | 审批回调 `canUseTool` | ✅ | 允许、拒绝都对；回调里带了"总是允许"要用的权限建议 |
| 6 | 对话中途切换模式 | ✅ | 默认 ↔ 自动接受编辑 ↔ 计划 ↔ 完全访问，来回切都立即生效 |
| 7 | 完全访问下保底黑名单（PreToolUse hook） | ✅ | 完全访问时 hook 照样被调用，黑名单命令被拦截 |
| 8 | 思考强度 | ✅ | SDK 有 `effort` 选项（low / medium / high / xhigh / max），中转能用 |
| 9 | 中转支持的模型 | ✅ | Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1 都能用 |
| 10 | 快速模式 | ❌ | 走中转不可用（见 2.6） |
| 11 | 项目里关掉部分 Skills（`skillOverrides`） | ✅ | 关掉的 Skills 不再出现 |
| 12 | 按会话限定 Skills（`skills` 选项） | ✅ | 只开 2 个时，Claude 只看得到这 2 个；系统提示少了约 16% |
| 13 | 项目级 MCP（`claude mcp add --scope project`） | ✅ | 写出 `.mcp.json`，约 1 秒连上，Claude 能调用（安全问题见 2.4） |
| 14 | 结构化输出（Skills 配置模式的推荐清单） | ✅ | 返回的 JSON 符合格式 |
| 15 | 多个对话并行 + worktree | ✅ | 3 个对话同时改同一项目的 3 个工作区，互不干扰；总耗时和单个一样 |
| 16 | 审批长时间不回答 | ✅ | 晚 50 秒才回答，会话一直等着，然后正常完成 |
| 17 | 等审批时 App 退出，之后恢复 | ✅ | 关掉时命令没执行；续接后 Claude 把事做完了 |
| 18 | 终端组件 node-pty 在 Electron 里 | ✅ | PowerShell、Git Bash 都能开，用的是预编译版，不需要 C++ 编译组件 |
| 19 | SDK 在 Electron 主进程里 | ✅ | |

## 2. 必须落实到设计里的发现

### 2.1 每个对话都必须显式传权限模式
不传 `permissionMode` 时，会话会继承设置文件里的 `permissions.defaultMode`。你的全局设置是 `bypassPermissions`，所以不传就会**直接进完全访问**（实测如此）。
→ App 开每个对话时都明确传模式，新对话默认 `'default'`（"默认：询问"）。

### 2.2 每个对话启动时都要打开完全访问的安全开关
启动时没传 `allowDangerouslySkipPermissions: true` 的会话，中途切不到完全访问（实测会被拒绝："session was not launched with --dangerously-skip-permissions"）。
→ App 启动每个对话时都传 `allowDangerouslySkipPermissions: true`，同时传 `permissionMode: 'default'`。实测这样启动后仍是默认模式，审批照常；只是保留了以后切到完全访问的可能。

### 2.3 Git Bash 要显式指定
SDK 调起的 Claude Code 自己找不到 Git Bash，内置版和你装的版本都一样，结果只有 PowerShell 工具、没有 Bash 工具。很多 Skills 是按 Bash 写的。
→ App 通过环境变量 `CLAUDE_CODE_GIT_BASH_PATH` 指定路径：从 `git` 的安装位置自动推出（你的电脑上是 `D:\git\Git\bin\bash.exe`），找不到时在设置里让用户手动选。设好之后用的是 Git Bash（MINGW64），没有误用 WSL。

### 2.4 项目里的 `.mcp.json` 会自动启动，App 要自己把关
命令行版遇到项目里没批准过的 MCP 服务器，会先问用户；SDK 会话里**不问，直接启动**。别人项目的 `.mcp.json` 可以指定任意命令，打开一个陌生仓库就可能跑起里面的程序。
→ App 打开项目时，发现没批准过的 MCP 服务器先问用户；没批准的通过设置项 `disabledMcpjsonServers` 拦住（实测拦得住，服务器不会启动）。

### 2.5 每个对话约占 250 MB 内存
并行 3 个对话时，3 个 `claude.exe` 进程合计 743 MB。
→ 限制同时运行的对话数（设置里可调，默认 4 个）。闲置的对话关掉进程，用户再点开时用"续接"恢复（第 1 节第 4 项已证明可靠，不会丢上下文）。SDK 还有预热接口 `prewarm()`，可以提前启动一个空闲进程，缩短新对话的启动时间。

### 2.6 走中转时快速模式不可用
设置项 `fastMode: true` 能通过"SDK 需要主动开启"这一关，但状态始终是 off（原因：`preference`），实际速度还是 `standard`。启动时开、对话中途开都试过。Claude Code 程序里还有一条提示："Fast mode is only available when using the Anthropic API directly"（快速模式只在直连 Anthropic API 时可用）。
→ 模型选择器里"⚡ 快速"置灰，注明"走中转时不可用"。将来改成直连 API，再按 init 消息里的 `fast_mode_state` 动态开放。

### 2.7 Electron 安装和打包
- 从 GitHub 下载 Electron 本体失败，改用国内镜像（npmmirror）成功。→ 项目里配置 Electron 镜像。
- 打包时，SDK 自带的 `claude.exe` 和 node-pty 的原生文件不能放进 asar 压缩包，要配置 `asarUnpack`。

### 2.8 关终端用 exit，不要强杀
node-pty 在 Electron 里调用 `kill()` 时，它的辅助进程会报 `AttachConsole failed`。先发 `exit` 让 shell 自己退出就没有问题（实测 PowerShell、Git Bash 约 1.5 秒内都能正常退出）。
→ 关闭终端时先发 `exit` 或 Ctrl+C，超时再用 `taskkill /T` 结束进程树。这个细节在 C1 处理。

## 3. 好消息：能让后面的工作更简单

1. **SDK 有官方的会话历史接口**：`listSessions` 列出会话，带标题、首句话、Git 分支、时间等字段；`getSessionMessages` 读消息；`forkSession` 分叉会话。M2 原计划要自己解析没有官方文档的 jsonl 文件，现在改用官方接口，"jsonl 格式会变"这个风险基本消除，工作量也少了。
2. **Skills 配置模式有两种现成做法**：
   - 会话选项 `skills`：只对 App 里的这一个对话生效；
   - 项目设置 `skillOverrides`：写进项目文件，命令行也生效。
   推荐清单用结构化输出，实测稳定。
3. **自动化的"暂停等审批"可行**：审批回调可以一直不回答，会话会等着；App 退出后，续接还能接着做。
4. **Worktree 有专门的选项**：`projectConfigRoot` 可以让 worktree 会话沿用主项目的设置、MCP 和 Skills。
5. **改动面板的"撤销"可以用 SDK 的文件检查点**：打开 `enableFileCheckpointing` 后，能用 `rewindFiles()` 把文件退回到某条消息之前的状态。
6. **SDK 能直接告诉 App 很多信息**：模型列表（每个模型支持哪些思考强度、能否快速模式）、MCP 连接状态、上下文用量（`getContextUsage`），界面上的这些数据都不用自己算。

## 4. 版本和关键数据

| 项目 | 值 |
|---|---|
| Claude Agent SDK | 0.3.321（自带 Claude Code 2.1.321） |
| 本机已装 Claude Code | 2.1.319（也能用，通过 `pathToClaudeCodeExecutable` 指定） |
| Electron | 45.2.3（内置 Node 24.22.2） |
| node-pty | 1.1.0（自带 Windows 预编译版） |
| 启动到 init | 约 0.8–1.0 秒 |
| 系统提示大小 | 约 2.9 万 token（主要是 191 个 Skills 的列表），第二轮起走缓存 |
| 每个对话的内存 | 约 250 MB |

**用哪个 Claude Code**：建议默认用 SDK 自带的版本。它和 SDK 一起发布、一起测试，SDK 的部分新功能要求 Claude Code 达到一定版本；设置里保留"改用本机安装的版本"选项。两个版本差别很小（2.1.321 和 2.1.319），实测都能用。

## 5. 没通过的 4 项

| 检查 | 原因 | 结论 |
|---|---|---|
| 快速模式实际生效 | 走中转不可用 | 真问题，见 2.6 |
| 会话选项 skills 只留下指定的 Skills（06） | 检查方法不对：init 列的是磁盘上发现的全部 Skills，过滤的是"给模型看的列表" | 06b 换了方法复查：Claude 确实只看得到指定的 2 个，功能正常 |
| 批准后项目 MCP 能连上（06） | 查得太早：`pending` 表示还在连接 | 06b 轮询后约 1 秒变成 connected，功能正常 |
| skills 选项让系统提示明显变小（06b） | 门槛是我随手定的 20%，实际少了 16%（约 4,700 token） | 功能正常，只是门槛定高了 |

## 6. 怎么复现

```bash
cd spikes/m0
npm install
node 01-connect.mjs   # 依次运行 01 … 08（01b、05b、06b、06c 是补充测试）
node summary.mjs      # 汇总所有结果

cd pty
npm install           # Electron 下载失败时：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
./node_modules/electron/dist/electron.exe main.mjs
```

测试默认用 Haiku 5.5，可以用环境变量 `M0_MODEL` 换成别的模型。测试会话只写在 `spikes/m0/sandbox/`；除了 03 和 08 需要续接，其他测试都不保存会话记录，不会混进你的对话历史。
