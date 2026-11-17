// 端到端验证：像 Claudex 一样起一个“默认：询问”模式的会话，把项目外的 Word、Excel、老格式 PPT、录音交给 Claude，
// 看它是不是按全局规则读、哪些操作还会弹审批、读出来的内容对不对。
// 用法：node spikes/files/sdk-read.mjs
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proj = path.join(here, 'proj');
fs.mkdirSync(proj, { recursive: true });
const files = ['samples/周报.docx', 'samples/周报.pdf', 'samples/销量.xlsx', 'samples/汇报.ppt', 'sample-zh.wav'].map(f => path.join(here, f));
const prompt = `<claudex-attachments>
用户附加了这些本地文件（完整路径）：
${files.map(f => `- ${f}`).join('\n')}
</claudex-attachments>
逐个读这些文件。每个文件回答一行：文件名 + 里面的“标记词”（形如 青松-DOCX-7731，没有就写“无”）。最后一行用一句话说录音里讨论了哪三件事。`;

const asked = [];
const t0 = Date.now();
const ac = new AbortController();
setTimeout(() => ac.abort(), 8 * 60 * 1000);
let init, result;
for await (const m of query({
  prompt,
  options: {
    cwd: proj, model: 'opus', permissionMode: 'default', abortController: ac,
    env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\Git\\bin\\bash.exe' },
    canUseTool: async (toolName, input) => {
      asked.push(`${toolName}: ${JSON.stringify(input).slice(0, 160)}`);
      return { behavior: 'allow', updatedInput: input };
    }
  }
})) {
  if (m.type === 'system' && m.subtype === 'init') init = m;
  if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${b.name}: ${JSON.stringify(b.input).slice(0, 150)}`);
  if (m.type === 'result') result = m;
}
console.log('\n加载了 audio-transcribe skill：', !!init?.skills?.includes?.('audio-transcribe') || JSON.stringify(init?.skills ?? []).includes('audio-transcribe'));
console.log(`弹审批 ${asked.length} 次：`);
for (const a of asked) console.log('  ' + a);
console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(0)}s，花费 $${result?.total_cost_usd?.toFixed(3)}\n回复：\n${result?.result}`);
