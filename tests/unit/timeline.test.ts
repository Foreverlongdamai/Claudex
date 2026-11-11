// 时间线整理逻辑的单元测试：用一段模拟的 SDK 消息流（逐字片段 + 完整消息 + 工具结果 + 结束）。
// 运行：npm run test:unit
import { addApproval, addUser, applySdk, emptyTimeline, resolveApproval, stripModeWrapper, type Timeline } from '../../src/renderer/src/timeline.ts';

let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};
const feed = (t: Timeline, msgs: object[], live = true) => msgs.reduce<Timeline>((acc, m) => applySdk(acc, m as never, live), t);

// 1. 实时：文字逐字输出，然后完整消息收尾
let t = addUser(emptyTimeline(), '你好', 0, false);
t = feed(t, [
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5', permissionMode: 'default', claude_code_version: '2.1.321', tools: ['Read'], slash_commands: ['compact'], skills: ['a', 'b'], mcp_servers: [] },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '好！' } } }
]);
const streaming = t.items.find(i => i.kind === 'text');
check('逐字输出时文字在累积', streaming?.kind === 'text' && streaming.text === '你好！' && streaming.streaming, streaming);
check('init 信息被记下', t.init?.model === 'claude-opus-5-5' && t.init.skills === 2);
check('思考块有结束时间', t.items.some(i => i.kind === 'thinking' && !!i.endedAt));
t = feed(t, [
  { type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '' }] } },
  { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '你好！有什么可以帮你？' }] } }
]);
const texts = t.items.filter(i => i.kind === 'text');
check('完整消息到达后只保留一条文字，并收尾', texts.length === 1 && texts[0].kind === 'text' && texts[0].text === '你好！有什么可以帮你？' && !texts[0].streaming, texts);
check('思考块没有重复', t.items.filter(i => i.kind === 'thinking').length === 1);

// 2. 工具调用：开始 → 审批 → 拒绝 → 结果标成已拒绝
t = feed(t, [
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } } },
  { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf build' } }] } }
]);
const tool = t.items.find(i => i.id === 'tu1');
check('工具行带上了完整输入', tool?.kind === 'tool' && tool.input.command === 'rm -rf build' && tool.status === 'running', tool);
t = addApproval(t, { requestId: 'r1', toolUseId: 'tu1', toolName: 'Bash', input: { command: 'rm -rf build' }, canAlways: true });
t = addApproval(t, { requestId: 'r1', toolUseId: 'tu1', toolName: 'Bash', input: {}, canAlways: true });
check('同一个审批不会加两次', t.items.filter(i => i.kind === 'approval').length === 1);
t = resolveApproval(t, 'r1', 'deny', '先别删');
t = feed(t, [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'some error text' }] } }]);
const denied = t.items.find(i => i.id === 'tu1');
check('拒绝过的工具调用标成“已拒绝”', denied?.kind === 'tool' && denied.status === 'denied', denied);

// 3. 子代理的消息只计步数
t = feed(t, [
  { type: 'assistant', message: { id: 'm3', content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: '查资料' } }] } },
  { type: 'assistant', parent_tool_use_id: 'ag1', message: { id: 'sub1', content: [{ type: 'tool_use', id: 's1', name: 'Read', input: {} }, { type: 'tool_use', id: 's2', name: 'Grep', input: {} }] } },
  { type: 'user', parent_tool_use_id: 'ag1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'x' }] } }
]);
const agent = t.items.find(i => i.id === 'ag1');
check('子代理计了 2 步，子代理内部的工具不单独显示', agent?.kind === 'tool' && agent.subSteps === 2 && !t.items.some(i => i.id === 's1'), agent);

// 4. 本轮结束
t = feed(t, [{ type: 'result', subtype: 'success', is_error: false, duration_ms: 4200, total_cost_usd: 0.01, result: 'ok' }]);
check('本轮结束后加了结束标记', t.items[t.items.length - 1].kind === 'turn-end');
check('结束时没有还在流式的文字', !t.items.some(i => i.kind === 'text' && i.streaming));

// 5. 打开历史：用户消息要显示，并去掉 Skills 配置模式的附加说明
let h = feed(emptyTimeline(), [
  { type: 'user', message: { role: 'user', content: '<claudex-mode name="skills">\n流程说明\n</claudex-mode>\n\n帮我挑 Skills' } },
  { type: 'assistant', message: { id: 'h1', content: [{ type: 'text', text: '好的' }] } },
  { type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } }
], false);
const hu = h.items[0];
check('历史里的用户消息去掉了模式说明', hu?.kind === 'user' && hu.text === '帮我挑 Skills' && hu.skillsMode, hu);
check('历史里的“已停止”显示成提示', h.items[2]?.kind === 'notice', h.items[2]);
check('stripModeWrapper 不改普通文字', stripModeWrapper('hello').text === 'hello');
// 实时模式下 SDK 回放的用户消息不重复显示
h = feed(emptyTimeline(), [{ type: 'user', message: { role: 'user', content: 'hi' } }], true);
check('实时模式不重复显示用户消息', h.items.length === 0);

// 6. 出错的一轮
t = feed(emptyTimeline(), [{ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 10, errors: ['连接中断'] }]);
check('出错的一轮有错误提示', t.items.some(i => i.kind === 'notice' && i.tone === 'error' && i.detail === '连接中断'), t.items);

const total = 17;
console.log(`--- 时间线：${total - failed}/${total} 通过`);
process.exit(failed ? 1 : 0);
