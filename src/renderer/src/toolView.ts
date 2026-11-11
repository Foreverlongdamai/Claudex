// 每种工具在活动记录里怎么显示：图标、动词、对象、附加信息、展开后显示什么。
import { diffLines } from 'diff';
import type { IconName } from './components/Icon';
import type { Item } from './timeline';

type ToolItem = Extract<Item, { kind: 'tool' }>;

export interface ToolView {
  icon: IconName;
  verb: string;
  running: string;
  target?: string;
  meta?: string;
  body: 'diff' | 'output' | 'markdown' | 'json' | 'none';
}

export interface DiffLine {
  type: ' ' | '+' | '-';
  oldNo?: number;
  newNo?: number;
  text: string;
}

const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/** 项目内的文件显示相对路径 */
export function relPath(file: string, projectPath: string): string {
  const f = file.replace(/\\/g, '/');
  const p = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
  return f.toLowerCase().startsWith(p.toLowerCase() + '/') ? f.slice(p.length + 1) : f;
}

const firstLine = (text: string, max = 120) => {
  const line = text.split(/\r?\n/)[0] ?? '';
  return line.length > max ? line.slice(0, max) + '…' : line + (text.includes('\n') ? ' …' : '');
};

/** 改动的行：优先用 Claude Code 返回的结构化补丁（带真实行号），没有就自己算 */
export function editDiff(item: ToolItem): DiffLine[] {
  const patch = (item.extra as { structuredPatch?: Array<{ oldStart: number; newStart: number; lines: string[] }> } | undefined)?.structuredPatch;
  if (Array.isArray(patch) && patch.length) {
    const out: DiffLine[] = [];
    for (const hunk of patch) {
      let o = hunk.oldStart;
      let n = hunk.newStart;
      for (const line of hunk.lines) {
        const type = line[0] === '+' ? '+' : line[0] === '-' ? '-' : ' ';
        out.push({ type, oldNo: type === '+' ? undefined : o, newNo: type === '-' ? undefined : n, text: line.slice(1) });
        if (type !== '+') o++;
        if (type !== '-') n++;
      }
    }
    return out;
  }
  const input = item.input;
  if (item.name === 'Write') {
    return s(input.content).split(/\r?\n/).map((text, i) => ({ type: '+' as const, newNo: i + 1, text }));
  }
  const pairs: Array<[string, string]> = Array.isArray(input.edits)
    ? (input.edits as Array<Record<string, unknown>>).map(e => [s(e.old_string), s(e.new_string)])
    : [[s(input.old_string), s(input.new_string)]];
  const out: DiffLine[] = [];
  for (const [a, b] of pairs) {
    for (const part of diffLines(a, b)) {
      const type = part.added ? '+' : part.removed ? '-' : ' ';
      for (const text of part.value.replace(/\n$/, '').split('\n')) out.push({ type, text });
    }
  }
  return out;
}

export function diffStat(lines: DiffLine[]): { add: number; del: number } {
  return { add: lines.filter(l => l.type === '+').length, del: lines.filter(l => l.type === '-').length };
}

export function describeTool(item: ToolItem, projectPath: string): ToolView {
  const input = item.input;
  const file = s(input.file_path || input.notebook_path || input.path);
  switch (item.name) {
    case 'Read': {
      const lines = item.output ? item.output.split('\n').length : undefined;
      return { icon: 'file', verb: '已读取', running: '正在读取', target: relPath(file, projectPath), meta: lines ? `${lines} 行` : undefined, body: 'output' };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const { add, del } = diffStat(editDiff(item));
      const verb = item.name === 'Write' ? '已写入' : '已编辑';
      return { icon: 'pen', verb, running: item.name === 'Write' ? '正在写入' : '正在编辑', target: relPath(file, projectPath), meta: `+${add} −${del}`, body: item.name === 'NotebookEdit' ? 'json' : 'diff' };
    }
    case 'Bash':
    case 'PowerShell':
      return { icon: 'term', verb: '已运行', running: '正在运行', target: firstLine(s(input.command)), meta: s(input.description) || undefined, body: 'output' };
    case 'Grep':
      return { icon: 'search', verb: '已搜索', running: '正在搜索', target: `"${s(input.pattern)}"${input.path ? ' · ' + relPath(s(input.path), projectPath) : ''}`, body: 'output' };
    case 'Glob':
      return { icon: 'search', verb: '已查找文件', running: '正在查找文件', target: s(input.pattern), body: 'output' };
    case 'WebSearch':
      return { icon: 'globe', verb: '已搜索网页', running: '正在搜索网页', target: s(input.query), body: 'output' };
    case 'WebFetch':
      return { icon: 'globe', verb: '已读取网页', running: '正在读取网页', target: s(input.url), body: 'output' };
    case 'Agent':
    case 'Task':
      return { icon: 'spark', verb: '子代理已完成', running: '子代理正在处理', target: s(input.description) || firstLine(s(input.prompt), 60), meta: item.subSteps ? `${item.subSteps} 步` : undefined, body: 'markdown' };
    case 'Skill':
      return { icon: 'spark', verb: '已使用 Skill', running: '正在使用 Skill', target: s(input.skill || input.command || input.name), body: 'output' };
    case 'ExitPlanMode':
      return { icon: 'plan', verb: '提交了计划', running: '正在提交计划', body: 'markdown' };
    case 'AskUserQuestion': {
      const q = (input.questions as Array<{ question: string }> | undefined)?.[0]?.question;
      return { icon: 'ask', verb: '提了问题', running: '正在提问', target: q, body: 'output' };
    }
    case 'ToolSearch':
      return { icon: 'search', verb: '已查找工具', running: '正在查找工具', target: s(input.query), body: 'none' };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { icon: 'listcheck', verb: '已更新计划', running: '正在更新计划', body: 'none' };
    default: {
      if (item.name.startsWith('mcp__')) {
        const [, server, ...tool] = item.name.split('__');
        return { icon: 'plug', verb: '已调用', running: '正在调用', target: `${server} · ${tool.join('__')}`, body: 'json' };
      }
      return { icon: 'dots', verb: `已使用 ${item.name}`, running: `正在使用 ${item.name}`, body: 'json' };
    }
  }
}

/** TodoWrite 的待办清单 */
export function todosOf(item: ToolItem): Array<{ content: string; status: string }> | null {
  const todos = item.input.todos;
  return Array.isArray(todos) ? (todos as Array<{ content: string; status: string }>) : null;
}
