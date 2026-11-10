// 06 Skills 和 MCP：按会话限定 Skills、项目设置关闭 Skills、项目级 MCP、结构化输出（推荐清单要用）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once, session, reporter, freshDir, BASE, INSTALLED_CLI, userSettingsEnv } from './lib.mjs';

const r = reporter('06-skills-mcp');
const commandNames = async opts => {
  const s = session({ ...BASE, permissionMode: 'default', ...opts });
  try { return (await s.q.supportedCommands()).map(c => c.name); } finally { await s.close(); }
};

// 1. 基线：这台机器上能看到的命令和 Skills
const baseDir = freshDir('skills-base');
const base = await commandNames({ cwd: baseDir });
r.note('基线命令数', base.length);
const offTargets = base.filter(n => /pptx|docx|vue-expert/.test(n)).slice(0, 4);
r.note('准备在项目里关闭的', offTargets);

// 2. 项目设置 skillOverrides 关闭几个 Skills
const projDir = freshDir('skills-proj');
fs.mkdirSync(path.join(projDir, '.claude'));
fs.writeFileSync(path.join(projDir, '.claude', 'settings.json'),
  JSON.stringify({ skillOverrides: Object.fromEntries(offTargets.map(n => [n, 'off'])) }, null, 2));
const proj = await commandNames({ cwd: projDir });
r.check('项目设置 skillOverrides 关掉的 Skills 不再出现', offTargets.length > 0 && offTargets.every(n => !proj.includes(n)), { before: base.length, after: proj.length, stillThere: offTargets.filter(n => proj.includes(n)) });

// 3. 会话选项 skills：只开两个（用一次最便宜的请求看 init 里的 skills）
const pick = base.filter(n => /research-lit|arxiv/.test(n)).slice(0, 2);
const only = await once('Reply with exactly: ok', { ...BASE, cwd: baseDir, permissionMode: 'default', maxTurns: 1, skills: pick });
r.cost(only);
r.check('会话选项 skills 只留下指定的 Skills', only.init && only.init.skills.every(n => pick.some(p => n.endsWith(p))), { pick, initSkills: only.init?.skills });

// 4. 项目级 MCP：用 claude mcp add --scope project 加一个本地回声服务器
const mcpDir = freshDir('mcp');
const server = path.join(mcpDir, 'echo-mcp.mjs');
fs.writeFileSync(server, `import readline from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'lumen-echo', version: '0.0.1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo back the given text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo: ' + (m.params?.arguments?.text ?? '') }] } });
  else if (m.method === 'ping') send({ jsonrpc: '2.0', id: m.id, result: {} });
  else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
});
`);
let addOut = '';
try {
  addOut = execFileSync(INSTALLED_CLI, ['mcp', 'add', '--scope', 'project', 'lumen-echo', '--', 'node', server], { cwd: mcpDir, encoding: 'utf8' });
} catch (e) { addOut = String(e.stdout || e.message); }
r.check('claude mcp add --scope project 写出了 .mcp.json', fs.existsSync(path.join(mcpDir, '.mcp.json')), addOut.trim().slice(0, 200));

const status = async opts => {
  const s = session({ ...BASE, cwd: mcpDir, permissionMode: 'default', ...opts });
  try { return (await s.q.mcpServerStatus()).find(x => x.name === 'lumen-echo') ?? null; } finally { await s.close(); }
};
const st1 = await status({});
r.note('没批准时项目 MCP 的状态', st1 ? { status: st1.status, source: st1.source } : '(列表里没有)');
const approve = { settings: { enabledMcpjsonServers: ['lumen-echo'] } };
const st2 = await status(approve);
r.check('批准后（enabledMcpjsonServers）项目 MCP 能连上', st2?.status === 'connected', st2 ? { status: st2.status, error: st2.error } : '(列表里没有)');

const call = await once("Call the echo tool from the lumen-echo MCP server with text 'hi-from-m0', then reply with exactly what it returned.", {
  ...BASE, cwd: mcpDir, permissionMode: 'default', maxTurns: 4, ...approve,
  canUseTool: async (name, input) => ({ behavior: 'allow', updatedInput: input })
});
r.cost(call);
r.check('Claude 能调用项目 MCP 的工具', call.toolUses.some(t => t.name === 'mcp__lumen-echo__echo'), call.toolUses.map(t => t.name));
r.check('工具结果正确', call.toolResults.some(t => t.text.includes('echo: hi-from-m0')), call.toolResults.map(t => t.text).join(' | ').slice(0, 200));

// 5. 结构化输出：Skills 配置模式的推荐清单要靠它
const schema = {
  type: 'object',
  properties: {
    recommended: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name', 'reason'], additionalProperties: false }
    }
  },
  required: ['recommended'],
  additionalProperties: false
};
const so = await once(
  'A project writes a LaTeX paper and searches arXiv. From this list pick the 2 most relevant skills: paper-write, pptx, arxiv, vue-expert. Give a short reason for each.',
  { ...BASE, cwd: baseDir, settingSources: [], env: { ...process.env, ...userSettingsEnv() }, tools: [], permissionMode: 'default', maxTurns: 3, outputFormat: { type: 'json_schema', schema } }
);
r.cost(so);
const out = so.result?.structured_output;
r.check('结构化输出：result 里有 structured_output', !!out, out ?? so.result?.result ?? so.error);
r.check('结构化输出：内容符合格式', Array.isArray(out?.recommended) && out.recommended.length === 2 && out.recommended.every(x => x.name && x.reason), out);
r.save();
