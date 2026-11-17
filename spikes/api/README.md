# 换 API：验证脚本（2026-11-12，功能待用户确认方案后再做）

问题：Claudex 能不能只给自己的对话换 API（中转地址 + 令牌），不改 `~/.claude/settings.json`、不影响命令行？
脚本都不打印真实地址和令牌。在仓库根目录运行。

| 脚本 | 做法 | 结果 |
|---|---|---|
| `override.mjs env` | 通过 SDK 的 `env` 选项（子进程环境变量）传假地址 | ❌ 没生效：settings.json 里的 `env` 优先，照样走原来的中转 |
| `override.mjs flag` | 通过 SDK 的 `settings` 选项（命令行级设置）里的 `env` 传假地址 | ✅ 生效：一直在连假地址 |
| `override-control.mjs` | `settings` 选项传真实地址和令牌 | ✅ 6 秒正常回复 |
| `override-token-trace.mjs` | `settings` 选项传真实地址 + 错误令牌，打印所有消息 | ✅ 令牌生效（`authentication_failed`）；但 Claude Code **不会马上报错**，而是按 1、2、3、6、15、25、42 秒……一直重试，每次发一条 `system/api_retry` 消息 |
| `relay-badtoken.mjs` | 直接用错误令牌请求中转 | 中转 2 秒内返回 401 |

结论：
- 可以只换 Claudex 的 API：用 SDK 的 `settings: { env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN } }`
- 不管换不换 API，Claudex 都应该把 `api_retry` 显示出来（令牌失效时现在只会一直转圈），认证失败时停下来明确提示

待用户决定（问到一半会话中断了）：只换 Claudex 还是连命令行一起换；全局一个开关还是每个对话单独选；要支持哪类 API（别的 Claude 中转 / 官方 Key / 其他厂商兼容接口）。
