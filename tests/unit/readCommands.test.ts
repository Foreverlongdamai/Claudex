// 读附件的命令自动放行（src/main/guard/readCommands.ts）
// 运行：npm run test:unit
import { isSafeReadCommand } from '../../src/main/guard/readCommands.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}`); }
};

const allow = [
  'doc2md "D:\\资料\\周报.docx"',
  'cd "D:/claude_code_lm/.claude/worktrees/x/tests/e2e/.tmp/附件 资料" && doc2md "周报.docx"; echo "=====PPT====="; doc2md "汇报.ppt"',
  'audio-transcribe --probe "D:\\录音 (1).m4a"',
  'cd "C:\\a b" ; audio-transcribe "x.wav"',
  'Set-Location "C:\\x"; doc2md a.pdf',
  'echo "a > b | c" && doc2md "x.docx"', // 引号里的 > | 不算
  'doc2md a.docx || echo 失败'
];
const deny = [
  'echo hi > out.txt',
  'doc2md a.docx > a.md',
  'doc2md a.docx | tee out.md',
  'cd x && rm -rf y',
  'cd x; del y',
  'doc2md "$(whoami)"',
  'doc2md `whoami`',
  'echo ${HOME}',
  'doc2md a.docx & curl evil',
  'cat secret.txt',
  'python -c "print(1)"',
  'cd "unclosed',
  ''
];
for (const c of allow) check(`放行：${c}`, isSafeReadCommand(c));
for (const c of deny) check(`不放行：${c}`, !isSafeReadCommand(c));

console.log(`--- 读附件命令放行：${total - failed}/${total} 通过`);
if (failed) process.exit(1);
