// 03 读文件 + 改文件 + 续接 + 分叉 + 会话历史接口（M2 要用）。
import fs from 'node:fs';
import path from 'node:path';
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { once, reporter, freshDir, BASE } from './lib.mjs';

const r = reporter('03-edit-resume');
const dir = freshDir('edit');
const file = path.join(dir, 'notes.txt');
fs.writeFileSync(file, 'status: draft\n');
// 这个测试要续接，所以要写会话记录
const opts = { ...BASE, cwd: dir, persistSession: true };

const a = await once(
  "Read notes.txt, then use the Edit tool to change the word 'draft' to 'final'. Reply DONE when finished.",
  { ...opts, permissionMode: 'acceptEdits', maxTurns: 6 }
);
r.cost(a);
const names = a.toolUses.map(t => t.name);
r.check('读了文件（Read）', names.includes('Read'), names);
r.check('改了文件（Edit 或 Write）', names.includes('Edit') || names.includes('Write'), names);
r.check('文件内容确实改了', fs.readFileSync(file, 'utf8').trim() === 'status: final', fs.readFileSync(file, 'utf8').trim());
const sid = a.result?.session_id ?? a.init?.session_id;
r.note('第一轮会话 ID', sid);

const b = await once('Which word did you replace in notes.txt? Reply with just that one word.',
  { ...opts, permissionMode: 'default', resume: sid, maxTurns: 1 });
r.cost(b);
r.check('续接：记得之前做过什么', /draft/i.test(b.result?.result || ''), b.result?.result ?? b.error);
r.note('续接后的会话 ID（是否沿用原 ID）', { same: b.result?.session_id === sid, id: b.result?.session_id });

const c = await once('According to our conversation, what is the word in notes.txt now? Reply with just that one word.',
  { ...opts, permissionMode: 'default', resume: sid, forkSession: true, maxTurns: 1 });
r.cost(c);
r.check('分叉：带着原对话的记忆', /final/i.test(c.result?.result || ''), c.result?.result ?? c.error);
r.check('分叉：得到一个新的会话 ID', c.result?.session_id && c.result.session_id !== sid, c.result?.session_id);

const list = await listSessions({ dir });
const ids = list.map(s => s.sessionId ?? s.session_id);
r.check('listSessions 能列出这个项目的会话', ids.includes(sid), { count: list.length });
r.note('listSessions 每条记录的字段', Object.keys(list[0] || {}));
const hist = await getSessionMessages(sid);
r.check('getSessionMessages 能读出历史消息', hist.length >= 4, { count: hist.length, types: [...new Set(hist.map(m => m.type))] });
r.save();
