// 08 挂起与恢复（自动化无人值守时要用）：
//   a. 审批回调晚 45 秒才回答，会话会不会一直等着；
//   b. 等审批时把会话关掉（模拟 App 退出），之后续接能不能把事做完。
import fs from 'node:fs';
import path from 'node:path';
import { once, session, reporter, freshDir, BASE, sleep } from './lib.mjs';

const r = reporter('08-suspend');

// a. 慢审批
const dirA = freshDir('suspend-slow');
let askedAt = 0;
const t0 = Date.now();
const a = await once('Use the Bash tool to run exactly: echo waited > w.txt\nReply OK when done.', {
  ...BASE, cwd: dirA, permissionMode: 'default', maxTurns: 4,
  canUseTool: async (name, input) => {
    askedAt = Date.now();
    await sleep(45000); // 模拟用户 45 秒后才点“允许”
    return { behavior: 'allow', updatedInput: input };
  }
}, 240000);
r.cost(a);
r.check('审批晚 45 秒回答，会话一直等着并完成', a.result && !a.result.is_error && fs.existsSync(path.join(dirA, 'w.txt')), { result: a.result?.subtype ?? a.error, waitedMs: askedAt ? Date.now() - askedAt : null, totalMs: Date.now() - t0 });

// b. 等审批时关掉会话，再续接
const dirB = freshDir('suspend-kill');
let sid = null;
let resolveAsked;
const asked = new Promise(res => { resolveAsked = res; });
const s = session({
  ...BASE, cwd: dirB, persistSession: true, permissionMode: 'default', maxTurns: 6,
  canUseTool: async () => { resolveAsked(); return new Promise(() => {}); } // 永远不回答
});
const turn = s.turn('Use the Bash tool to run exactly: echo resumed > r.txt\nReply OK when done.').catch(() => null);
await Promise.race([asked, sleep(120000)]);
sid = s.st.init?.session_id;
r.check('等审批时拿到了会话 ID', !!sid, sid);
await s.close(); // 模拟 App 退出
await turn;
r.check('关掉时命令还没执行', !fs.existsSync(path.join(dirB, 'r.txt')));

const b = await once('The app was restarted while you were waiting for approval. Continue the task you were doing.', {
  ...BASE, cwd: dirB, persistSession: true, resume: sid, permissionMode: 'default', maxTurns: 6,
  canUseTool: async (name, input) => ({ behavior: 'allow', updatedInput: input })
});
r.cost(b);
r.check('续接后把事做完了', b.result && !b.result.is_error && fs.existsSync(path.join(dirB, 'r.txt')), { result: b.result?.subtype ?? b.error, reply: b.text.slice(0, 150) });
r.save();
