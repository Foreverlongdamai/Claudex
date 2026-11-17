// 对话历史的文字稿、导出、搜索摘录（src/shared/history.ts）。
// 运行：npm run test:unit
import { describeToolUse, mdToHtml, searchableText, snippet, toHtml, toMarkdown, toTranscript } from '../../src/shared/history.ts';
import { wrapResult, wrapTask } from '../../src/shared/conv.ts';
import { withAttachments } from '../../src/shared/attachments.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const asst = (...content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content } });

const history = [
  { type: 'system', subtype: 'init' },
  user('<claudex-mode name="skills">\n很长的流程说明\n</claudex-mode>\n\n帮我看看 README'),
  asst({ type: 'thinking', thinking: '想一想' }, { type: 'text', text: '好的，我先读一下。' }),
  asst({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'D:\\p\\README.md' } }),
  user([{ type: 'tool_result', tool_use_id: 't1', content: '# 项目' }]),
  asst({ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm   test' } }),
  { type: 'assistant', parent_tool_use_id: 'agent1', message: { content: [{ type: 'text', text: '子代理内部' }] } },
  user([{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }]),
  asst({ type: 'text', text: 'README 写的是 **示例项目**。\n\n```js\nconsole.log(1 < 2)\n```' }),
  user('[Request interrupted by user]'),
  user(withAttachments('看看这个文件', [{ path: 'D:\\docs\\a.pdf', name: 'a.pdf', size: 1, kind: 'pdf' } as never])),
  user(wrapTask({ id: '3', from: '主对话', title: '翻译' }, '把“你好”翻成英文')),
  user(wrapResult({ id: '3', employee: 'translator', name: '小李', status: 'done', title: '翻译' }, 'Hello'))
];

const tr = toTranscript(history as never);
check('文字稿的条目', JSON.stringify(tr.map(e => e.role)) === JSON.stringify(['user', 'assistant', 'user', 'task', 'result']), tr.map(e => e.role));
check('去掉 Skills 配置模式的说明', tr[0].text === '帮我看看 README', tr[0].text);
check('Claude 连续几条合成一段：文字和用过的工具', tr[1].text.startsWith('好的，我先读一下。\n\nREADME 写的是') && JSON.stringify(tr[1].tools) === JSON.stringify(['Read: D:\\p\\README.md', 'Bash: npm test']), tr[1]);
check('不要思考过程、工具结果、子代理内部、“已停止”', !JSON.stringify(tr).includes('想一想') && !JSON.stringify(tr).includes('子代理内部') && !JSON.stringify(tr).includes('Request interrupted'));
check('附件单独列出', tr[2].text === '看看这个文件' && tr[2].files[0] === 'D:\\docs\\a.pdf', tr[2]);
check('团队消息：任务和结果', tr[3].text === '把“你好”翻成英文' && tr[3].who === '#3 翻译' && tr[4].text === 'Hello' && tr[4].who === '小李 交回 #3 翻译', [tr[3], tr[4]]);

check('describeToolUse', describeToolUse('mcp__claudex__assign_task', { title: '翻译' }) === 'claudex.assign_task: 翻译' && describeToolUse('TodoWrite', {}) === 'TodoWrite');

const info = { title: '看 README', project: 'demo', at: new Date(2026, 10, 17, 9, 5).getTime(), model: 'opus' };
const md = toMarkdown(info, tr);
check('Markdown：标题、角色、工具、正文', md.startsWith('# 看 README\n\n> 项目：demo · 导出于 2026-11-17 09:05 · 模型：opus') && md.includes('## 你\n\n帮我看看 README') && md.includes('- 🔧 `Bash: npm test`') && md.includes('## 小李 交回 #3 翻译'), md);
const html = toHtml(info, tr);
check('HTML：转义、代码块、粗体', html.includes('<title>看 README</title>') && html.includes('<pre><code>console.log(1 &lt; 2)</code></pre>') && html.includes('<b>示例项目</b>') && !html.includes('<script'), html.slice(0, 400));
check('HTML：用户内容里的标签被转义', toHtml(info, [{ role: 'user', text: '<img src=x onerror=alert(1)>', tools: [], files: [] }]).includes('&lt;img src=x onerror=alert(1)&gt;'));
check('mdToHtml：列表和标题', mdToHtml('# 标题\n\n- a\n- `b`') === '<h3>标题</h3>\n<ul><li>a</li><li><code>b</code></li></ul>', mdToHtml('# 标题\n\n- a\n- `b`'));

const text = searchableText(tr);
check('搜索文字：小写、含工具和附件', text.includes('readme 写的是') && text.includes('bash: npm test') && text.includes('d:\\docs\\a.pdf'));
check('摘录：前后各一段', snippet('前面很多字前面很多字 PINEAPPLE-42 后面很多字后面很多字', 'pineapple', 5) === '…面很多字 PINEAPPLE-42 后…', snippet('前面很多字前面很多字 PINEAPPLE-42 后面很多字后面很多字', 'pineapple', 5));
check('摘录：找不到返回 null', snippet('abc', 'x') === null && snippet('abc', '  ') === null);

console.log(`--- 对话历史：${total - failed}/${total} 通过`);
if (failed) process.exit(1);
