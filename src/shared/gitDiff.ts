// 解析 git diff 的输出（统一格式），给改动面板用。纯函数、不依赖 Node 和 React，单元测试直接跑。
// 调用方要用这些参数跑 git：-c core.quotepath=false diff --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/

export type DiffLineType = ' ' | '+' | '-' | '@';

export interface DiffLine {
  /** ' ' 没变的行，'+' 新增，'-' 删除，'@' 段落分隔（@@ -1,3 +1,4 @@） */
  type: DiffLineType;
  oldNo?: number;
  newNo?: number;
  text: string;
}

export type FileChange = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  /** 相对仓库根目录的路径（删除的文件是原来的路径） */
  path: string;
  /** 重命名前的路径 */
  oldPath?: string;
  change: FileChange;
  binary: boolean;
  add: number;
  del: number;
  lines: DiffLine[];
  /** 改动太多，没带上具体的行 */
  tooLarge?: boolean;
}

/** git 给特殊路径加的 C 风格引号："a/\344\270\255.txt" → a/中.txt */
export function unquoteGitPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const chars = Array.from(s.slice(1, -1));
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const ESC: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c !== '\\') { bytes.push(...enc.encode(c)); continue; }
    const n = chars[++i] ?? '';
    if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(chars[i + 1] ?? '')) oct += chars[++i];
      bytes.push(parseInt(oct, 8));
    } else {
      bytes.push(ESC[n] ?? n.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** "--- a/路径" 里的路径；/dev/null 返回 null。路径里有空格时 git 会在末尾加一个 Tab */
function sidePath(raw: string): string | null {
  const s = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (s === '/dev/null') return null;
  const p = unquoteGitPath(s);
  return /^[ab]\//.test(p) ? p.slice(2) : p;
}

/** "diff --git a/X b/Y" 里的两个路径（没有 ---/+++ 行的文件，比如二进制、纯重命名、只改了权限，只能从这里拿） */
function headerPaths(header: string): { a: string; b: string } | null {
  if (header.startsWith('"')) {
    const end = header.indexOf('" ', 1);
    if (end < 0) return null;
    const a = unquoteGitPath(header.slice(0, end + 1));
    const rest = header.slice(end + 2);
    return { a: a.replace(/^a\//, ''), b: unquoteGitPath(rest).replace(/^b\//, '') };
  }
  if (header.endsWith('"')) {
    const start = header.lastIndexOf(' "');
    if (start < 0) return null;
    return { a: header.slice(0, start).replace(/^a\//, ''), b: unquoteGitPath(header.slice(start + 1)).replace(/^b\//, '') };
  }
  // 两边路径一样（最常见）：a/P b/P，正好从中间分开
  if ((header.length - 5) % 2 === 0) {
    const len = (header.length - 5) / 2;
    const a = header.slice(2, 2 + len);
    if (header === `a/${a} b/${a}`) return { a, b: a };
  }
  const i = header.indexOf(' b/');
  return i < 0 ? null : { a: header.slice(2, i), b: header.slice(i + 3) };
}

interface Building extends DiffFile {
  sideA?: string | null;
  sideB?: string | null;
  header: { a: string; b: string } | null;
}

function finish(f: Building): DiffFile {
  let p = f.path;
  if (f.change === 'deleted') p = f.sideA ?? f.header?.a ?? p;
  else p = f.sideB ?? f.header?.b ?? p;
  const out: DiffFile = { path: p, change: f.change, binary: f.binary, add: 0, del: 0, lines: f.lines };
  if (f.change === 'renamed') out.oldPath = f.oldPath ?? f.sideA ?? f.header?.a;
  for (const l of f.lines) {
    if (l.type === '+') out.add++;
    else if (l.type === '-') out.del++;
  }
  return out;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: Building | null = null;
  // 当前段落里还剩多少行没读（按段落头里的行数算，这样删掉的 "--- xx" 这种行不会被当成文件头）
  let oldLeft = 0;
  let newLeft = 0;
  let o = 0;
  let n = 0;
  for (const raw of text.split('\n')) {
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      const c = raw[0];
      const body = raw.slice(1).replace(/\r$/, '');
      if (c === ' ' || (raw === '' && oldLeft > 0 && newLeft > 0)) {
        cur.lines.push({ type: ' ', oldNo: o++, newNo: n++, text: body });
        oldLeft--; newLeft--;
        continue;
      }
      if (c === '-') { cur.lines.push({ type: '-', oldNo: o++, text: body }); oldLeft--; continue; }
      if (c === '+') { cur.lines.push({ type: '+', newNo: n++, text: body }); newLeft--; continue; }
      if (c === '\\') continue; // \ No newline at end of file
      oldLeft = newLeft = 0; // 输出不完整：当成段落结束
    }
    if (raw.startsWith('diff --git ')) {
      if (cur) files.push(finish(cur));
      const header = headerPaths(raw.slice(11));
      cur = { path: header?.b ?? '', change: 'modified', binary: false, add: 0, del: 0, lines: [], header };
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('@@')) {
      const m = HUNK.exec(raw);
      if (!m) continue;
      o = Number(m[1]);
      n = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      cur.lines.push({ type: '@', text: raw.replace(/\r$/, '') });
      continue;
    }
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('new file mode')) cur.change = 'added';
    else if (raw.startsWith('deleted file mode')) cur.change = 'deleted';
    else if (raw.startsWith('rename from ')) { cur.change = 'renamed'; cur.oldPath = unquoteGitPath(raw.slice(12)); }
    else if (raw.startsWith('rename to ')) { cur.change = 'renamed'; cur.path = unquoteGitPath(raw.slice(10)); cur.sideB = cur.path; }
    else if (raw.startsWith('copy to ')) { cur.change = 'added'; cur.path = unquoteGitPath(raw.slice(8)); cur.sideB = cur.path; }
    else if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') cur.binary = true;
    else if (raw.startsWith('--- ')) { const p = sidePath(raw.slice(4)); if (p === null) cur.change = 'added'; else cur.sideA = p; }
    else if (raw.startsWith('+++ ')) { const p = sidePath(raw.slice(4)); if (p === null) cur.change = 'deleted'; else cur.sideB = p; }
  }
  if (cur) files.push(finish(cur));
  return files;
}

/** 新文件（还没被 git 跟踪的）的内容做成全是新增行的 diff */
export function addedFileDiff(path: string, content: string): DiffFile {
  const text = content.replace(/\r\n/g, '\n');
  const rows = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const lines: DiffLine[] = rows.length ? [{ type: '@', text: `@@ -0,0 +1,${rows.length} @@` }] : [];
  rows.forEach((t, i) => lines.push({ type: '+', newNo: i + 1, text: t }));
  return { path, change: 'added', binary: false, add: rows.length, del: 0, lines };
}

/** 内容里有 NUL 字节就当成二进制（和 git 的判断方法一样，只看前 8000 字节） */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}
