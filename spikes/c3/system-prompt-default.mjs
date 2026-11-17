// 验证：SDK 不传 systemPrompt 时，Claude 拿到的是空的系统提示，还是 Claude Code 的默认提示？
// 不给工具，问它工作目录（Claude Code 的默认提示里有“工作目录”这一节）。
// 运行：node spikes/c3/system-prompt-default.mjs（用 Haiku）
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-sp-'));
const ask = async (label, extra) => {
  let text = '';
  const q = query({
    prompt: 'Without using any tools: what is the current working directory and the operating system platform, according to the information you were given? If you were not told, reply exactly UNKNOWN.',
    options: { cwd: dir, model: 'haiku', tools: [], maxTurns: 1, persistSession: false, permissionMode: 'default', ...extra }
  });
  let tokens = 0;
  for await (const m of q) {
    if (m.type !== 'result') continue;
    text = m.subtype === 'success' ? m.result : m.subtype;
    const u = m.usage ?? {};
    tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  }
  console.log(`${label}：输入 ${tokens} tokens；${text.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
};
await ask('不传 systemPrompt', {});
await ask('preset claude_code', { systemPrompt: { type: 'preset', preset: 'claude_code' } });
console.log(`（实际目录：${dir}）`);
fs.rmSync(dir, { recursive: true, force: true });
