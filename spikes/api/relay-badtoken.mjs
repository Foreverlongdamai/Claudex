// 中转服务收到错误令牌时返回什么（不打印真实地址和令牌）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const base = (JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {}).ANTHROPIC_BASE_URL.replace(/\/$/, '');
const t0 = Date.now();
const ac = new AbortController();
setTimeout(() => ac.abort(), 30000);
try {
  const r = await fetch(`${base}/v1/messages`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer sk-wrong-token-for-test', 'x-api-key': 'sk-wrong-token-for-test' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });
  console.log(`${Date.now() - t0}ms status=${r.status} body=${(await r.text()).slice(0, 160)}`);
} catch (e) { console.log(`${Date.now() - t0}ms error=${e.message}`); }
