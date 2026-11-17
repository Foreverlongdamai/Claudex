// 确认 settings 选项里的令牌真的被用上：真实中转地址 + 错误令牌，应该很快报认证错误
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const real = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {};
const ac = new AbortController();
setTimeout(() => ac.abort(), 60000);
const t0 = Date.now();
let verdict = '没有结果';
try {
  for await (const m of query({ prompt: 'Reply with exactly: OK', options: { model: 'claude-haiku-5-5', maxTurns: 1, permissionMode: 'default', abortController: ac,
    env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: 'D:\git\Git\bin\bash.exe' },
    settings: { env: { ANTHROPIC_BASE_URL: real.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: 'sk-wrong-token-for-test' } } } })) {
    console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', m.type, m.subtype ?? '', JSON.stringify(m.error ?? m.message?.content?.[0]?.text ?? m.result ?? '').slice(0, 140));
    if (m.type === 'result') verdict = m.is_error || m.subtype !== 'success' ? `失败（令牌生效）：${String(m.result ?? m.subtype).slice(0, 100)}` : `成功（令牌没生效）`;
  }
} catch (e) { verdict = `抛错：${String(e?.message || e).slice(0, 100)}`; }
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${verdict}`);
