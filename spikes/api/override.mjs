// Claudex 能不能只给自己的对话换 API（不改 ~/.claude/settings.json）？
// 用一个连不上的假地址：请求失败 = 覆盖生效；正常回复 = 还在用 settings.json 里的中转。
// 用法：node spikes/api/override.mjs <env|flag|both>
//   env  ：通过 SDK 的 env 选项（子进程环境变量）传 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
//   flag ：通过 SDK 的 settings 选项（命令行级设置）里的 env 传
import { query } from '@anthropic-ai/claude-agent-sdk';
const how = process.argv[2] || 'env';
const FAKE = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'fake-token-for-test' };
const options = {
  model: 'claude-haiku-5-5',
  maxTurns: 1,
  permissionMode: 'default',
  env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\Git\\bin\\bash.exe', ...(how !== 'flag' ? FAKE : {}) },
  ...(how !== 'env' ? { settings: { env: FAKE } } : {})
};
const t0 = Date.now();
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 60000);
let verdict = '没有结果';
try {
  for await (const m of query({ prompt: 'Reply with exactly: OK', options: { ...options, abortController: ac } })) {
    if (m.type === 'result') {
      verdict = m.subtype === 'success' && !m.is_error ? `正常回复 → 覆盖没生效（还在用 settings.json 的中转）：${String(m.result).slice(0, 40)}` : `请求失败 → 覆盖生效：${String(m.result ?? m.subtype).slice(0, 120)}`;
    }
  }
} catch (e) {
  verdict = `抛错 → 覆盖生效：${String(e?.message || e).slice(0, 120)}`;
}
clearTimeout(timer);
console.log(`${how.padEnd(5)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${verdict}`);
