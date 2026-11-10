// 07 并行 + worktree：3 个会话同时改同一个项目的 3 个工作区，互不干扰；顺便测内存占用。
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { once, reporter, freshDir, BASE, sleep } from './lib.mjs';

const r = reporter('07-parallel');
const root = freshDir('parallel');
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
git(['init', '-b', 'main']);
fs.writeFileSync(path.join(repo, 'app.txt'), 'base\n');
git(['add', '.']);
git(['-c', 'user.name=lumen-m0', '-c', 'user.email=m0@example.invalid', 'commit', '-m', 'init']);
const wt1 = path.join(root, 'wt1');
const wt2 = path.join(root, 'wt2');
git(['worktree', 'add', wt1, '-b', 'task-1']);
git(['worktree', 'add', wt2, '-b', 'task-2']);

// 每秒采样一次本进程下所有 claude.exe 子进程的内存
let peak = { count: 0, mb: 0 };
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    await new Promise(res => execFile('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object Name -eq 'claude.exe' | Measure-Object -Property WorkingSetSize -Sum | ForEach-Object { "$($_.Count) $($_.Sum)" }`],
    (err, stdout) => {
      const [n, bytes] = String(stdout || '0 0').trim().split(/\s+/).map(Number);
      if (n && bytes / 1048576 > peak.mb) peak = { count: n, mb: Math.round(bytes / 1048576) };
      res();
    }));
    await sleep(1000);
  }
})();

const task = (cwd, id, extra = {}) => once(
  `Use the Edit tool to append a new line containing exactly '${id}' to app.txt (keep the existing line). Reply DONE.`,
  { ...BASE, cwd, permissionMode: 'acceptEdits', maxTurns: 6, ...extra }
);
const t0 = Date.now();
const results = await Promise.all([
  task(repo, 'main-line'),
  task(wt1, 'task-1-line', { projectConfigRoot: repo }),
  task(wt2, 'task-2-line', { projectConfigRoot: repo })
]);
const wall = Date.now() - t0;
sampling = false;
await sampler;
results.forEach(x => r.cost(x));

const read = d => fs.readFileSync(path.join(d, 'app.txt'), 'utf8').trim().split(/\r?\n/);
r.check('3 个会话都成功', results.every(x => x.result && !x.result.is_error), results.map(x => x.result?.subtype ?? x.error));
r.check('主目录只多了自己的一行', JSON.stringify(read(repo)) === JSON.stringify(['base', 'main-line']), read(repo));
r.check('worktree 1 只多了自己的一行', JSON.stringify(read(wt1)) === JSON.stringify(['base', 'task-1-line']), read(wt1));
r.check('worktree 2 只多了自己的一行', JSON.stringify(read(wt2)) === JSON.stringify(['base', 'task-2-line']), read(wt2));
r.check('worktree 会话的工作目录是 worktree 本身', results[1].init?.cwd?.toLowerCase() === wt1.toLowerCase(), results[1].init?.cwd);
r.note('并行总耗时 ms', wall);
r.note('各会话单独耗时 ms', results.map(x => x.elapsed));
r.note('并行时 claude.exe 内存峰值', { 进程数: peak.count, 合计MB: peak.mb, 平均每个MB: peak.count ? Math.round(peak.mb / peak.count) : null });
r.save();
