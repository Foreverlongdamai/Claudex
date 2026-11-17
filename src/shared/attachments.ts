// 拖进来（或用 + 选的）非图片文件：不复制、不上传内容，消息里只带完整路径（原地引用）。
// Claude 按全局规则 ~/.claude/CLAUDE.md 用对应的工具读（doc2md、audio-transcribe、Read……）。
// 发送时把路径包在 <claudex-attachments> 里放在消息开头；显示时再拆出来，画成文件小卡片。
import type { FileAttachment } from './types';

const OPEN = '<claudex-attachments>';
const CLOSE = '</claudex-attachments>';
const BLOCK = /^<claudex-attachments>\r?\n[^\n]*\r?\n((?:- [^\n]*\r?\n)*)<\/claudex-attachments>\r?\n?/;

/** 只发了附件、没写字时，替用户说一句 */
export const ATTACHMENTS_ONLY_PROMPT = '请阅读这些文件，简要说明内容。';

export function withAttachments(text: string, files: FileAttachment[]): string {
  if (!files.length) return text;
  const block = `${OPEN}\n用户附加了这些本地文件（完整路径）：\n${files.map(f => `- ${f.path}\n`).join('')}${CLOSE}`;
  return `${block}\n${text.trim() ? text : ATTACHMENTS_ONLY_PROMPT}`;
}

/** 把消息开头的附件块拆出来：返回去掉附件块的正文和附件路径 */
export function splitAttachments(text: string): { text: string; files: string[] } {
  const m = BLOCK.exec(text);
  if (!m) return { text, files: [] };
  const files = m[1].split(/\r?\n/).filter(Boolean).map(l => l.slice(2).trim());
  return { text: text.slice(m[0].length), files };
}

/** 路径的最后一段（Windows 和 / 分隔都认） */
export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

export type FileKind = 'doc' | 'sheet' | 'slides' | 'pdf' | 'audio' | 'video' | 'image' | 'folder' | 'other';

const KINDS: Record<string, FileKind> = {};
const reg = (kind: FileKind, exts: string) => exts.split(' ').forEach(e => { KINDS[e] = kind; });
reg('doc', 'doc docx rtf odt wps txt md');
reg('sheet', 'xls xlsx csv ods et');
reg('slides', 'ppt pptx odp dps');
reg('pdf', 'pdf');
reg('audio', 'mp3 wav m4a aac flac ogg opus wma amr');
reg('video', 'mp4 mov mkv avi webm');
reg('image', 'png jpg jpeg gif webp bmp');

export function fileKind(name: string, isDir = false): FileKind {
  if (isDir) return 'folder';
  const ext = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return KINDS[ext] ?? 'other';
}
