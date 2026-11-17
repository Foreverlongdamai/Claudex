// 附件（原地引用的文件路径）的单元测试：发送时怎么包、显示和打开历史时怎么拆、文件类型识别。
// 运行：npm run test:unit
import { ATTACHMENTS_ONLY_PROMPT, baseName, fileKind, splitAttachments, withAttachments } from '../../src/shared/attachments.ts';
import { applySdk, emptyTimeline } from '../../src/renderer/src/timeline.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};

const files = [
  { path: 'D:\\资料\\会议 记录.docx', name: '会议 记录.docx', size: 1000 },
  { path: 'C:\\Users\\long\\Music\\录音 (1).m4a', name: '录音 (1).m4a', size: 5_000_000 }
];

// 1. 没有附件：原样返回
check('没有附件时原样返回', withAttachments('你好', []) === '你好');

// 2. 包起来再拆开，路径（含空格、中文、括号）和正文都原样回来
const wrapped = withAttachments('帮我总结一下', files);
check('附件块在消息开头', wrapped.startsWith('<claudex-attachments>\n'), wrapped);
check('每个附件一行完整路径', wrapped.includes('- D:\\资料\\会议 记录.docx\n') && wrapped.includes('- C:\\Users\\long\\Music\\录音 (1).m4a\n'), wrapped);
const back = splitAttachments(wrapped);
check('拆出来的正文', back.text === '帮我总结一下', back.text);
check('拆出来的路径', JSON.stringify(back.files) === JSON.stringify(files.map(f => f.path)), back.files);

// 3. 只发附件、没写字：替用户补一句
const onlyFiles = withAttachments('   ', files);
check('只有附件时补一句说明', splitAttachments(onlyFiles).text === ATTACHMENTS_ONLY_PROMPT, onlyFiles);

// 4. 没有附件块、或者附件块不在开头：不动
check('普通消息不受影响', JSON.stringify(splitAttachments('普通消息')) === JSON.stringify({ text: '普通消息', files: [] }));
const quoted = '我在讨论这个格式：<claudex-attachments>\n- x\n</claudex-attachments>';
check('附件块不在开头时不拆', splitAttachments(quoted).files.length === 0 && splitAttachments(quoted).text === quoted);

// 5. Windows 换行（\r\n）也能拆
const crlf = wrapped.replace(/\n/g, '\r\n');
const backCrlf = splitAttachments(crlf);
check('CRLF 换行也能拆', backCrlf.files.length === 2 && backCrlf.files[0] === files[0].path && backCrlf.text === '帮我总结一下', backCrlf);

// 6. 打开历史对话：Skills 配置模式的包装 + 附件块，都要拆掉，附件变成小卡片
const historyText = `<claudex-mode name="skills">流程说明……</claudex-mode>\n${wrapped}`;
const t = applySdk(emptyTimeline(), { type: 'user', message: { role: 'user', content: historyText } } as never, false);
const u = t.items[0];
check('历史消息：正文只剩用户写的字', u?.kind === 'user' && u.text === '帮我总结一下', u);
check('历史消息：附件路径被识别出来', u?.kind === 'user' && u.files.length === 2 && u.files[1] === files[1].path, u);
check('历史消息：Skills 配置模式标记还在', u?.kind === 'user' && u.skillsMode);

// 7. 只有附件的历史消息不会被当成空消息丢掉
const t2 = applySdk(emptyTimeline(), { type: 'user', message: { role: 'user', content: onlyFiles } } as never, false);
check('只有附件的历史消息也显示', t2.items.length === 1 && t2.items[0].kind === 'user' && t2.items[0].files.length === 2, t2.items);

// 8. 文件名和类型
check('baseName：反斜杠路径', baseName('D:\\a\\b\\报告.pdf') === '报告.pdf');
check('baseName：正斜杠和末尾斜杠', baseName('/d/a/文件夹/') === '文件夹');
const kinds: Array<[string, string]> = [['a.DOCX', 'doc'], ['b.doc', 'doc'], ['c.xls', 'sheet'], ['d.pptx', 'slides'], ['e.pdf', 'pdf'],
  ['f.m4a', 'audio'], ['g.MP3', 'audio'], ['h.mkv', 'video'], ['i.webp', 'image'], ['j.zip', 'other'], ['没有扩展名', 'other']];
for (const [name, kind] of kinds) check(`fileKind(${name})`, fileKind(name) === kind, fileKind(name));
check('文件夹', fileKind('资料', true) === 'folder');

console.log(`--- 附件：${total - failed}/${total} 通过`);
process.exit(failed ? 1 : 0);
