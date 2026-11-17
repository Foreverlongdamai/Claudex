// 改动面板的 git 操作（src/main/git.ts）：在临时仓库里实际跑一遍。不调用 Claude（写提交说明用替身）。
// 运行：npm run test:unit
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as git from '../../src/main/git.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-git-'));
const repo = path.join(tmp, 'repo');
const remote = path.join(tmp, 'remote.git');
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const w = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
const r = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8');
const exists = (f: string) => fs.existsSync(path.join(repo, f));
const trashed: string[] = [];
const trash = async (p: string) => { trashed.push(path.relative(repo, p).replace(/\\/g, '/')); fs.rmSync(p, { force: true }); };
const noWriter = async () => { throw new Error('不该调用'); };

try {
  fs.mkdirSync(repo);
  // ---- 不是仓库 ----
  const none = await git.status(repo);
  check('不是仓库', none.repo === false && none.root === null, none);
  await git.init(repo);
  sh(repo, 'config', 'user.name', 't');
  sh(repo, 'config', 'user.email', 't@example.invalid');
  sh(repo, 'config', 'core.autocrlf', 'false');
  const fresh = await git.status(repo);
  check('初始化后：默认分支 main、还没有提交', fresh.repo && fresh.branch === 'main' && fresh.unborn, fresh);

  // ---- 还没有提交时的新文件 ----
  w('a.txt', 'one\ntwo\nthree\n');
  w('子目录/说明 文档.md', '# 标题\n');
  const s0 = await git.status(repo);
  check('新文件：行数统计', s0.add === 4 && s0.del === 0 && s0.files.length === 2, s0);
  const u0 = await git.scopeDiff(repo, 'unstaged');
  check('未暂存里有新文件（中文、空格路径）', u0.files.map(f => f.path).join('|') === 'a.txt|子目录/说明 文档.md' && u0.files[1].change === 'added', u0.files.map(f => f.path));
  await git.stage(repo, ['a.txt']);
  const st0 = await git.scopeDiff(repo, 'staged');
  check('还没有提交时也能看已暂存', st0.files.length === 1 && st0.files[0].path === 'a.txt' && st0.files[0].add === 3, st0.files);
  await git.unstage(repo, ['a.txt']);
  check('还没有提交时取消暂存', (await git.scopeDiff(repo, 'staged')).files.length === 0);
  const c0 = await git.commit(repo, { message: '初始提交', kind: 'commit' }, noWriter);
  check('第一次提交（没暂存时提交全部）', !!c0.commit && c0.commit.files === 2 && c0.commit.subject === '初始提交' && !c0.error, c0);

  // ---- 修改、暂存、未暂存 ----
  w('a.txt', 'one\nTWO\nthree\n');
  w('b [1].txt', 'brackets\n');
  const s1 = await git.status(repo);
  check('修改后：+2 −1', s1.add === 2 && s1.del === 1 && !s1.unborn, { add: s1.add, del: s1.del });
  await git.stage(repo, ['b [1].txt']);
  const s2 = await git.status(repo);
  const b = s2.files.find(f => f.path === 'b [1].txt');
  check('文件名带方括号也能暂存（不当通配符）', b?.x === 'A' && !b.untracked, s2.files);
  const un = await git.scopeDiff(repo, 'unstaged');
  const stg = await git.scopeDiff(repo, 'staged');
  check('未暂存 / 已暂存分开', un.files.map(f => f.path).join() === 'a.txt' && stg.files.map(f => f.path).join() === 'b [1].txt', { un: un.files.map(f => f.path), stg: stg.files.map(f => f.path) });
  const br = await git.scopeDiff(repo, 'branch');
  check('整个分支（没有远程）= 全部未提交的改动', br.files.length === 2 && br.desc.includes('还没有推送'), br);

  // ---- 撤销（未暂存） ----
  w('new.txt', 'temp\n');
  await git.revertUnstaged(repo, ['a.txt', 'new.txt'], trash);
  check('撤销：改过的文件恢复', r('a.txt') === 'one\ntwo\nthree\n');
  check('撤销：新文件移到回收站', !exists('new.txt') && trashed.includes('new.txt'), trashed);
  check('撤销：已暂存的不受影响', exists('b [1].txt') && (await git.status(repo)).files.some(f => f.path === 'b [1].txt' && f.x === 'A'));

  // ---- 快照：上一轮 ----
  const before = await git.snapshot(repo);
  check('拍快照', !!before?.tree && before.root === path.resolve(repo), before);
  const indexBefore = sh(repo, 'diff', '--cached', '--name-only');
  w('a.txt', 'one\ntwo\nthree\nfour\n');
  w('made-by-claude.txt', 'hi\n');
  fs.rmSync(path.join(repo, '子目录/说明 文档.md'));
  const after = await git.snapshot(repo);
  check('拍快照不碰用户的暂存区', sh(repo, 'diff', '--cached', '--name-only') === indexBefore);
  const turn = await git.treeDiff(repo, before!.tree, after!.tree);
  const turnPaths = turn.map(f => `${f.change}:${f.path}`).sort().join('|');
  check('两个快照之间的改动（包括新建、删除）', turnPaths === 'added:made-by-claude.txt|deleted:子目录/说明 文档.md|modified:a.txt', turnPaths);
  check('之前就有的改动不算进这一轮', !turn.some(f => f.path === 'b [1].txt'));
  await git.revertToTree(repo, before!.tree, ['a.txt', 'made-by-claude.txt', '子目录/说明 文档.md'], trash);
  check('撤销这一轮：改的恢复、删的回来、新建的移到回收站', r('a.txt') === 'one\ntwo\nthree\n' && r('子目录/说明 文档.md') === '# 标题\n' && !exists('made-by-claude.txt'), trashed);

  // ---- 留空让 Claude 写（替身）；写失败时不留下自动暂存的东西 ----
  sh(repo, 'restore', '--staged', 'b [1].txt');
  w('c.txt', 'c\n');
  const bad = await git.commit(repo, { message: '', kind: 'commit' }, async () => { throw new Error('模型不可用'); });
  check('写提交说明失败：报在 message 这一步', bad.error?.step === 'message' && !bad.commit, bad);
  check('写提交说明失败：自动暂存的又取消了', (await git.status(repo)).files.every(f => f.x === '.' || f.untracked), (await git.status(repo)).files);
  let seen = '';
  const gen = await git.commit(repo, { message: '', kind: 'commit' }, async root => { seen = (await git.stagedSummary(root)).stat; return '加了 b 和 c'; });
  check('留空：用写出来的说明提交', gen.commit?.subject === '加了 b 和 c' && gen.commit.generated && gen.commit.files === 2, gen);
  check('写说明时能看到暂存的改动', seen.includes('c.txt') && seen.includes('b [1].txt'), seen);
  const empty = await git.commit(repo, { message: 'x', kind: 'commit' }, noWriter);
  check('没有改动时提交：报错', empty.error?.step === 'commit', empty);

  // ---- 推送 ----
  const noRemote = await git.commit(repo, { message: '', kind: 'push' }, noWriter);
  check('没有远程仓库时推送：说清楚原因', noRemote.error?.step === 'push' && noRemote.error.message.includes('远程'), noRemote);
  execFileSync('git', ['init', '-q', '--bare', remote]);
  sh(repo, 'remote', 'add', 'origin', remote);
  const pushed = await git.commit(repo, { message: '', kind: 'push' }, noWriter);
  check('第一次推送：自动设置上游', pushed.pushed === 'origin/main' && !pushed.error && sh(remote, 'rev-parse', 'main') === sh(repo, 'rev-parse', 'HEAD'), pushed);
  w('a.txt', 'one\ntwo\nthree\nmore\n');
  const s3 = await git.status(repo);
  check('有上游以后：upstream、ahead', s3.upstream === 'origin/main' && s3.ahead === 0 && s3.hasRemote && s3.defaultBranch === 'main', s3);
  const cp = await git.commit(repo, { message: '再改一点', kind: 'push' }, noWriter);
  check('提交并推送', !!cp.commit && cp.pushed === 'origin/main' && sh(remote, 'rev-parse', 'main') === sh(repo, 'rev-parse', 'HEAD'), cp);
  const br2 = await git.scopeDiff(repo, 'branch');
  check('整个分支（有上游、都推送了）：没有改动', br2.files.length === 0 && br2.desc.includes('origin/main'), br2);

  // ---- 开 PR（假 gh） ----
  const ghLog = path.join(tmp, 'gh.log');
  process.env.CLAUDEX_GH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-gh.mjs');
  process.env.CLAUDEX_GH_LOG = ghLog;
  sh(repo, 'config', 'http.https://github.com.proxy', 'http://127.0.0.1:9');
  w('feature.txt', 'feature\n');
  const onMain = await git.commit(repo, { message: '新功能', kind: 'pr' }, noWriter);
  check('在默认分支上开 PR：推送后停在 pr 这一步', onMain.error?.step === 'pr' && onMain.pushed === 'origin/main', onMain);
  check('新分支名检查：已存在', (await git.checkBranchName(repo, 'main')) !== null);
  check('新分支名检查：不合法', (await git.checkBranchName(repo, 'a b')) !== null);
  check('新分支名检查：可以用', (await git.checkBranchName(repo, 'claudex/feature-1')) === null);
  w('feature.txt', 'feature v2\n');
  const pr = await git.commit(repo, { message: '新功能 v2', kind: 'pr', newBranch: 'claudex/feature-1' }, noWriter);
  check('切新分支、提交、推送、开 PR', pr.branch === 'claudex/feature-1' && !!pr.commit && pr.pushed === 'origin/claudex/feature-1' && pr.prUrl === 'https://github.com/example/demo/pull/7' && !pr.error, pr);
  const call = JSON.parse(fs.readFileSync(ghLog, 'utf8').trim().split('\n').pop()!);
  check('gh 的参数：--base main --head 新分支', call.args.join(' ') === 'pr create --fill --base main --head claudex/feature-1', call);
  check('gh 拿到 git 给 github.com 配的代理', call.proxy === 'http://127.0.0.1:9', call);
  const br3 = await git.scopeDiff(repo, 'branch');
  check('整个分支（推送后、有上游）：没有改动', br3.files.length === 0, br3);
  sh(repo, 'switch', '-q', '-c', 'local-only');
  w('x.txt', 'x\n');
  await git.commit(repo, { message: 'x', kind: 'commit' }, noWriter);
  const br4 = await git.scopeDiff(repo, 'branch');
  check('整个分支（没推送过的新分支）：相对 main', br4.desc.includes('main') && br4.files.some(f => f.path === 'x.txt') && br4.files.some(f => f.path === 'feature.txt'), br4);
  process.env.CLAUDEX_GH_FAIL = '1';
  const prFail = await git.commit(repo, { message: '', kind: 'pr' }, noWriter);
  check('gh 出错：推送照样成功，报在 pr 这一步', prFail.pushed === 'origin/local-only' && prFail.error?.step === 'pr' && prFail.error.message.includes('GraphQL'), prFail);
  delete process.env.CLAUDEX_GH_FAIL;

  // ---- 项目文件夹在另一个仓库里面 ----
  w('.gitignore', 'ignored-dir/\n');
  fs.mkdirSync(path.join(repo, 'ignored-dir', 'proj'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'pkg', 'src'), { recursive: true });
  check('被外层仓库忽略的文件夹：当成不是仓库', (await git.status(path.join(repo, 'ignored-dir', 'proj'))).repo === false);
  const sub = await git.status(path.join(repo, 'pkg', 'src'));
  check('普通子目录：用外层仓库', sub.repo && sub.root === path.resolve(repo), sub.root);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`--- git 操作：${total - failed}/${total} 通过`);
if (failed) process.exit(1);
