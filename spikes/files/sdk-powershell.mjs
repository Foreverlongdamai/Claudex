// 验证 settings.json 里的 PowerShell(doc2md:*) 这类规则对 PowerShell 工具生效：
// “默认：询问”模式下，指定用 PowerShell 工具跑 doc2md、audio-transcribe，看 canUseTool 会不会被叫到（叫到 = 要弹审批）
// 用法：node spikes/files/sdk-powershell.mjs
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proj = path.join(here, 'proj');
fs.mkdirSync(proj, { recursive: true });
const docx = path.join(here, 'samples', '周报.docx');
const wav = path.join(here, 'sample-zh.wav');
const prompt = `Use the PowerShell tool (NOT the Bash tool) to run these two commands, one call each, exactly as written:
1. doc2md "${docx}"
2. audio-transcribe --probe "${wav}"
Then reply with the marker word from the document (like 青松-DOCX-7731) and the duration from the second command.`;

const asked = [];
const used = [];
for await (const m of query({
  prompt,
  options: {
    cwd: proj, model: 'opus', permissionMode: 'default',
    env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\Git\\bin\\bash.exe' },
    canUseTool: async (toolName, input) => { asked.push(`${toolName}: ${JSON.stringify(input).slice(0, 140)}`); return { behavior: 'allow', updatedInput: input }; }
  }
})) {
  if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') used.push(`${b.name}: ${JSON.stringify(b.input).slice(0, 120)}`);
  if (m.type === 'result') console.log('回复：', String(m.result).slice(0, 200));
}
console.log('用到的工具：\n  ' + used.join('\n  '));
console.log(`弹审批 ${asked.length} 次${asked.length ? '：\n  ' + asked.join('\n  ') : ''}`);
