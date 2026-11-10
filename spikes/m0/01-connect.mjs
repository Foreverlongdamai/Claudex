// 01 连通：经中转 API 跑通一次请求；看会话启动时加载了什么；对比 SDK 内置和本机已装的 Claude Code。
import { once, reporter, freshDir, BASE, INSTALLED_CLI } from './lib.mjs';

const r = reporter('01-connect');
const dir = freshDir('connect');
const ask = 'Reply with exactly the word: pong';

// A. 显式传 permissionMode: 'default'（App 的做法）
const a = await once(ask, { ...BASE, cwd: dir, permissionMode: 'default', maxTurns: 1 });
r.cost(a);
r.check('经中转 API 拿到回复', a.result && !a.result.is_error && /pong/i.test(a.result.result), a.result?.result?.slice(0, 80) ?? a.error);
r.check('显式传 default 时会话是默认模式（不受全局 bypass 影响）', a.init?.permissionMode === 'default', a.init?.permissionMode);
r.note('SDK 内置 Claude Code 版本', a.init?.claude_code_version);
r.note('实际模型', a.init?.model);
r.note('凭据来源 apiKeySource', a.init?.apiKeySource);
r.note('内置工具', a.init?.tools?.filter(t => !t.startsWith('mcp__')));
r.note('Skills 数', a.init?.skills?.length);
r.note('斜杠命令数', a.init?.slash_commands?.length);
r.note('插件', a.init?.plugins?.map(p => p.name));
r.note('插件加载错误', a.init?.plugin_errors ?? []);
r.note('MCP 服务器', a.init?.mcp_servers);
r.note('快速模式状态', { state: a.init?.fast_mode_state ?? '(未提供)', reason: a.init?.fast_mode_disabled_reason });
r.note('思考强度 effort', a.init?.effort ?? '(未提供)');
r.note('capabilities', a.init?.capabilities);
r.note('启动到收到 init 的耗时 ms', a.tInit);
r.note('总耗时 ms', a.elapsed);
r.note('首字耗时 ttft_ms', a.result?.ttft_ms);
r.note('usage', a.result?.usage);
if (a.error) r.note('错误输出', { error: a.error, stderr: a.stderr });

// B. 不传 permissionMode：看会不会继承全局设置里的 bypass
const b = await once(ask, { ...BASE, cwd: dir, maxTurns: 1 });
r.cost(b);
r.note('不传 permissionMode 时的会话模式', b.init?.permissionMode ?? b.error);

// C. 改用本机已装的 Claude Code
const c = await once(ask, { ...BASE, cwd: dir, permissionMode: 'default', maxTurns: 1, pathToClaudeCodeExecutable: INSTALLED_CLI });
r.cost(c);
r.check('可以改用本机已装的 Claude Code', c.result && !c.result.is_error, c.init?.claude_code_version ?? c.error);
r.note('已装 Claude Code：启动到 init 耗时 ms', c.tInit);

r.save();
