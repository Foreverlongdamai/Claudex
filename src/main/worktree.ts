// C3：对话可以在独立的 git worktree（项目的副本）里干活，多个对话同时改代码互不干扰。
// - 放在项目旁边的统一文件夹：D:\research\proj → D:\research\.claudex-worktrees\proj\<名字>，分支 claudex/<名字>
// - 从本地当前分支最新的提交开始（本地没提交的改动不会带过去）
// - 接手到本地：worktree 里的全部改动（提交了的、没提交的、新文件）搬到本地，变成未提交的改动，然后删掉 worktree
// - 删掉 worktree 之前（接手或删除对话），先把全部改动存成它分支上的一个提交，之后还能从分支找回
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorktreeInfo } from '../shared/types';
import { looksBinary } from '../shared/gitDiff.ts';
import { git, gitRaw, repoRoot, snapshot, status } from './git.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** 这个项目能不能开 worktree：能返回 null，不能返回原因 */
export async function worktreeCheck(projectPath: string): Promise<string | null> {
  const root = await repoRoot(projectPath);
  if (!root) return '这个项目还不是 Git 仓库，不能用 worktree（可以先在改动面板里初始化）';
  if ((await status(root)).unborn) return '这个仓库还没有任何提交，先提交一次才能开 worktree';
  return null;
}

/** 这个仓库的 worktree 都放在哪个文件夹 */
export const worktreeParent = (root: string) => path.join(path.dirname(root), '.claudex-worktrees', path.basename(root));

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function createWorktree(projectPath: string, now = new Date()): Promise<WorktreeInfo> {
  const problem = await worktreeCheck(projectPath);
  if (problem) throw new Error(problem);
  const root = (await repoRoot(projectPath))!;
  const st = await status(root);
  const base = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const parent = worktreeParent(root);
  const stem = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  let name = stem;
  for (let i = 2; fs.existsSync(path.join(parent, name)) || (await branchExists(root, `claudex/${name}`)); i++) name = `${stem}-${i}`;
  const dir = path.join(parent, name);
  const branch = `claudex/${name}`;
  fs.mkdirSync(parent, { recursive: true });
  await git(root, ['worktree', 'add', '--quiet', '-b', branch, dir, base], { timeout: 300_000 });
  const sub = path.relative(root, path.resolve(projectPath));
  return { path: dir, cwd: sub ? path.join(dir, sub) : dir, branch, base, baseBranch: st.branch };
}

/** 仓库没配 git 身份时，存档提交用 Claudex 的名字 */
async function identityEnv(cwd: string): Promise<Record<string, string>> {
  const name = (await git(cwd, ['config', 'user.name']).catch(() => '')).trim();
  const email = (await git(cwd, ['config', 'user.email']).catch(() => '')).trim();
  if (name && email) return {};
  return { GIT_AUTHOR_NAME: name || 'Claudex', GIT_AUTHOR_EMAIL: email || 'claudex@localhost', GIT_COMMITTER_NAME: name || 'Claudex', GIT_COMMITTER_EMAIL: email || 'claudex@localhost' };
}

/**
 * 把 worktree 里的全部改动存成它分支上的一个提交（之后删掉 worktree 也能从分支找回）。
 * 返回全部改动的快照（树对象）。
 */
async function saveToBranch(wt: WorktreeInfo, message: string): Promise<string> {
  const snap = await snapshot(wt.path);
  if (!snap) throw new Error(`读不到 worktree 里的改动：${wt.path}`);
  const head = (await git(wt.path, ['rev-parse', 'HEAD'])).trim();
  const headTree = (await git(wt.path, ['rev-parse', 'HEAD^{tree}'])).trim();
  if (snap.tree !== headTree) {
    const commit = (await git(wt.path, ['commit-tree', snap.tree, '-p', head, '-m', message], { env: await identityEnv(wt.path) })).trim();
    await git(wt.path, ['update-ref', `refs/heads/${wt.branch}`, commit, head]);
  }
  return snap.tree;
}

/** worktree 所属的主仓库（从 worktree 自己找，不依赖项目文件夹还在不在） */
async function mainRoot(wt: WorktreeInfo, fallback: string): Promise<string> {
  try {
    const common = (await git(wt.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    return path.dirname(path.resolve(common));
  } catch {
    return fallback;
  }
}

/**
 * 删掉 worktree 文件夹，再让 git 清理它的记录。删干净返回 true。
 * 不用 git worktree remove：它在 Windows 上遇到被占用的文件会删到一半（先删掉 .git 文件）就失败，之后 git 不再认它是 worktree。
 * 刚关掉的 Claude 进程（和它启动的 MCP 服务器等）可能还占着文件夹，所以多等几次。
 */
async function removeWorktree(fallbackRoot: string, wt: WorktreeInfo): Promise<boolean> {
  const root = await mainRoot(wt, fallbackRoot);
  let gone = false;
  for (let i = 0; i < 15 && !gone; i++) {
    try {
      fs.rmSync(wt.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // 还被占着
    }
    gone = !fs.existsSync(wt.path);
    if (!gone) await new Promise(r => setTimeout(r, 700));
  }
  if (fs.existsSync(root)) await git(root, ['worktree', 'prune']).catch(() => {});
  if (gone) {
    // 项目的 worktree 文件夹空了就顺手删掉
    try { fs.rmdirSync(path.dirname(wt.path)); } catch { /* 还有别的 worktree */ }
    try { fs.rmdirSync(path.dirname(path.dirname(wt.path))); } catch { /* 还有别的项目 */ }
  }
  return gone;
}

/** 某个版本里的文件内容，按仓库的换行设置转换成工作区里的样子（CRLF 之类）；没有这个文件返回 null */
async function blob(root: string, rev: string, p: string): Promise<Buffer | null> {
  try {
    return await gitRaw(root, ['cat-file', '--filters', `${rev}:${p}`]);
  } catch {
    return null;
  }
}

const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));

function writeOrDelete(abs: string, content: Buffer | null): void {
  if (content === null) { fs.rmSync(abs, { force: true }); return; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * 本地的文件在这期间也改过、补丁直接打不上时：一个文件一个文件地搬，不碰暂存区。
 * 本地没动过的文件直接用 worktree 的；两边都改过的文本文件做三方合并，冲突的地方写上冲突标记；
 * 两边都改过的二进制文件、或者一边删一边改的，保留本地的，算冲突。返回有冲突的文件。
 */
async function applyFileByFile(root: string, base: string, tree: string): Promise<string[]> {
  const conflicts: string[] = [];
  const tokens = (await git(root, ['diff', '--name-status', '-z', '--no-renames', base, tree])).split('\0').filter(Boolean);
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const p = tokens[i + 1];
    const abs = path.join(root, p);
    const local = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
    const before = await blob(root, base, p);
    const after = await blob(root, tree, p);
    if (same(local, after)) continue; // 本地已经是这样了
    if (same(local, before)) { writeOrDelete(abs, after); continue; } // 本地没动过
    const text = (b: Buffer | null) => b === null || !looksBinary(b);
    if (local === null || after === null || !text(local) || !text(after) || !text(before)) { conflicts.push(p); continue; }
    const tmpBase = path.join(os.tmpdir(), `claudex-merge-${randomUUID()}.base`);
    const tmpOther = path.join(os.tmpdir(), `claudex-merge-${randomUUID()}.other`);
    try {
      fs.writeFileSync(tmpBase, before ?? Buffer.alloc(0));
      fs.writeFileSync(tmpOther, after);
      await git(root, ['merge-file', '-L', '本地', '-L', '开始时', '-L', 'worktree', abs, tmpBase, tmpOther]);
    } catch {
      conflicts.push(p); // 退出码是冲突的个数；冲突标记已经写进文件
    } finally {
      fs.rmSync(tmpBase, { force: true });
      fs.rmSync(tmpOther, { force: true });
    }
  }
  return conflicts;
}

/** 接手到本地：把 worktree 里的全部改动搬到本地项目文件夹（未提交的改动），然后删掉 worktree */
export async function handoff(projectPath: string, wt: WorktreeInfo): Promise<{ files: number; conflicts: string[]; leftover?: string }> {
  const root = await repoRoot(projectPath);
  if (!root) throw new Error('本地项目文件夹不是 Git 仓库了');
  if (!fs.existsSync(wt.path)) throw new Error(`找不到 worktree 的文件夹：${wt.path}`);
  const tree = await saveToBranch(wt, 'Claudex：接手到本地时的全部改动');
  const names = (await git(root, ['diff', '--name-only', '-z', wt.base, tree])).split('\0').filter(Boolean);
  let conflicts: string[] = [];
  if (names.length) {
    // 补丁写到文件里再应用，不经过字符串转换（GBK 之类的文件不会被弄坏）
    const patch = path.join(os.tmpdir(), `claudex-handoff-${randomUUID()}.patch`);
    try {
      await git(root, ['diff', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', `--output=${patch}`, wt.base, tree]);
      try {
        await git(root, ['apply', '--whitespace=nowarn', patch]); // 一般情况：直接打上（要么全成功，要么什么都不改）
      } catch {
        conflicts = await applyFileByFile(root, wt.base, tree); // 本地的文件在这期间也改过
      }
    } finally {
      fs.rmSync(patch, { force: true });
    }
  }
  // 改动已经搬到本地、也存在分支上了：文件夹删不干净只是提示，不算接手失败
  const gone = await removeWorktree(root, wt);
  return { files: names.length, conflicts, ...(gone ? {} : { leftover: wt.path }) };
}

/** 删除 worktree 对话：改动先存到分支上，再删掉 worktree。文件夹删不干净时返回它的路径 */
export async function discard(projectPath: string, wt: WorktreeInfo): Promise<string | null> {
  const root = (await repoRoot(projectPath)) ?? projectPath;
  if (!fs.existsSync(wt.path)) {
    if (fs.existsSync(root)) await git(root, ['worktree', 'prune']).catch(() => {});
    return null;
  }
  await saveToBranch(wt, 'Claudex：删除对话时 worktree 里的全部改动');
  return (await removeWorktree(root, wt)) ? null : wt.path;
}
