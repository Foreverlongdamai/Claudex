// Git 审查和提交（C2）：改动面板用到的 git 操作都在这里，直接调 git 命令（和用户在终端里敲的一样）。
// 路径一律相对仓库根目录，命令都在仓库根目录下执行（项目文件夹可能只是仓库里的一个子目录）。
// 约定：
//   - GIT_OPTIONAL_LOCKS=0：查看状态时不去抢 index 锁，不和 Claude 同时跑的 git 命令打架
//   - 路径按字面意思理解（GIT_LITERAL_PATHSPECS），文件名里有 [ ] * 也不会被当成通配符
//   - 新文件“撤销”时移到回收站，不直接删
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addedFileDiff, looksBinary, parseDiff, type DiffFile } from '../shared/gitDiff.ts'; // 带 .ts：单元测试直接用 node 跑这个文件
import type { CommitRequest, CommitResult, GitDiffResult, GitFileState, GitScope, GitStatus } from '../shared/types';

/** git 里空树的固定 ID（还没有提交时拿它当比较的起点） */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** 一个文件最多带多少行 diff 给界面，再多只显示行数统计 */
const MAX_FILE_LINES = 4000;
/** 新文件超过这个大小就不读内容 */
const MAX_UNTRACKED_BYTES = 1024 * 1024;
/** 最多读多少个新文件的内容 */
const MAX_UNTRACKED_FILES = 300;
/** 拍快照时跳过超过这个大小的新文件，免得把大数据文件塞进 git 对象库 */
const SNAPSHOT_SKIP_BYTES = 20 * 1024 * 1024;
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--find-renames', '-U3', '--src-prefix=a/', '--dst-prefix=b/'];

export class GitError extends Error {
  readonly stderr: string;
  readonly code: number | string | null;
  constructor(message: string, stderr: string, code: number | string | null) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

interface RunOpts {
  input?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
  /** 路径按字面意思理解，不当通配符 */
  literal?: boolean;
}

/** 只保留最后几行（git 的报错前面常有一堆提示） */
const tail = (s: string, n = 8) => s.trim().split(/\r?\n/).slice(-n).join('\n');

export async function exec(cmd: string, args: string[], cwd: string, opts: RunOpts = {}): Promise<string> {
  return (await execRaw(cmd, args, cwd, opts)).toString('utf8');
}

/** 和 exec 一样，但输出是原始字节（读文件内容时用，不做编码转换） */
export function execRaw(cmd: string, args: string[], cwd: string, opts: RunOpts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_OPTIONAL_LOCKS: '0',
      ...(opts.literal ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
      ...opts.env
    };
    delete env.ELECTRON_RUN_AS_NODE;
    if (!fs.existsSync(cwd)) {
      reject(new GitError(`文件夹不存在：${cwd}`, '', 'ENOENT_CWD'));
      return;
    }
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true });
    } catch (e) {
      reject(new GitError(`${cmd} 启动失败：${e instanceof Error ? e.message : e}`, '', null));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = opts.timeout ? setTimeout(() => { timedOut = true; child.kill(); }, opts.timeout) : null;
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      reject(new GitError(e.code === 'ENOENT' ? `没找到 ${cmd} 命令` : `${cmd} 启动失败：${e.message}`, '', e.code ?? null));
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve(stdout);
      else if (timedOut) reject(new GitError(`${cmd} ${args.find(a => !a.startsWith('-')) ?? ''} 超时了`, stderr, 'timeout'));
      else reject(new GitError(tail(stderr || stdout.toString('utf8')) || `${cmd} 失败（退出码 ${code}）`, stderr, code));
    });
    child.stdin.on('error', () => { /* 进程提前退出时写不进去，忽略 */ });
    child.stdin.end(opts.input ?? '');
  });
}

export const git = (cwd: string, args: string[], opts?: RunOpts) =>
  exec('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=never', ...args], cwd, opts);
export const gitRaw = (cwd: string, args: string[], opts?: RunOpts) =>
  execRaw('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=never', ...args], cwd, opts);

/** 一组路径交给 git：用标准输入传（不受命令行长度限制，中文、空格都没问题） */
const pathsInput = (paths: string[]): RunOpts => ({ input: paths.join('\0'), literal: true });
const FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * 项目所在仓库的根目录。项目文件夹是仓库里的普通子目录（比如 monorepo 里的一个包）时用外层仓库；
 * 但如果它被外层仓库忽略了（.gitignore 里的目录），就不算外层仓库的一部分，当成不是 Git 仓库。
 */
export async function repoRoot(cwd: string): Promise<string | null> {
  if (!cwd || !fs.existsSync(cwd)) return null;
  let root: string;
  try {
    const out = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    if (!out) return null;
    root = path.resolve(out);
  } catch {
    return null;
  }
  if (samePath(root, cwd)) return root;
  try {
    const rel = path.relative(root, path.resolve(cwd)).replace(/\\/g, '/');
    // 注意不能设 GIT_LITERAL_PATHSPECS：check-ignore 不支持，会直接报错（退出码 128）
    await git(root, ['check-ignore', '-q', '--', rel + '/']);
    return null; // 退出码 0：被外层仓库忽略
  } catch {
    return root;
  }
}

async function mustRoot(cwd: string): Promise<string> {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('这个项目还不是 Git 仓库');
  return root;
}

// ---------------- 状态 ----------------

interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileState[];
}

/** 解析 git status --porcelain=v2 --branch -z */
export function parseStatus(out: string): ParsedStatus {
  const s: ParsedStatus = { branch: null, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0, files: [] };
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [, key, ...rest] = t.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') s.unborn = val === '(initial)';
      else if (key === 'branch.head') { if (val === '(detached)') s.detached = true; else s.branch = val; }
      else if (key === 'branch.upstream') s.upstream = val;
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); }
      }
      continue;
    }
    const parts = t.split(' ');
    const xy = parts[1] ?? '..';
    if (t[0] === '?') s.files.push({ path: t.slice(2), x: '?', y: '?', untracked: true, conflicted: false });
    else if (t[0] === '1') s.files.push({ path: parts.slice(8).join(' '), x: xy[0], y: xy[1], untracked: false, conflicted: false });
    else if (t[0] === '2') s.files.push({ path: parts.slice(9).join(' '), origPath: tokens[++i], x: xy[0], y: xy[1], untracked: false, conflicted: false });
    else if (t[0] === 'u') s.files.push({ path: parts.slice(10).join(' '), x: xy[0], y: xy[1], untracked: false, conflicted: true });
  }
  return s;
}

/** git diff --numstat -z 的总行数（二进制文件是 "-"，不算） */
function sumNumstat(out: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(tokens[i]);
    if (!m) continue;
    if (m[1] !== '-') add += Number(m[1]);
    if (m[2] !== '-') del += Number(m[2]);
    if (m[3] === '') i += 2; // 重命名：后面跟着旧路径和新路径
  }
  return { add, del };
}

function readSmallText(file: string): string | null | 'binary' {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) return null;
    const buf = fs.readFileSync(file);
    return looksBinary(buf) ? 'binary' : buf.toString('utf8');
  } catch {
    return null;
  }
}

function countLines(file: string): number {
  const text = readSmallText(file);
  if (!text || text === 'binary') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

export async function defaultBranch(root: string): Promise<string | null> {
  try {
    const r = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (r) return r.replace(/^[^/]+\//, '');
  } catch {
    // 远程没有设 HEAD（本地建的仓库再推上去，常见）
  }
  for (const b of ['main', 'master']) {
    try {
      await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
      return b;
    } catch {
      // 没有这个分支
    }
  }
  return null;
}

async function remotes(root: string): Promise<string[]> {
  return (await git(root, ['remote']).catch(() => '')).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

export async function status(cwd: string): Promise<GitStatus> {
  const root = await repoRoot(cwd);
  if (!root) {
    return { repo: false, root: null, branch: null, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0, defaultBranch: null, hasRemote: false, files: [], add: 0, del: 0 };
  }
  const s = parseStatus(await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']));
  const [numstat, def, rem] = await Promise.all([
    git(root, ['diff', '--numstat', '-z', s.unborn ? EMPTY_TREE : 'HEAD']).catch(() => ''),
    defaultBranch(root),
    remotes(root)
  ]);
  let { add, del } = sumNumstat(numstat);
  for (const f of s.files.filter(f => f.untracked).slice(0, MAX_UNTRACKED_FILES)) add += countLines(path.join(root, f.path));
  return { repo: true, root, ...s, defaultBranch: def, hasRemote: rem.length > 0, add, del };
}

// ---------------- diff ----------------

function trimLarge(files: DiffFile[]): DiffFile[] {
  return files.map(f => (f.lines.length > MAX_FILE_LINES ? { ...f, lines: [], tooLarge: true } : f));
}

const byPath = (a: DiffFile, b: DiffFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function untrackedDiffs(root: string, paths: string[]): DiffFile[] {
  return paths.slice(0, MAX_UNTRACKED_FILES).map(p => {
    const text = readSmallText(path.join(root, p));
    if (text === 'binary') return { path: p, change: 'added' as const, binary: true, add: 0, del: 0, lines: [] };
    if (text === null) return { path: p, change: 'added' as const, binary: false, add: 0, del: 0, lines: [], tooLarge: true };
    return addedFileDiff(p, text);
  });
}

/** 整个分支：和哪里比 */
async function branchBase(root: string, st: GitStatus): Promise<{ ref: string; desc: string }> {
  if (st.unborn) return { ref: EMPTY_TREE, desc: '还没有提交过：显示全部文件' };
  if (st.upstream) {
    try {
      const mb = (await git(root, ['merge-base', 'HEAD', '@{upstream}'])).trim();
      return { ref: mb, desc: `相对 ${st.upstream}：还没推送的提交和未提交的改动` };
    } catch {
      // 远程分支没了
    }
  }
  if (st.defaultBranch && st.branch !== st.defaultBranch) {
    try {
      const mb = (await git(root, ['merge-base', 'HEAD', st.defaultBranch])).trim();
      return { ref: mb, desc: `相对 ${st.defaultBranch} 的全部改动` };
    } catch {
      // 没有共同的祖先
    }
  }
  return { ref: 'HEAD', desc: '还没有推送到远程：显示全部未提交的改动' };
}

/** 未暂存、已暂存、整个分支（上一轮在 review.ts） */
export async function scopeDiff(cwd: string, scope: Exclude<GitScope, 'turn'>): Promise<GitDiffResult> {
  const st = await status(cwd);
  if (!st.repo || !st.root) return { scope, desc: '', files: [], empty: '这个项目还不是 Git 仓库' };
  const root = st.root;
  const untracked = st.files.filter(f => f.untracked).map(f => f.path);
  if (scope === 'unstaged') {
    const files = [...parseDiff(await git(root, DIFF)), ...untrackedDiffs(root, untracked)].sort(byPath);
    return { scope, desc: '还没暂存的改动', files: trimLarge(files), empty: st.files.length ? '改动都已经暂存了' : '没有未提交的改动' };
  }
  if (scope === 'staged') {
    const files = parseDiff(await git(root, [...DIFF, '--cached']));
    return { scope, desc: '已暂存、准备提交的改动', files: trimLarge(files), empty: '还没有暂存任何改动。直接提交会提交全部改动' };
  }
  const base = await branchBase(root, st);
  const files = [...parseDiff(await git(root, [...DIFF, base.ref])), ...untrackedDiffs(root, untracked)].sort(byPath);
  return { scope, desc: base.desc, files: trimLarge(files), empty: '这个分支上没有改动' };
}

/** 两个快照（树对象）之间的改动 */
export async function treeDiff(root: string, before: string, after: string): Promise<DiffFile[]> {
  return trimLarge(parseDiff(await git(root, [...DIFF, before, after])));
}

// ---------------- 快照 ----------------

async function bigUntracked(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => '');
  return out.split('\0').filter(Boolean).filter(p => {
    try { return fs.statSync(path.join(root, p)).size > SNAPSHOT_SKIP_BYTES; } catch { return false; }
  });
}

/**
 * 给整个工作区（包括还没被跟踪的新文件，不包括 .gitignore 忽略的）拍一个快照，返回树对象的 ID。
 * 用一个临时的 index 文件，不碰用户自己的暂存区；先复制原来的 index，只有改过的文件需要重新计算。
 */
export async function snapshot(cwd: string): Promise<{ root: string; tree: string } | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const indexPath = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
  const tmp = path.join(os.tmpdir(), `claudex-snapshot-${randomUUID()}`);
  try {
    if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    const skip = await bigUntracked(root);
    await git(root, ['add', '-A', '--', '.', ...skip.map(p => `:(exclude,literal)${p}`)], { env, timeout: 120_000 });
    const tree = (await git(root, ['write-tree'], { env })).trim();
    return tree ? { root, tree } : null;
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmp + '.lock', { force: true });
  }
}

// ---------------- 暂存、撤销 ----------------

export async function stage(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await git(await mustRoot(cwd), ['add', '-A', ...FROM_STDIN], pathsInput(paths));
}

export async function unstage(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const st = await status(cwd);
  const root = st.root ?? (await mustRoot(cwd));
  // 重命名要连旧路径一起取消，不然旧文件会留在“已删除”的暂存状态
  const all = new Set(paths);
  for (const f of st.files) if (f.origPath && all.has(f.path)) all.add(f.origPath);
  if (st.unborn) await git(root, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', ...FROM_STDIN], pathsInput([...all]));
  else await git(root, ['restore', '--staged', ...FROM_STDIN], pathsInput([...all]));
}

export type Trash = (absPath: string) => Promise<void>;

/** 未暂存：恢复成暂存区里的样子；新文件移到回收站 */
export async function revertUnstaged(cwd: string, paths: string[], trash: Trash): Promise<void> {
  const st = await status(cwd);
  const root = st.root ?? (await mustRoot(cwd));
  const untracked = new Set(st.files.filter(f => f.untracked).map(f => f.path));
  for (const p of paths.filter(p => untracked.has(p))) await trash(path.join(root, p));
  const tracked = paths.filter(p => !untracked.has(p));
  if (tracked.length) await git(root, ['restore', '--worktree', ...FROM_STDIN], pathsInput(tracked));
}

/** 上一轮：恢复成快照里的样子；快照里没有的文件（这一轮新建的）移到回收站 */
export async function revertToTree(root: string, tree: string, paths: string[], trash: Trash): Promise<void> {
  const inTree = new Set((await git(root, ['ls-tree', '-r', '--name-only', '-z', tree])).split('\0').filter(Boolean));
  const restore = paths.filter(p => inTree.has(p));
  if (restore.length) await git(root, ['restore', `--source=${tree}`, '--worktree', ...FROM_STDIN], pathsInput(restore));
  for (const p of paths.filter(p => !inTree.has(p))) {
    const abs = path.join(root, p);
    if (fs.existsSync(abs)) await trash(abs);
  }
}

export async function init(cwd: string): Promise<void> {
  const def = (await git(cwd, ['config', '--get', 'init.defaultBranch']).catch(() => '')).trim();
  await git(cwd, ['init', ...(def ? [] : ['-b', 'main'])]);
}

export async function checkBranchName(cwd: string, name: string): Promise<string | null> {
  const root = await mustRoot(cwd);
  if (!name.trim()) return '分支名不能为空';
  try {
    await git(root, ['check-ref-format', '--branch', name]);
  } catch {
    return '分支名不合法（不能有空格、~ ^ : ? * [ \\ 等字符，也不能以 - 或 . 开头）';
  }
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return '已经有这个名字的分支了';
  } catch {
    return null;
  }
}

// ---------------- 提交、推送、开 PR ----------------

/** 留空让 Claude 写提交说明时要给它看的东西 */
export async function stagedSummary(root: string): Promise<{ stat: string; diff: string; recent: string }> {
  const [stat, diff, recent] = await Promise.all([
    git(root, ['diff', '--cached', '--stat']),
    git(root, [...DIFF, '--cached']),
    git(root, ['log', '-8', '--format=%s']).catch(() => '')
  ]);
  return { stat: stat.trim(), diff: diff.length > 16000 ? diff.slice(0, 16000) + '\n…（后面省略）' : diff, recent: recent.trim() };
}

async function unstageAll(root: string, unborn: boolean): Promise<void> {
  await (unborn ? git(root, ['rm', '--cached', '-r', '-q', '.']) : git(root, ['reset', '-q'])).catch(() => {});
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** gh 走的是 HTTPS，不读 git 的代理设置；本机直连 GitHub 不通，把 git 对 github.com 配的代理传给它 */
async function ghEnv(root: string): Promise<Record<string, string>> {
  const env: Record<string, string> = { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
    const proxy = (await git(root, ['config', '--get-urlmatch', 'http.proxy', 'https://github.com']).catch(() => '')).trim();
    if (proxy) { env.HTTPS_PROXY = proxy; env.HTTP_PROXY = proxy; }
  }
  return env;
}

async function createPr(root: string, base: string, branch: string): Promise<string> {
  // 测试时用 CLAUDEX_GH 换成假的 gh（.mjs 文件用 node 运行）
  const fake = process.env.CLAUDEX_GH;
  const [cmd, pre] = fake ? (fake.endsWith('.mjs') ? ['node', [fake]] : [fake, []]) : ['gh', []];
  try {
    const out = await exec(cmd, [...pre, 'pr', 'create', '--fill', '--base', base, '--head', branch], root, { env: await ghEnv(root), timeout: 120_000 });
    const url = out.match(/https?:\/\/\S+/g)?.pop();
    if (!url) throw new Error(out.trim() || 'gh 没有返回 PR 的地址');
    return url;
  } catch (e) {
    const text = e instanceof GitError ? `${e.stderr}\n${e.message}` : errText(e);
    const exists = /already exists[\s\S]*?(https?:\/\/\S+)/.exec(text);
    if (exists) return exists[1];
    if (e instanceof GitError && e.code === 'ENOENT') throw new Error('没找到 gh 命令（GitHub CLI）。装好并运行 gh auth login 之后再试');
    throw e;
  }
}

/**
 * 提交（可选：推送、开 PR）。有暂存的改动只提交暂存的，否则提交全部改动。
 * 没有可提交的改动时，推送和开 PR 照样做（把之前的提交推上去）。
 * 中间哪一步出错就停在那一步，前面成功的步骤照样返回。
 */
export async function commit(cwd: string, req: CommitRequest, writeMessage: (root: string) => Promise<string>): Promise<CommitResult> {
  const root = await repoRoot(cwd);
  if (!root) return { branch: null, error: { step: 'commit', message: '这个项目还不是 Git 仓库' } };
  let st = await status(root);
  const result: CommitResult = { branch: st.branch };
  if (req.newBranch) {
    try {
      await git(root, ['switch', '-c', req.newBranch]);
      result.branch = req.newBranch;
    } catch (e) {
      return { ...result, error: { step: 'branch', message: errText(e) } };
    }
  }
  if (st.files.length) {
    if (st.files.some(f => f.conflicted)) return { ...result, error: { step: 'commit', message: '有合并冲突还没解决，先解决冲突再提交' } };
    const stagedAny = st.files.some(f => !f.untracked && f.x !== '.');
    if (!stagedAny) await git(root, ['add', '-A']);
    let message = req.message.trim();
    let generated = false;
    if (!message) {
      try {
        message = (await writeMessage(root)).trim();
        if (!message) throw new Error('Claude 返回了空的提交说明');
        generated = true;
      } catch (e) {
        if (!stagedAny) await unstageAll(root, st.unborn);
        return { ...result, error: { step: 'message', message: errText(e) } };
      }
    }
    try {
      await git(root, ['commit', '-q', '-F', '-'], { input: message + '\n', timeout: 120_000 });
    } catch (e) {
      if (!stagedAny) await unstageAll(root, st.unborn);
      return { ...result, error: { step: 'commit', message: errText(e) } };
    }
    const hash = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
    const files = (await git(root, ['show', '--name-only', '--format=', 'HEAD'])).split(/\r?\n/).filter(Boolean).length;
    result.commit = { hash, subject: message.split(/\r?\n/)[0], message, files, generated };
  } else if (req.kind === 'commit') {
    return { ...result, error: { step: 'commit', message: '没有可以提交的改动' } };
  }
  if (req.kind === 'commit') return result;

  st = await status(root);
  const branch = st.branch;
  if (!branch) return { ...result, error: { step: 'push', message: '当前不在任何分支上（分离 HEAD），推送不了' } };
  const rem = await remotes(root);
  if (!rem.length) return { ...result, error: { step: 'push', message: '这个仓库还没有设置远程仓库（git remote add origin <地址>），推送不了' } };
  try {
    if (st.upstream) {
      await git(root, ['push'], { timeout: 180_000 });
      result.pushed = st.upstream;
    } else {
      const remote = rem.includes('origin') ? 'origin' : rem[0];
      await git(root, ['push', '-u', remote, branch], { timeout: 180_000 });
      result.pushed = `${remote}/${branch}`;
    }
  } catch (e) {
    return { ...result, error: { step: 'push', message: errText(e) } };
  }
  if (req.kind === 'push') return result;

  const base = st.defaultBranch;
  if (!base || base === branch) return { ...result, error: { step: 'pr', message: `在默认分支 ${branch} 上不能开 PR，要先切到新分支` } };
  try {
    result.prUrl = await createPr(root, base, branch);
  } catch (e) {
    return { ...result, error: { step: 'pr', message: errText(e) } };
  }
  return result;
}
