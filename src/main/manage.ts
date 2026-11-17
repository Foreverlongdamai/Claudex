// M3 管理：Skills（SKILL.md 文件）、MCP 服务器（claude mcp add-json / remove）、Claude Code 的设置文件（settings.json）。
// - Skill 本身就是文件夹，直接读写文件；插件自带的只读
// - MCP 服务器不直接改 ~/.claude.json（命令行也在频繁写它，两边同时写容易冲突），用 Claude Code 自己的 claude mcp 命令
// - 设置文件只改表单里那几项，其他字段原样保留；写之前备份一份 .claudex-bak
// 自动化测试用 CLAUDEX_USER_SKILLS_DIR、CLAUDEX_USER_SETTINGS_FILE 换掉用户级的位置，不碰真实的配置
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import { checkSkill, parseFrontmatter, skillTemplate, SKILL_NAME } from '../shared/skillFile.ts';
import { applyForm, checkForm, toForm, type SettingsForm, type SettingsScope } from '../shared/claudeSettings.ts';
import type { McpServerInput, McpServerView, SettingsView, SkillDoc, SkillEntry } from '../shared/manage';
import { samePath } from './store';
import { claudeExe } from './environment';

export const userSkillsDir = () => process.env.CLAUDEX_USER_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
export const userSettingsFile = () => process.env.CLAUDEX_USER_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json');
const projectSkillsDir = (p: string) => path.join(p, '.claude', 'skills');

const inside = (child: string, parent: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// ---------------- Skills ----------------

/** 已安装的插件自带的 Skills 文件夹：插件名 → 文件夹 */
function pluginSkillDirs(): Array<{ plugin: string; dir: string }> {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    const out: Array<{ plugin: string; dir: string }> = [];
    for (const [id, installs] of Object.entries(j.plugins ?? {})) {
      const p = installs?.[installs.length - 1]?.installPath;
      if (p && fs.existsSync(path.join(p, 'skills'))) out.push({ plugin: id.split('@')[0], dir: path.join(p, 'skills') });
    }
    return out;
  } catch {
    return [];
  }
}

function readEntry(file: string, source: SkillEntry['source'], plugin?: string): SkillEntry | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const fm = parseFrontmatter(text);
    const folder = path.basename(path.dirname(file));
    return {
      name: fm.fields.name || folder, description: fm.fields.description ?? '', source, ...(plugin ? { plugin } : {}),
      path: file, readOnly: source === 'plugin', problems: source === 'plugin' ? 0 : checkSkill(text, folder).length
    };
  } catch {
    return null;
  }
}

function scan(dir: string, source: SkillEntry['source'], plugin?: string): SkillEntry[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
    .map(d => readEntry(path.join(dir, d.name, 'SKILL.md'), source, plugin))
    .filter((e): e is SkillEntry => !!e);
}

/** 用户级、这个项目的、插件自带的 Skills */
export function listSkillFiles(projectPath: string | null): SkillEntry[] {
  const all = [
    ...(projectPath ? scan(projectSkillsDir(projectPath), 'project') : []),
    ...scan(userSkillsDir(), 'user'),
    ...pluginSkillDirs().flatMap(p => scan(p.dir, 'plugin', p.plugin))
  ];
  const order = { project: 0, user: 1, plugin: 2 };
  return all.sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name));
}

/** 这个 SKILL.md 能不能改：在用户级或者某个项目的 Skills 文件夹里 */
function writable(file: string, projects: string[]): 'user' | 'project' | null {
  if (path.basename(file) !== 'SKILL.md') return null;
  if (inside(file, userSkillsDir())) return 'user';
  if (projects.some(p => inside(file, projectSkillsDir(p)))) return 'project';
  return null;
}

export function readSkill(file: string, projects: string[]): SkillDoc {
  const source = writable(file, projects) ?? 'plugin';
  const entry = readEntry(file, source, source === 'plugin' ? pluginSkillDirs().find(p => inside(file, p.dir))?.plugin : undefined);
  if (!entry) throw new Error('读不了这个 Skill');
  const content = fs.readFileSync(file, 'utf8');
  return { entry, content, problems: source === 'plugin' ? [] : checkSkill(content, path.basename(path.dirname(file))) };
}

export function saveSkill(file: string, content: string, projects: string[]): SkillDoc {
  if (!writable(file, projects)) throw new Error('这个 Skill 不能在这里改（插件自带的只读）');
  const problems = checkSkill(content, path.basename(path.dirname(file)));
  if (problems.length) throw new Error(problems.join('；'));
  fs.writeFileSync(file, content, 'utf8');
  return readSkill(file, projects);
}

export function createSkill(scope: 'user' | 'project', projectPath: string | null, name: string, description: string): SkillDoc {
  const n = name.trim();
  if (!SKILL_NAME.test(n) || n.length > 64) throw new Error('名字只能用小写字母、数字和 -，最多 64 个字符（比如 release-check）');
  if (scope === 'project' && !projectPath) throw new Error('先选一个项目');
  const base = scope === 'user' ? userSkillsDir() : projectSkillsDir(projectPath!);
  const dir = path.join(base, n);
  if (fs.existsSync(dir)) throw new Error(`已经有叫「${n}」的 Skill 了`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillTemplate(n, description), 'utf8');
  return readSkill(path.join(dir, 'SKILL.md'), projectPath ? [projectPath] : []);
}

/** 删掉 Skill：整个文件夹移到回收站 */
export async function deleteSkill(file: string, projects: string[], trash: (p: string) => Promise<void>): Promise<void> {
  if (!writable(file, projects)) throw new Error('插件自带的 Skill 不能删（可以在插件管理里停用整个插件）');
  await trash(path.dirname(file));
}

// ---------------- MCP 服务器 ----------------

function runClaude(args: string[], cwd: string, env: Record<string, string | undefined>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(claudeExe(), args, { cwd, env: env as NodeJS.ProcessEnv, windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ')));
      else resolve(stdout.trim());
    });
  });
}

const SCOPES = new Set(['user', 'project', 'local']);

/** 服务器设置 → 表单 */
function toInput(name: string, scope: string, cfg: Record<string, unknown> | undefined): McpServerInput | undefined {
  if (!cfg || !SCOPES.has(scope)) return undefined;
  const type = (cfg.type as string | undefined) ?? (cfg.command ? 'stdio' : undefined);
  if (type === 'stdio') return { name, scope: scope as McpServerInput['scope'], type, command: String(cfg.command ?? ''), args: (cfg.args as string[] | undefined) ?? [], env: (cfg.env as Record<string, string> | undefined) ?? {} };
  if (type === 'http' || type === 'sse') return { name, scope: scope as McpServerInput['scope'], type, url: String(cfg.url ?? ''), headers: (cfg.headers as Record<string, string> | undefined) ?? {} };
  return undefined;
}

/** 项目 .mcp.json 里的服务器设置 */
export function projectServerConfigs(projectPath: string): Record<string, Record<string, unknown>> {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(projectPath, '.mcp.json'), 'utf8').replace(/^﻿/, ''));
    return j?.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
  } catch {
    return {};
  }
}

/**
 * SDK 查出来的状态 → 界面上的表。没批准的项目服务器被停用后，SDK 不列出来，
 * 所以再从 .mcp.json 补上（标成“没批准”，不启动）。
 */
export function toServerViews(list: McpServerStatus[], unapproved: Set<string>, projectConfigs: Record<string, Record<string, unknown>> = {}): McpServerView[] {
  const missing: McpServerStatus[] = Object.entries(projectConfigs)
    .filter(([name]) => !list.some(s => s.name === name))
    .map(([name, cfg]) => ({ name, status: 'disabled', scope: 'project', config: cfg as McpServerStatus['config'] }));
  return [...list, ...missing]
    .filter(s => s.source !== 'sdk')
    .map(s => {
      const cfg = s.config as Record<string, unknown> | undefined;
      const scope = s.scope ?? s.source ?? '';
      const type = (cfg?.type as string | undefined) ?? (cfg?.command ? 'stdio' : '—');
      const target = cfg?.command ? [cfg.command, ...((cfg.args as string[] | undefined) ?? [])].join(' ') : String(cfg?.url ?? '');
      return {
        name: s.name, scope, type, target, status: s.status, ...(s.error ? { error: s.error } : {}),
        tools: (s.tools ?? []).map(t => t.name), editable: SCOPES.has(scope),
        ...(scope === 'project' && unapproved.has(s.name) ? { unapproved: true } : {}),
        ...(toInput(s.name, scope, cfg) ? { input: toInput(s.name, scope, cfg) } : {})
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function checkServer(s: McpServerInput): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s.name)) return '名字只能用字母、数字、_ 和 -';
  if (s.type === 'stdio' && !s.command?.trim()) return '要填启动命令';
  if ((s.type === 'http' || s.type === 'sse') && !/^https?:\/\//i.test(s.url ?? '')) return '地址要以 http:// 或 https:// 开头';
  return null;
}

/** 新建或修改（修改 = 先删掉旧的再加） */
export async function saveServer(s: McpServerInput, projectPath: string, env: Record<string, string | undefined>, old?: { name: string; scope: string }): Promise<void> {
  const bad = checkServer(s);
  if (bad) throw new Error(bad);
  const cfg = s.type === 'stdio'
    ? { type: 'stdio', command: s.command!.trim(), args: (s.args ?? []).filter(Boolean), ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) }
    : { type: s.type, url: s.url!.trim(), ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) };
  if (old) await runClaude(['mcp', 'remove', old.name, '--scope', old.scope], projectPath, env);
  await runClaude(['mcp', 'add-json', s.name, JSON.stringify(cfg), '--scope', s.scope], projectPath, env);
}

export async function removeServer(name: string, scope: string, projectPath: string, env: Record<string, string | undefined>): Promise<void> {
  if (!SCOPES.has(scope)) throw new Error('这个服务器不是用户级、项目级或本地级的，不能在这里删');
  await runClaude(['mcp', 'remove', name, '--scope', scope], projectPath, env);
}

// ---------------- Claude Code 的设置 ----------------

export function settingsFile(scope: SettingsScope, projectPath: string | null): string {
  if (scope === 'user') return userSettingsFile();
  if (!projectPath) throw new Error('先选一个项目');
  return path.join(projectPath, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json');
}

function readJson(file: string): { data: Record<string, unknown>; exists: boolean } {
  if (!fs.existsSync(file)) return { data: {}, exists: false };
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return { data: {}, exists: true };
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('文件内容不是一个 JSON 对象');
  return { data, exists: true };
}

export function readSettings(scope: SettingsScope, projectPath: string | null): SettingsView {
  const file = settingsFile(scope, projectPath);
  try {
    const { data, exists } = readJson(file);
    return { scope, path: file, exists, form: toForm(data) };
  } catch (e) {
    return { scope, path: file, exists: true, form: toForm({}), error: `这个文件不是合法的 JSON，先手动修好：${e instanceof Error ? e.message : e}` };
  }
}

/** 保存：重新读文件，只把 before → after 改动的那几项写进去（别处同时改了也不会被冲掉） */
export function saveSettings(scope: SettingsScope, projectPath: string | null, before: SettingsForm, after: SettingsForm): SettingsView {
  const bad = checkForm(after);
  if (bad) throw new Error(bad);
  const file = settingsFile(scope, projectPath);
  const { data, exists } = readJson(file);
  const next = applyForm(data, before, after);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists) fs.copyFileSync(file, `${file}.claudex-bak`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  return readSettings(scope, projectPath);
}

export const isProjectSkill = (file: string, projectPath: string) => samePath(path.dirname(path.dirname(file)), projectSkillsDir(projectPath));
