// git diff 解析的单元测试：在临时仓库里造出各种改动，用真实的 git 输出来验证。
// 运行：npm run test:unit
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addedFileDiff, looksBinary, parseDiff, unquoteGitPath, type DiffFile } from '../../src/shared/gitDiff.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-gitdiff-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const write = (f: string, s: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
const DIFF = ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', 'diff', '--no-color', '--no-ext-diff', '--find-renames', '-U3', '--src-prefix=a/', '--dst-prefix=b/'];

try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'core.autocrlf', 'false');
  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  write('src/a.js', long);
  write('del.txt', 'bye\n');
  write('old name.txt', 'some content that stays the same\nsecond line\nthird line\n');
  write('中文/说明.md', '第一行\n');
  write('crlf.txt', 'one\r\ntwo\r\n');
  write('nonl.txt', 'no newline');
  write('img.bin', Buffer.from([0, 1, 2, 3, 0, 5]));
  write('dash.txt', '-- keep\n--- tricky\nend\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  // 两个段落的修改
  write('src/a.js', long.replace('line 2\n', 'line 2 changed\n').replace('line 28\n', 'line 28\ninserted\n'));
  fs.rmSync(path.join(dir, 'del.txt'));
  fs.renameSync(path.join(dir, 'old name.txt'), path.join(dir, 'new name.txt'));
  write('中文/说明.md', '第一行\n第二行\n');
  write('crlf.txt', 'one\r\nTWO\r\n');
  write('nonl.txt', 'no newline, changed');
  write('img.bin', Buffer.from([0, 9, 9, 9, 0, 5]));
  write('dash.txt', '-- keep\nend\n');
  write('added.txt', 'brand new\nfile\n');
  git('add', '-A');
  const files = parseDiff(git(...DIFF, '--cached'));
  const by = (p: string) => files.find(f => f.path === p) as DiffFile;

  check('文件数', files.length === 9, files.map(f => f.path));
  const a = by('src/a.js');
  check('修改：两个段落', a?.change === 'modified' && a.lines.filter(l => l.type === '@').length === 2, a?.lines.filter(l => l.type === '@'));
  check('修改：行数统计', a?.add === 2 && a.del === 1, a && { add: a.add, del: a.del });
  const changed = a?.lines.find(l => l.type === '+' && l.text === 'line 2 changed');
  check('修改：新增行带新行号', changed?.newNo === 2 && changed.oldNo === undefined, changed);
  const removed = a?.lines.find(l => l.type === '-');
  check('修改：删除行带旧行号', removed?.oldNo === 2 && removed.text === 'line 2', removed);
  const ctx = a?.lines.find(l => l.type === ' ' && l.text === 'line 30');
  check('修改：后面段落的上下文行号', ctx?.oldNo === 30 && ctx.newNo === 31, ctx);

  const d = by('del.txt');
  check('删除的文件', d?.change === 'deleted' && d.del === 1 && d.add === 0, d);
  const r = by('new name.txt');
  check('重命名：带空格的路径', r?.change === 'renamed' && r.oldPath === 'old name.txt' && r.lines.length === 0, r);
  const zh = by('中文/说明.md');
  check('中文路径', zh?.change === 'modified' && zh.add === 1, zh);
  const crlf = by('crlf.txt');
  check('CRLF 文件去掉行尾的 \\r', crlf?.lines.some(l => l.type === '+' && l.text === 'TWO') && !crlf.lines.some(l => l.text.endsWith('\r')), crlf?.lines);
  const nonl = by('nonl.txt');
  check('末尾没有换行：不把提示当成内容', nonl?.add === 1 && nonl.del === 1 && nonl.lines.every(l => !l.text.includes('No newline')), nonl?.lines);
  const bin = by('img.bin');
  check('二进制文件', bin?.binary === true && bin.lines.length === 0, bin);
  const dash = by('dash.txt');
  check('删掉的行以 --- 开头也不会被当成文件头', dash?.del === 1 && dash.lines.some(l => l.type === '-' && l.text === '--- tricky') && files.length === 9, dash?.lines);
  const add = by('added.txt');
  check('新文件', add?.change === 'added' && add.add === 2 && add.lines[1]?.newNo === 1, add);

  // core.quotepath=true（默认）时中文路径会被转义，也要能还原
  const quoted = parseDiff(execFileSync('git', ['diff', '--no-color', '--cached', '--src-prefix=a/', '--dst-prefix=b/', '--', '中文'], { cwd: dir, encoding: 'utf8' }));
  check('转义过的中文路径能还原', quoted[0]?.path === '中文/说明.md', quoted.map(f => f.path));

  // 二进制的新文件：没有 ---/+++ 行，路径只能从 diff --git 头里拿
  git('commit', '-q', '-m', 'second');
  write('pics/new pic.png', Buffer.from([137, 80, 0, 1]));
  git('add', '-A');
  const nb = parseDiff(git(...DIFF, '--cached'));
  check('二进制新文件（路径带空格）', nb.length === 1 && nb[0].path === 'pics/new pic.png' && nb[0].change === 'added' && nb[0].binary, nb);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 手写的边界情况
check('unquote：八进制 UTF-8', unquoteGitPath('"a/\\344\\270\\255.txt"') === 'a/中.txt');
check('unquote：转义的引号和反斜杠', unquoteGitPath('"a/x\\"y\\\\z"') === 'a/x"y\\z');
check('unquote：没有引号原样返回', unquoteGitPath('a/b c') === 'a/b c');
const hand = parseDiff([
  'diff --git "a/q\\"x.txt" "b/q\\"x.txt"',
  'index 1..2 100644',
  '--- "a/q\\"x.txt"',
  '+++ "b/q\\"x.txt"',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  ''
].join('\n'));
check('带引号的路径', hand[0]?.path === 'q"x.txt' && hand[0].add === 1 && hand[0].del === 1, hand);
const modeOnly = parseDiff('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n');
check('只改了权限', modeOnly.length === 1 && modeOnly[0].path === 'run.sh' && modeOnly[0].lines.length === 0, modeOnly);

const nf = addedFileDiff('x.txt', 'a\r\nb\r\n');
check('新文件 diff：行和行号', nf.add === 2 && nf.lines[0].type === '@' && nf.lines[2].newNo === 2 && nf.lines[2].text === 'b', nf);
check('新文件 diff：空文件', addedFileDiff('e.txt', '').lines.length === 0);
check('二进制判断', looksBinary(new Uint8Array([65, 0, 66])) && !looksBinary(new TextEncoder().encode('普通文本')));

console.log(`--- git diff 解析：${total - failed}/${total} 通过`);
if (failed) process.exit(1);
