// 06b 复查 06 没通过的两项，换更准的验证方法：
//   1. 会话选项 skills：看系统提示变小没有，并让 Claude 自己列出能用的 Skills；
//   2. 项目级 MCP：轮询状态等连接完成，对比“批准 / 没批准”，再试没批准时能不能调用。
import path from 'node:path';
import { once, session, reporter, BASE, SANDBOX, sleep } from './lib.mjs';

const r = reporter('06b-skills-mcp-recheck');
const baseDir = path.join(SANDBOX, 'skills-base');
const mcpDir = path.join(SANDBOX, 'mcp'); // 06 已经在这里写好了 .mcp.json 和回声服务器

// 1. skills 选项
const ask = 'Without using any tools, list the names of every skill you can invoke with the Skill tool, one per line, nothing else.';
const all = await once(ask, { ...BASE, cwd: baseDir, permissionMode: 'default', maxTurns: 1 });
const two = await once(ask, { ...BASE, cwd: baseDir, permissionMode: 'default', maxTurns: 1, skills: ['arxiv', 'research-lit'] });
r.cost(all); r.cost(two);
const promptSize = x => (x.result?.usage?.cache_creation_input_tokens || 0) + (x.result?.usage?.cache_read_input_tokens || 0) + (x.result?.usage?.input_tokens || 0);
const lines = x => x.text.split('\n').map(s => s.trim()).filter(Boolean);
r.note('系统提示大小（token）', { 不限定: promptSize(all), 只开两个: promptSize(two) });
r.note('只开两个时 Claude 说它能用的 Skills', lines(two));
r.check('skills 选项让系统提示明显变小', promptSize(two) < promptSize(all) * 0.8, { all: promptSize(all), two: promptSize(two) });
r.check('skills 选项下 Claude 只看得到指定的 Skills', lines(two).length <= 3 && lines(two).some(l => /arxiv/.test(l)), lines(two));

// 2. 项目级 MCP 的状态
async function settle(opts) {
  const s = session({ ...BASE, cwd: mcpDir, permissionMode: 'default', ...opts });
  const seen = [];
  try {
    await s.q.initializationResult();
    for (let i = 0; i < 15; i++) {
      const st = (await s.q.mcpServerStatus()).find(x => x.name === 'lumen-echo');
      seen.push(st?.status ?? '(没有)');
      if (st && st.status !== 'pending') break;
      await sleep(1000);
    }
  } finally {
    await s.close();
  }
  return seen;
}
const noApprove = await settle({});
const approved = await settle({ settings: { enabledMcpjsonServers: ['lumen-echo'] } });
r.note('没批准：状态变化', noApprove);
r.note('批准后：状态变化', approved);
r.check('批准后项目 MCP 最终能连上', approved[approved.length - 1] === 'connected', approved);

const call = await once("Call the echo tool from the lumen-echo MCP server with text 'no-approval', then reply with exactly what it returned.", {
  ...BASE, cwd: mcpDir, permissionMode: 'default', maxTurns: 4,
  canUseTool: async (name, input) => ({ behavior: 'allow', updatedInput: input })
});
r.cost(call);
r.note('没批准时 Claude 能不能调用', { tools: call.toolUses.map(t => t.name), results: call.toolResults.map(t => t.text).join(' | ').slice(0, 150) });
r.save();
