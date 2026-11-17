// 执行用户在推荐清单里勾选的项（Skills 配置模式）：安装动作由 Claudex 做，不经过模型。
// - 新 Skill：git clone 仓库（浅克隆，用 git 自己的代理设置）到临时目录，把 Skill 那个文件夹复制到项目的 .claude/skills/<名字>/；
//   不运行里面的任何脚本
// - MCP 服务器：claude mcp add-json --scope project（算用户批准过）
// - 关闭：写进项目 .claude/settings.json 的 skillOverrides（值为 "off"），不删除任何文件，其他项目不受影响
// - 最后把“本项目用哪些 Skills 和工具”写进 CLAUDE.md（有标记的一段，重新应用时替换）
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFrontmatter } from '../shared/skillFile.ts';
import { claudeMdSection, pickSkillDir, repoUrl, upsertClaudeMd, withClosedSkills, type AppliedPlan, type SkillPlan } from '../shared/skillPlan.ts';

export interface ApplyDeps {
  /** 加一个项目级的 MCP 服务器（并记为批准过） */
  addMcp: (projectPath: string, item: SkillPlan['install'][number]) => Promise<void>;
  log: (line: string) => void;
}

export interface ApplyResult extends AppliedPlan {
  failed: Array<{ name: string; why: string }>;
}

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|ps1|psm1|bat|cmd|rb|pl|php|exe)$/i;

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' ')));
      else resolve();
    });
  });
}

/** 仓库里所有含 SKILL.md 的文件夹（不进 .git、node_modules） */
function skillDirs(root: string): Array<{ dir: string; name?: string }> {
  const out: Array<{ dir: string; name?: string }> = [];
  const walk = (rel: string, depth: number) => {
    const abs = path.join(root, rel);
    if (fs.existsSync(path.join(abs, 'SKILL.md'))) {
      let name: string | undefined;
      try { name = parseFrontmatter(fs.readFileSync(path.join(abs, 'SKILL.md'), 'utf8')).fields.name; } catch { /* 读不了就不管名字 */ }
      out.push({ dir: rel.replace(/\\/g, '/'), name });
    }
    if (depth >= 5) return;
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== '.git' && d.name !== 'node_modules') walk(path.join(rel, d.name), depth + 1);
    }
  };
  walk('', 0);
  return out;
}

function countScripts(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile() && SCRIPT_EXT.test(e.name)) n++;
  return n;
}

/** 装一个 Skill：克隆仓库，复制 Skill 那个文件夹到项目里 */
export async function installSkill(projectPath: string, item: SkillPlan['install'][number]): Promise<{ scripts: number }> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/i.test(item.name)) throw new Error('名字不合法');
  const dest = path.join(projectPath, '.claude', 'skills', item.name);
  if (fs.existsSync(dest)) throw new Error('项目里已经有同名的 Skill 了');
  const tmp = path.join(os.tmpdir(), `claudex-skill-${randomUUID().slice(0, 8)}`);
  try {
    await git(['clone', '--depth', '1', '--quiet', repoUrl(item.repo), tmp], os.tmpdir());
    const rel = pickSkillDir(skillDirs(tmp), item.name, item.path);
    if (rel === null) throw new Error(`仓库里找不到 ${item.path ? `${item.path}/` : ''}SKILL.md`);
    const src = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, filter: p => !p.split(path.sep).includes('.git') });
    return { scripts: countScripts(dest) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.claudex-bak`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

export async function applySkillPlan(projectPath: string, plan: SkillPlan, deps: ApplyDeps): Promise<ApplyResult> {
  const r: ApplyResult = { keep: plan.keep, installed: [], mcp: [], closed: [], failed: [] };
  for (const item of plan.install) {
    try {
      if (item.kind === 'skill') {
        const { scripts } = await installSkill(projectPath, item);
        r.installed.push({ name: item.name, repo: item.repo, scripts });
        deps.log(`推荐清单：装了 Skill ${item.name}（${item.repo}）`);
      } else {
        await deps.addMcp(projectPath, item);
        r.mcp.push({ name: item.name, repo: item.repo });
        deps.log(`推荐清单：加了 MCP 服务器 ${item.name}（${item.repo}）`);
      }
    } catch (e) {
      r.failed.push({ name: item.name, why: e instanceof Error ? e.message : String(e) });
    }
  }
  if (plan.close.length) {
    const file = path.join(projectPath, '.claude', 'settings.json');
    try {
      const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '') || '{}') : {};
      writeJson(file, withClosedSkills(cur, plan.close));
      r.closed = plan.close;
    } catch (e) {
      r.failed.push({ name: '在本项目关闭 Skills', why: e instanceof Error ? e.message : String(e) });
    }
  }
  try {
    const md = path.join(projectPath, 'CLAUDE.md');
    const text = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
    fs.writeFileSync(md, upsertClaudeMd(text, claudeMdSection(r)), 'utf8');
  } catch (e) {
    r.failed.push({ name: '写进 CLAUDE.md', why: e instanceof Error ? e.message : String(e) });
  }
  return r;
}

/** 给 Claude 的结果说明 */
export function describeApplied(r: ApplyResult): string {
  const parts = [
    r.installed.length ? `装好了 Skill：${r.installed.map(i => `${i.name}${i.scripts ? `（含 ${i.scripts} 个脚本，没有运行）` : ''}`).join('、')}（项目的 .claude/skills/）` : '',
    r.mcp.length ? `加好了 MCP 服务器：${r.mcp.map(m => m.name).join('、')}（项目的 .mcp.json）` : '',
    r.closed.length ? `在本项目关闭了 ${r.closed.length} 个 Skills（.claude/settings.json 的 skillOverrides）` : '',
    r.keep.length ? `要用的已安装 Skills：${r.keep.join('、')}` : '',
    r.failed.length ? `没做成：${r.failed.map(f => `${f.name}（${f.why}）`).join('；')}` : ''
  ].filter(Boolean);
  return `用户确认了推荐清单，Claudex 已经执行：\n- ${parts.join('\n- ') || '什么都没选'}\n已经把“本项目用的 Skills 和工具”写进 CLAUDE.md。新装的 Skill、MCP 和关闭的设置从下一条消息起生效。简短地告诉用户结果就好，不要再安装别的。`;
}
