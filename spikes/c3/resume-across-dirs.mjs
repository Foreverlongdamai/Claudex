// C3 验证：在 worktree 里开始的对话，接手（删掉 worktree）以后能不能换到本地目录接着聊？
// 1. cwd = worktree 开一个会话，让 Claude 记住一个词
// 2. cwd = 本地项目目录，resume 同一个会话 ID，问它记住的词（worktree 还在）
// 3. 删掉 worktree，再用本地目录 resume
// 4. 对照：forkSession 到本地目录以后 resume
// 运行：node spikes/c3/resume-across-dirs.mjs（在仓库根目录；用 Haiku，花费很少）
import { forkSession, getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-c3-'));
const repo = path.join(tmp, 'proj');
const wt = path.join(tmp, '.claudex-worktrees', 'proj', 'try-1');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
fs.mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
git(repo, 'add', '-A');
git(repo, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'init');
git(repo, 'worktree', 'add', '-q', '-b', 'claudex/try-1', wt);

async function ask(prompt, opts) {
  let sid = null;
  let text = '';
  const q = query({ prompt, options: { model: 'haiku', tools: [], maxTurns: 1, permissionMode: 'default', ...opts } });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') sid = m.session_id;
    if (m.type === 'result') text = m.subtype === 'success' ? m.result : `【出错】${m.subtype} ${(m.errors ?? []).join(';')}`;
  }
  return { sid, text: text.trim() };
}

const results = {};
try {
  const first = await ask('Remember this code word: ZEBRA-42. Reply only with OK.', { cwd: wt });
  results['1 worktree 里开始'] = first;
  const msgsWt = await getSessionMessages(first.sid, { dir: wt });
  results['  会话记录（按 worktree 目录找）条数'] = msgsWt.length;
  const msgsLocal = await getSessionMessages(first.sid, { dir: repo });
  results['  会话记录（按本地目录找）条数'] = msgsLocal.length;
  const msgsAny = await getSessionMessages(first.sid);
  results['  会话记录（不给目录，全部搜）条数'] = msgsAny.length;

  const second = await ask('What code word did I ask you to remember? Reply with just the word.', { cwd: repo, resume: first.sid });
  results['2 worktree 还在，用本地目录续接'] = second;

  git(repo, 'worktree', 'remove', '--force', wt);
  const third = await ask('What code word did I ask you to remember? Reply with just the word.', { cwd: repo, resume: first.sid });
  results['3 worktree 删了，用本地目录续接'] = third;

  const forked = await forkSession(first.sid, { dir: wt });
  results['4 forkSession 结果'] = forked;
  const fourth = await ask('What code word did I ask you to remember? Reply with just the word.', { cwd: repo, resume: forked.sessionId });
  results['4 fork 之后用本地目录续接'] = fourth;
} catch (e) {
  results['出错'] = String(e?.stack || e);
} finally {
  console.log(JSON.stringify(results, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
}
