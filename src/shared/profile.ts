// 员工档案：用 Claude Code 自带的子代理格式，存在项目里的 .claude/agents/<编号>.md。
// 开头的 YAML 放设置（工具、模型、权限、记忆……），正文是角色提示词。命令行 claude --agent <编号> 也能直接用。
// 只支持档案里用得到的简单 YAML：key: value、逗号分隔的列表、[a, b]、"- 项" 列表、带引号的字符串。
// 纯函数，不依赖 Node，单元测试直接跑。
import type { Effort } from './types';

export type EmployeeMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
export type MemoryScope = 'project' | 'user' | 'local';

export interface EmployeeProfile {
  /** 英文编号，也是文件名：translator、code-reviewer */
  id: string;
  /** 显示的名字：小李 */
  displayName: string;
  /** 一句话：负责什么（老板按这个挑人） */
  description: string;
  /** 角色提示词：身份、职责、工作方法、汇报格式 */
  prompt: string;
  /** 能用的工具；不写表示全部 */
  tools?: string[];
  disallowedTools?: string[];
  /** opus / sonnet / haiku / inherit 或完整的模型 ID */
  model?: string;
  effort?: Effort;
  permissionMode?: EmployeeMode;
  /** 预装的 Skills */
  skills?: string[];
  /** 长期记忆放在哪；null 表示不要长期记忆 */
  memory?: MemoryScope | null;
}

export const EMPLOYEE_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** 会改文件的工具：一个都没有的员工算“只读” */
export const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'];
const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODE_VALUES: EmployeeMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

export const isReadOnly = (p: Pick<EmployeeProfile, 'tools'>) => !!p.tools && !p.tools.some(t => WRITE_TOOLS.includes(t));

function unquote(v: string): string {
  const s = v.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function toList(v: string | string[]): string[] {
  if (Array.isArray(v)) return v.map(unquote).filter(Boolean);
  const s = v.trim();
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  return inner.split(',').map(unquote).map(x => x.trim()).filter(Boolean);
}

/** 解析 YAML 头 + 正文。id 默认用文件名 */
export function parseProfile(id: string, text: string): EmployeeProfile {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  const head = m ? m[1] : '';
  const body = (m ? m[2] : src).trim();
  const fields: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of head.split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { (fields[listKey] as string[]).push(item[1]); continue; }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2].trim() === '') { listKey = kv[1]; fields[kv[1]] = []; }
    else { listKey = null; fields[kv[1]] = kv[2]; }
  }
  const str = (k: string) => (typeof fields[k] === 'string' ? unquote(fields[k] as string) : undefined);
  const list = (k: string) => (fields[k] !== undefined ? toList(fields[k]) : undefined);
  const effort = str('effort');
  const mode = str('permissionMode');
  const memory = str('memory');
  const name = str('name') || id;
  return {
    id: EMPLOYEE_ID.test(name) ? name : id,
    displayName: str('displayName') || name,
    description: str('description') ?? '',
    prompt: body,
    ...(list('tools') ? { tools: list('tools') } : {}),
    ...(list('disallowedTools') ? { disallowedTools: list('disallowedTools') } : {}),
    ...(str('model') ? { model: str('model') } : {}),
    ...(effort && EFFORT_VALUES.includes(effort) ? { effort: effort as Effort } : {}),
    ...(mode && (MODE_VALUES as string[]).includes(mode) ? { permissionMode: mode as EmployeeMode } : {}),
    ...(list('skills') ? { skills: list('skills') } : {}),
    memory: memory === 'none' || memory === 'false' ? null : memory === 'user' || memory === 'local' || memory === 'project' ? memory : memory === undefined ? null : 'project'
  };
}

/** YAML 里需要加引号的值 */
function yamlValue(v: string): string {
  return /^[\s'"[{>|*&!%@`#-]|[:#]\s|:$|\s$|^$|^(true|false|null|yes|no|~)$/i.test(v) || v.includes('\n') ? JSON.stringify(v) : v;
}

export function serializeProfile(p: EmployeeProfile): string {
  const lines = ['---', `name: ${p.id}`, `displayName: ${yamlValue(p.displayName)}`, `description: ${yamlValue(p.description.replace(/\s*\n\s*/g, ' '))}`];
  if (p.tools) lines.push(`tools: ${p.tools.join(', ')}`);
  if (p.disallowedTools?.length) lines.push(`disallowedTools: ${p.disallowedTools.join(', ')}`);
  if (p.model) lines.push(`model: ${p.model}`);
  if (p.effort) lines.push(`effort: ${p.effort}`);
  if (p.permissionMode) lines.push(`permissionMode: ${p.permissionMode}`);
  if (p.skills?.length) lines.push(`skills: [${p.skills.join(', ')}]`);
  if (p.memory) lines.push(`memory: ${p.memory}`);
  lines.push('---', '', p.prompt.trim(), '');
  return lines.join('\n');
}

/** 给 SDK 的 AgentDefinition（options.agents 里用） */
export function toAgentDefinition(p: EmployeeProfile) {
  return {
    description: p.description || p.displayName,
    prompt: p.prompt,
    ...(p.tools ? { tools: p.tools } : {}),
    // 员工不能直接问用户：信息不够时按最合理的假设去做，在汇报里说明
    disallowedTools: [...new Set([...(p.disallowedTools ?? []), 'AskUserQuestion'])],
    ...(p.model ? { model: p.model } : {}),
    ...(p.effort ? { effort: p.effort } : {}),
    ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}),
    ...(p.skills?.length ? { skills: p.skills } : {}),
    ...(p.memory ? { memory: p.memory } : {})
  };
}
