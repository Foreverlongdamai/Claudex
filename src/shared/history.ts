// 对话历史（M2）：把 Claude Code 的会话记录变成给人看的文字稿，用来导出 Markdown / HTML 和全文搜索。
// 纯函数，不依赖 Node，单元测试直接跑。
import { splitAttachments } from './attachments.ts';
import { parseTeamMessage } from './conv.ts';

export type SessionLike = { type: string; message?: unknown; parent_tool_use_id?: string | null; [k: string]: unknown };

export interface TranscriptEntry {
  /** user 你说的；assistant Claude 的回复；task 派给员工的任务；result 员工交回的结果 */
  role: 'user' | 'assistant' | 'task' | 'result';
  text: string;
  /** Claude 这一段里用过的工具（一行一个） */
  tools: string[];
  /** 用户消息带的文件 */
  files: string[];
  /** 团队消息：员工名字、任务标题 */
  who?: string;
}

const MODE_WRAPPER = /^<claudex-mode name="[^"]+">[\s\S]*?<\/claudex-mode>\s*/;

function blocks(message: unknown): Array<Record<string, unknown>> {
  const c = (message as { content?: unknown } | undefined)?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? (c as Array<Record<string, unknown>>) : [];
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** 工具调用的一行说明：Bash: npm test、Edit: src/a.ts */
export function describeToolUse(name: string, input: Record<string, unknown> = {}): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const key = pick('command') || pick('file_path') || pick('notebook_path') || pick('pattern') || pick('url') || pick('query') || pick('skill') || pick('description') || pick('title');
  const short = name.startsWith('mcp__') ? name.split('__').slice(1).join('.') : name;
  return key ? `${short}: ${clip(key.replace(/\s+/g, ' ').trim(), 160)}` : short;
}

/** 会话记录 → 文字稿（子代理内部的消息、工具结果、系统消息不要） */
export function toTranscript(history: SessionLike[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const m of history) {
    if (m.parent_tool_use_id) continue;
    if (m.type === 'user') {
      const bs = blocks(m.message);
      if (bs.some(b => b.type === 'tool_result')) continue;
      const raw = bs.map(b => (b.type === 'text' ? String(b.text ?? '') : b.type === 'image' ? '[图片]' : '')).filter(Boolean).join('\n');
      if (!raw.trim() || /^\[Request interrupted/i.test(raw) || /^\s*<(local-command|command-name|system-reminder)/.test(raw)) continue;
      const team = parseTeamMessage(raw);
      if (team) {
        const a = team.attrs;
        out.push(team.kind === 'task'
          ? { role: 'task', text: team.body.trim(), tools: [], files: [], who: `#${a.id} ${a.title ?? ''}`.trim() }
          : { role: 'result', text: team.body.trim(), tools: [], files: [], who: `${a.name ?? a.employee ?? '员工'} 交回 #${a.id}${a.title ? ` ${a.title}` : ''}` });
        continue;
      }
      const { text, files } = splitAttachments(raw.replace(MODE_WRAPPER, ''));
      out.push({ role: 'user', text: text.trim(), tools: [], files });
    } else if (m.type === 'assistant') {
      let last = out[out.length - 1];
      if (!last || last.role !== 'assistant') {
        last = { role: 'assistant', text: '', tools: [], files: [] };
        out.push(last);
      }
      for (const b of blocks(m.message)) {
        if (b.type === 'text' && String(b.text ?? '').trim()) last.text = last.text ? `${last.text}\n\n${String(b.text).trim()}` : String(b.text).trim();
        else if (b.type === 'tool_use' || b.type === 'server_tool_use') last.tools.push(describeToolUse(String(b.name ?? ''), (b.input ?? {}) as Record<string, unknown>));
      }
    }
  }
  return out.filter(e => e.text || e.tools.length || e.files.length);
}

export interface ExportInfo {
  title: string;
  project: string;
  /** 导出时刻（毫秒） */
  at: number;
  model?: string;
}

const stampOf = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const ROLE_TITLE = (e: TranscriptEntry) => (e.role === 'user' ? '你' : e.role === 'assistant' ? 'Claude' : e.role === 'task' ? `派给员工的任务 ${e.who ?? ''}`.trim() : e.who ?? '员工交回的结果');

export function toMarkdown(info: ExportInfo, entries: TranscriptEntry[]): string {
  const lines = [`# ${info.title}`, '', `> 项目：${info.project} · 导出于 ${stampOf(info.at)}${info.model ? ` · 模型：${info.model}` : ''}（Claudex）`, ''];
  for (const e of entries) {
    lines.push(`## ${ROLE_TITLE(e)}`, '');
    if (e.files.length) lines.push(...e.files.map(f => `- 附件：\`${f}\``), '');
    if (e.tools.length) lines.push(...e.tools.map(t => `- 🔧 \`${t.replace(/`/g, "'")}\``), '');
    if (e.text) lines.push(e.text, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 很简单的 Markdown → HTML：代码块、行内代码、粗体、标题、列表、段落（够看就行，不依赖库） */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  const parts = md.split(/^```[^\n]*\n([\s\S]*?)^```\s*$/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { out.push(`<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`); return; }
    const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    for (const para of part.split(/\n{2,}/)) {
      const p = para.trim();
      if (!p) continue;
      const h = /^(#{1,6})\s+(.*)$/.exec(p);
      if (h && !p.includes('\n')) { out.push(`<h${Math.min(6, h[1].length + 2)}>${inline(h[2])}</h${Math.min(6, h[1].length + 2)}>`); continue; }
      const ls = p.split('\n');
      if (ls.every(l => /^\s*([-*]|\d+\.)\s+/.test(l))) { out.push(`<ul>${ls.map(l => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('')}</ul>`); continue; }
      out.push(`<p>${ls.map(inline).join('<br>')}</p>`);
    }
  });
  return out.join('\n');
}

export function toHtml(info: ExportInfo, entries: TranscriptEntry[]): string {
  const body = entries.map(e => `<section class="${e.role}"><h2>${esc(ROLE_TITLE(e))}</h2>` +
    (e.files.length ? `<ul class="files">${e.files.map(f => `<li>附件：<code>${esc(f)}</code></li>`).join('')}</ul>` : '') +
    (e.tools.length ? `<ul class="tools">${e.tools.map(t => `<li><code>${esc(t)}</code></li>`).join('')}</ul>` : '') +
    (e.text ? `<div class="text">${mdToHtml(e.text)}</div>` : '') + '</section>').join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(info.title)}</title>
<style>
body{font:15px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:860px;margin:0 auto;padding:24px 16px;color:#1b1b1b;background:#fff}
h1{font-size:22px;margin:0 0 4px}.meta{color:#777;font-size:13px;margin-bottom:24px}
section{border-top:1px solid #eee;padding:12px 0}section h2{font-size:13px;color:#777;margin:0 0 6px;font-weight:600}
section.user{background:#f6f6f6;border-radius:10px;padding:12px 14px;border:0;margin:10px 0}
section.task,section.result{background:#f2f7ff;border-radius:10px;padding:12px 14px;border:0;margin:10px 0}
ul.tools,ul.files{list-style:none;padding:0;margin:0 0 6px;color:#666;font-size:13px}ul.tools li::before{content:"🔧 "}
pre{background:#f4f4f4;padding:10px 12px;border-radius:8px;overflow:auto}code{font-family:Consolas,"Cascadia Mono",monospace;font-size:13px}
@media (prefers-color-scheme:dark){body{background:#1b1b1b;color:#ececec}section{border-color:#333}section.user{background:#262626}section.task,section.result{background:#1f2a38}pre{background:#262626}.meta,section h2,ul.tools,ul.files{color:#999}}
</style></head><body>
<h1>${esc(info.title)}</h1>
<div class="meta">项目：${esc(info.project)} · 导出于 ${stampOf(info.at)}${info.model ? ` · 模型：${esc(info.model)}` : ''}（Claudex）</div>
${body}
</body></html>
`;
}

/** 搜索用的纯文字（小写）：你说的、Claude 回复的、团队消息；不含工具输出 */
export function searchableText(entries: TranscriptEntry[]): string {
  return entries.map(e => [e.text, ...e.files, ...e.tools].join('\n')).join('\n').toLowerCase();
}

/** 在文字里找关键词，返回前后各一段的摘录（找不到返回 null） */
export function snippet(text: string, query: string, radius = 40): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + q.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}
