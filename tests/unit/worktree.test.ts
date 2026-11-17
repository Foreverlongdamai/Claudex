// C3 worktree（src/main/worktree.ts）：在临时仓库里实际跑一遍创建、接手到本地、删除。
// 运行：npm run test:unit
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as wt from '../../src/main/worktree.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function suite(autocrlf: 'false' | 'true') {
  const tag = `[autocrlf=${autocrlf}] `;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-wt-'));
  const repo = path.join(tmp, 'proj');
  const w = (dir: string, f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  const r = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
  try {
    fs.mkdirSync(repo);
    check(tag + '不是仓库：不能开 worktree', (await wt.worktreeCheck(repo)) !== null);
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.name', 't');
    sh(repo, 'config', 'user.email', 't@example.invalid');
    sh(repo, 'config', 'core.autocrlf', autocrlf);
    check(tag + '还没有提交：不能开 worktree', ((await wt.worktreeCheck(repo)) ?? '').includes('提交'));
    w(repo, 'a.txt', 'one\ntwo\nthree\n');
    w(repo, 'shared.txt', 'line 1\nline 2\nline 3\n');
    w(repo, 'pkg/app/main.py', 'print("hi")\n');
    fs.writeFileSync(path.join(repo, 'gbk.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a])); // GBK 编码的“你好”
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'init');
    check(tag + '可以开 worktree', (await wt.worktreeCheck(repo)) === null);

    // ---- 创建 ----
    w(repo, 'local-only.txt', '本地没提交的改动\n');
    const a = await wt.createWorktree(repo, new Date(2026, 10, 17, 15, 30));
    check(tag + 'worktree 放在项目旁边的统一文件夹', a.path === path.join(tmp, '.claudex-worktrees', 'proj', '1117-1530') && a.cwd === a.path, a);
    check(tag + '分支名 claudex/<名字>', a.branch === 'claudex/1117-1530' && sh(a.path, 'rev-parse', '--abbrev-ref', 'HEAD') === a.branch, a.branch);
    check(tag + '从本地最新的提交开始', a.base === sh(repo, 'rev-parse', 'HEAD') && a.baseBranch === 'main');
    check(tag + '本地没提交的改动不带过去', !fs.existsSync(path.join(a.path, 'local-only.txt')));
    const b = await wt.createWorktree(repo, new Date(2026, 10, 17, 15, 30));
    check(tag + '同一分钟再开一个：名字不重复', b.branch === 'claudex/1117-1530-2', b.branch);
    const sub = await wt.createWorktree(path.join(repo, 'pkg', 'app'), new Date(2026, 10, 17, 16, 0));
    check(tag + '项目是仓库里的子目录：工作目录是 worktree 里对应的子目录', sub.cwd === path.join(sub.path, 'pkg', 'app') && fs.existsSync(path.join(sub.cwd, 'main.py')), sub);

    // ---- 在 worktree 里干活：提交一次，再改一些不提交，再加新文件 ----
    w(a.path, 'a.txt', 'one\nTWO\nthree\n');
    sh(a.path, 'add', '-A');
    sh(a.path, 'commit', '-q', '-m', 'worktree 里的提交');
    w(a.path, 'shared.txt', 'line 1\nline 2 from worktree\nline 3\n');
    w(a.path, 'new/feature.md', '# 新功能\n');
    fs.rmSync(path.join(a.path, 'pkg', 'app', 'main.py'));
    fs.writeFileSync(path.join(a.path, 'gbk.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xd4, 0xd9, 0xbc, 0xfb, 0x0a])); // 你好\n再见\n
    const bin = Buffer.from([0, 1, 2, 3, 255, 254]);
    fs.writeFileSync(path.join(a.path, 'img.bin'), bin);

    // ---- 接手到本地 ----
    const h = await wt.handoff(repo, a);
    check(tag + '接手：搬过来的文件数', h.files === 6 && h.conflicts.length === 0, h);
    check(tag + '接手：worktree 里提交过的改动', r(repo, 'a.txt') === 'one\nTWO\nthree\n');
    check(tag + '接手：没提交的修改', r(repo, 'shared.txt') === 'line 1\nline 2 from worktree\nline 3\n');
    check(tag + '接手：新文件、删除的文件', r(repo, 'new/feature.md') === '# 新功能\n' && !fs.existsSync(path.join(repo, 'pkg', 'app', 'main.py')));
    // autocrlf=true 时换行按设置变成 CRLF，中文字节要原样保留
    const gbk = Buffer.from([...fs.readFileSync(path.join(repo, 'gbk.txt'))].filter(x => x !== 0x0d));
    check(tag + '接手：GBK 文件的字节原样搬过来', gbk.equals(Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xd4, 0xd9, 0xbc, 0xfb, 0x0a])), [...fs.readFileSync(path.join(repo, 'gbk.txt'))]);
    check(tag + '接手：二进制文件', fs.readFileSync(path.join(repo, 'img.bin')).equals(bin));
    check(tag + '接手：本地自己的改动还在', r(repo, 'local-only.txt') === '本地没提交的改动\n');
    check(tag + '接手：都是未提交、未暂存的改动，本地分支没动', sh(repo, 'diff', '--cached', '--name-only') === '' && sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main' && sh(repo, 'rev-parse', 'HEAD') === a.base);
    check(tag + '接手：worktree 删掉了', !fs.existsSync(a.path) && !sh(repo, 'worktree', 'list').includes('1117-1530 '));
    const saved = sh(repo, 'show', '--name-only', '--format=%s', a.branch);
    check(tag + '接手：分支上存着接手时的全部改动', saved.startsWith('Claudex：接手到本地') && saved.includes('shared.txt') && saved.includes('new/feature.md'), saved);
    check(tag + '接手：分支上的存档提交接在 worktree 的提交后面', sh(repo, 'log', '--format=%s', '-2', a.branch).split('\n')[1] === 'worktree 里的提交');

    // ---- 接手时本地同一行也改过：冲突 ----
    w(b.path, 'a.txt', 'one\nworktree b\nthree\n');
    const bh = await wt.handoff(repo, b);
    check(tag + '冲突：报出冲突的文件', bh.conflicts.length === 1 && bh.conflicts[0] === 'a.txt', bh);
    check(tag + '冲突：文件里有冲突标记', /<<<<<<<[\s\S]*worktree b[\s\S]*>>>>>>>/.test(r(repo, 'a.txt')), r(repo, 'a.txt'));
    check(tag + '冲突：worktree 照样删掉', !fs.existsSync(b.path));
    const bSaved = sh(repo, 'show', `${b.branch}:a.txt`).replace(/\r\n/g, '\n');
    check(tag + '冲突：改动存在分支上', bSaved === 'one\nworktree b\nthree', bSaved);

    // ---- 删除对话：改动存到分支上，删掉 worktree ----
    w(sub.cwd, 'main.py', 'print("changed in sub")\n');
    await wt.discard(path.join(repo, 'pkg', 'app'), sub);
    check(tag + '删除：worktree 删掉了', !fs.existsSync(sub.path));
    const subSaved = sh(repo, 'show', `${sub.branch}:pkg/app/main.py`);
    check(tag + '删除：改动存在分支上', subSaved === 'print("changed in sub")', subSaved);
    check(tag + '删除：worktree 文件夹空了就一起删掉', !fs.existsSync(path.join(tmp, '.claudex-worktrees')));
    check(tag + '删除：worktree 已经不在了也不报错', (await wt.discard(repo, sub)) === null);

    // ---- 文件夹被占着（刚关掉的进程还没退出）：等它退出再删 ----
    const c = await wt.createWorktree(repo, new Date(2026, 10, 17, 17, 0));
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { cwd: c.path, stdio: 'ignore' });
    const t0 = Date.now();
    const left = await wt.discard(repo, c);
    check(tag + '被占着：等进程退出后删干净', left === null && !fs.existsSync(c.path), { left, ms: Date.now() - t0 });
    check(tag + '被占着：git 里也没有这个 worktree 的记录了', !sh(repo, 'worktree', 'list').includes('1117-1700'));
    holder.kill();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await suite('false');
await suite('true');
console.log(`--- worktree：${total - failed}/${total} 通过`);
if (failed) process.exit(1);
