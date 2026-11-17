// 员工档案（src/shared/profile.ts）：Claude Code 子代理格式的读写。
// 运行：npm run test:unit
import { isReadOnly, parseProfile, serializeProfile, toAgentDefinition, type EmployeeProfile } from '../../src/shared/profile.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};

// 1. Claude Code 文档里的常见写法
const p1 = parseProfile('reviewer', `---
name: reviewer
description: 代码审查员，只看不改
tools: Read, Grep, Glob
model: sonnet
memory: project
---
你是「老周」，代码审查员。

输出格式：第一行写结论。
`);
check('名字、描述、正文', p1.id === 'reviewer' && p1.displayName === 'reviewer' && p1.description === '代码审查员，只看不改' && p1.prompt === '你是「老周」，代码审查员。\n\n输出格式：第一行写结论。', p1);
check('逗号分隔的工具列表', JSON.stringify(p1.tools) === '["Read","Grep","Glob"]', p1.tools);
check('模型、记忆', p1.model === 'sonnet' && p1.memory === 'project');
check('只读', isReadOnly(p1) && !isReadOnly({ tools: ['Read', 'Edit'] }) && !isReadOnly({}));

// 2. 写出去再读回来，一样
const full: EmployeeProfile = {
  id: 'translator', displayName: '小李', description: '翻译：中英互译, 术语要统一',
  prompt: '你是「小李」，翻译。\n\n- 先理解再翻译\n- 汇报：只给译文', tools: ['Read', 'Write'], disallowedTools: ['WebSearch'],
  model: 'haiku', effort: 'low', permissionMode: 'acceptEdits', skills: ['doc-coauthoring', 'office-docx'], memory: 'project'
};
const text = serializeProfile(full);
const back = parseProfile('translator', text);
check('写出再读回：全部字段一样', JSON.stringify(back) === JSON.stringify(full), { text, back });
check('写出的格式：开头是 YAML 头，正文在后面', text.startsWith('---\nname: translator\ndisplayName: 小李\n') && text.includes('---\n\n你是「小李」'), text);
check('带逗号的描述加了引号', text.includes('description: 翻译：中英互译, 术语要统一') || text.includes('"翻译：中英互译, 术语要统一"'), text);
const tricky = { ...full, displayName: 'yes', description: 'key: value # 不是注释' };
const back2 = parseProfile('translator', serializeProfile(tricky));
check('特殊值（yes、带冒号和井号）原样读回', back2.displayName === 'yes' && back2.description === 'key: value # 不是注释', back2);

// 3. 其他写法：YAML 列表、[a, b]、引号、Windows 换行、没有 YAML 头
const p3 = parseProfile('x', '---\r\nname: writer\r\ndisplayName: "小周"\r\ntools:\r\n  - Read\r\n  - Write\r\nskills: [a, \'b c\']\r\nmemory: none\r\n---\r\n正文\r\n');
check('YAML 列表、引号、CRLF', p3.id === 'writer' && p3.displayName === '小周' && JSON.stringify(p3.tools) === '["Read","Write"]' && JSON.stringify(p3.skills) === '["a","b c"]' && p3.memory === null && p3.prompt === '正文', p3);
const p4 = parseProfile('plain', '只有正文，没有 YAML 头');
check('没有 YAML 头：用文件名，全部是正文', p4.id === 'plain' && p4.prompt === '只有正文，没有 YAML 头' && p4.tools === undefined, p4);
check('name 不合法时用文件名', parseProfile('ok-name', '---\nname: 小李\n---\nx').id === 'ok-name');
check('不认识的模式、思考强度忽略', parseProfile('a', '---\npermissionMode: weird\neffort: huge\n---\nx').permissionMode === undefined);

// 4. 给 SDK 的定义
const def = toAgentDefinition(full);
check('SDK 定义：提示词、工具、模型', def.prompt === full.prompt && JSON.stringify(def.tools) === JSON.stringify(full.tools) && def.model === 'haiku' && def.permissionMode === 'acceptEdits' && def.memory === 'project', def);
check('员工不能直接问用户', def.disallowedTools.includes('AskUserQuestion') && def.disallowedTools.includes('WebSearch'), def.disallowedTools);
check('没写工具：不限制（继承全部）', !('tools' in toAgentDefinition(p4)));

console.log(`--- 员工档案：${total - failed}/${total} 通过`);
if (failed) process.exit(1);
