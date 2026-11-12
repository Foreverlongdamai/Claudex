# C1 内置终端：验证脚本

做 C1 时遇到的 node-pty / ConPTY / Git Bash 问题，每个结论都有一个能重跑的脚本。结论汇总在 PROJECT_STATUS.md 第 5 节「C1 进度」。

运行：`node spikes/c1/<脚本> [参数]`（在仓库根目录）。脚本里 Git Bash 的路径写死成 `D:/git/Git/bin/bash.exe`，换机器要改。
除了 `electron-workers.mjs`（启动真正的 App），其他都直接用 node-pty，不启动 App。

| 脚本 | 验证什么 | 结论 |
|---|---|---|
| `tree.mjs`、`tree2.mjs` | Git Bash 里启动的程序在 Windows 进程树里的位置，`taskkill /T` 能不能结束 | 直接运行的原生程序能；msys 程序（如 `sleep`）和经 winpty 启动的（Git Bash 默认把 `node` 等包一层 winpty）和 shell 断开，结束不了 → 用 `CLAUDEX_TERM_ID` 环境变量从 msys 的 `/proc` 找 |
| `crash.mjs` | 几个终端同时退出 | node-pty 1.1.0 约一半概率段错误（原生代码多线程改同一个列表没加锁）；1.2.0-beta.18 加了锁，没再出现 → 升级 |
| `conhost.mjs` | 终端退出后 ConPTY 的 conhost.exe 会不会留下 | 会，自己退出、被结束都会留下，直到进程退出 → `reapConsoleHost` 按 spawn 时间窗认出来结束 |
| `close-dll.mjs` | node-pty 自带的新版 ConPTY（`useConptyDll`）会不会留下控制台进程 | 不会 |
| `typeahead.mjs` | 上一条命令没跑完就接着打字，两种 ConPTY 下会不会错位 | 新版约 1/8 错位，系统版 0/40 → 还是用系统版 |
| `resize-eats-key.mjs` | shell 等输入时改终端大小，下一个按键会不会丢 | Git Bash 约 1/5 丢，PowerShell 不丢、不改大小也不丢 → 按面板实际大小启动终端，大小没变不发，拖动时停下来再发 |
| `worker-leak.mjs`（新版 ConPTY）、`ports.mjs`（系统版） | 终端退出后 node-pty 读输出的 worker 线程会不会留下 | 会（还有输入管道）→ `releasePty` 手动释放 |
| `electron-workers.mjs` | 在 App 里反复“自然退出 → 重启”，worker 数是否稳定 | 稳定（每轮重启后 1 个，退出后 0 个） |
