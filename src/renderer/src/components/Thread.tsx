// 对话区：用户消息、Claude 的回复、思考、活动记录（工具调用）、审批卡片、提示。
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ModeId, PermissionRequest } from '@shared/types';
import { useStore } from '../store';
import type { Item } from '../timeline';
import { describeTool, diffStat, editDiff, relPath, todosOf, type DiffLine } from '../toolView';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

type ToolItem = Extract<Item, { kind: 'tool' }>;
type ApprovalItem = Extract<Item, { kind: 'approval' }>;

const secs = (ms: number) => (ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000).toString());

function clip(text: string, maxLines = 400): { text: string; cut: number } {
  const lines = text.split('\n');
  return lines.length > maxLines ? { text: lines.slice(0, maxLines).join('\n'), cut: lines.length - maxLines } : { text, cut: 0 };
}

function Output({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const c = all ? { text, cut: 0 } : clip(text);
  return (
    <>
      <pre className="out">{c.text}</pre>
      {c.cut > 0 && <button className="link sm" onClick={() => setAll(true)}>还有 {c.cut} 行，展开全部</button>}
    </>
  );
}

export function DiffView({ lines, max = 600 }: { lines: DiffLine[]; max?: number }) {
  const shown = lines.slice(0, max);
  return (
    <div className="diff">
      {shown.map((l, i) => (
        <div key={i} className={`dl ${l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}`}>
          <span className="ln">{l.oldNo ?? ''}</span>
          <span className="ln">{l.newNo ?? ''}</span>
          <span className="sg">{l.type === ' ' ? '' : l.type}</span>
          <span className="code">{l.text}</span>
        </div>
      ))}
      {lines.length > max && <div className="dl more">…还有 {lines.length - max} 行</div>}
    </div>
  );
}

function ActRow({ icon, verb, running, target, meta, tags, children, defaultOpen = false }: {
  icon: Parameters<typeof Icon>[0]['name']; verb: string; running?: boolean; target?: string; meta?: ReactNode;
  tags?: ReactNode; children?: ReactNode; defaultOpen?: boolean;
}) {
  // 用户没点过时跟着 defaultOpen 走（比如改代码的记录完成后自动展开）；点过就按用户的来
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? defaultOpen;
  const expandable = !!children;
  return (
    <div className={`act${open ? ' open' : ''}`}>
      <div className={`act-head${expandable ? '' : ' static'}`} onClick={() => expandable && setManual(!open)}>
        <Icon name={icon} size={14} />
        <span className={`verb${running ? ' shimmer' : ''}`}>{verb}</span>
        {target && <span className="obj">{target}</span>}
        {tags}
        {meta && <span className="meta">{meta}</span>}
        {expandable && <Icon name="right" size={13} className="chev" />}
      </div>
      {open && children && <div className="act-body">{children}</div>}
    </div>
  );
}

function Todos({ item }: { item: ToolItem }) {
  const todos = todosOf(item) ?? [];
  const done = todos.filter(t => t.status === 'completed').length;
  return (
    <div className="plan">
      <div className="plan-head"><Icon name="listcheck" size={14} />计划 · {done}/{todos.length}</div>
      <ul className="todo">
        {todos.map((t, i) => <li key={i} className={t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : ''}>{t.content}</li>)}
      </ul>
    </div>
  );
}

function ToolRow({ item, projectPath }: { item: ToolItem; projectPath: string }) {
  if (item.name === 'TodoWrite' && todosOf(item)) return <Todos item={item} />;
  const v = describeTool(item, projectPath);
  const running = item.status === 'running';
  const tags = item.status === 'denied' ? <span className="tag deny">已拒绝</span> : item.status === 'error' ? <span className="tag fail">出错</span> : null;
  const took = item.endedAt && item.endedAt - item.startedAt > 2000 ? `${secs(item.endedAt - item.startedAt)} 秒` : undefined;
  const meta = [v.meta, took].filter(Boolean).join(' · ') || undefined;
  let body: ReactNode = null;
  if (v.body === 'diff') body = <div className="box"><DiffView lines={editDiff(item)} /></div>;
  else if (v.body === 'markdown') {
    const text = item.name === 'ExitPlanMode' ? String(item.input.plan ?? '') : item.output ?? '';
    body = text ? <div className="box pad"><Markdown text={text} /></div> : null;
  } else if (v.body === 'json') body = <><pre className="out">{JSON.stringify(item.input, null, 2)}</pre>{item.output && <Output text={item.output} />}</>;
  else if (v.body === 'output' && item.output) body = <Output text={item.output} />;
  if (item.status === 'denied' && item.output && v.body !== 'output') body = <><>{body}</><Output text={item.output} /></>;
  // 被拒绝的不能说“已运行”，用不带“正在”的动词：运行、编辑、读取……
  const verb = running ? v.running : item.status === 'denied' ? v.running.replace(/^正在/, '') : v.verb;
  return (
    <ActRow icon={v.icon} verb={verb} running={running} target={v.target} meta={meta} tags={tags}
      defaultOpen={v.body === 'diff' && item.status === 'done' && item.name !== 'Write'}>
      {body}
    </ActRow>
  );
}

function ThinkingRow({ item }: { item: Extract<Item, { kind: 'thinking' }> }) {
  const thinking = !item.endedAt;
  const took = item.endedAt ? item.endedAt - item.startedAt : 0;
  // 很短又没有内容的思考（模型默认不返回思考内容）只是噪音，不显示
  if (!thinking && !item.text && took < 1000) return null;
  const verb = thinking ? '思考中' : took >= 1000 ? `已思考 ${secs(took)} 秒` : '已思考';
  return (
    <ActRow icon="clock" verb={verb} running={thinking}>
      {item.text ? <div className="think">{item.text}</div> : null}
    </ActRow>
  );
}

// ---------------- 审批卡片 ----------------

function toolTitle(r: PermissionRequest): string {
  if (r.title) return r.title;
  switch (r.toolName) {
    case 'Bash': case 'PowerShell': return 'Claude 想运行一条命令';
    case 'Edit': case 'MultiEdit': return 'Claude 想修改文件';
    case 'Write': return 'Claude 想写入文件';
    case 'WebFetch': return 'Claude 想读取网页';
    case 'WebSearch': return 'Claude 想搜索网页';
    default: return r.toolName.startsWith('mcp__') ? `Claude 想调用 ${r.toolName.split('__')[1]} 的工具` : `Claude 想使用 ${r.displayName ?? r.toolName}`;
  }
}

function RequestPreview({ r, projectPath }: { r: PermissionRequest; projectPath: string }) {
  const input = r.input;
  if (r.toolName === 'Bash' || r.toolName === 'PowerShell') {
    return <><div className="ap-cmd">{String(input.command ?? '')}</div>{input.description ? <div className="ap-meta">{String(input.description)}</div> : null}</>;
  }
  if (['Edit', 'MultiEdit', 'Write'].includes(r.toolName)) {
    const fake: ToolItem = { kind: 'tool', id: r.requestId, name: r.toolName, input, status: 'running', startedAt: 0, subSteps: 0 };
    const lines = editDiff(fake);
    const { add, del } = diffStat(lines);
    return (
      <>
        <div className="ap-file"><Icon name="file" size={14} />{relPath(String(input.file_path ?? ''), projectPath)}<span className="add">+{add}</span><span className="del">−{del}</span></div>
        <div className="box"><DiffView lines={lines} max={80} /></div>
      </>
    );
  }
  if (r.toolName === 'WebFetch') return <div className="ap-cmd">{String(input.url ?? '')}</div>;
  if (r.toolName === 'WebSearch') return <div className="ap-cmd">{String(input.query ?? '')}</div>;
  return <pre className="out">{JSON.stringify(input, null, 2)}</pre>;
}

function GenericApproval({ convId, item, projectPath }: { convId: string; item: ApprovalItem; projectPath: string }) {
  const respond = useStore(s => s.respond);
  const r = item.request;
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const deny = () => void respond(convId, { requestId: r.requestId, behavior: 'deny', message: reason }, reason);
  return (
    <div className="approval" data-testid="approval">
      <div className="ap-title"><Icon name={r.toolName === 'Bash' || r.toolName === 'PowerShell' ? 'term' : 'shield'} />{toolTitle(r)}</div>
      <RequestPreview r={r} projectPath={projectPath} />
      {r.blockedPath && <div className="ap-meta">要访问项目以外的路径：{r.blockedPath}</div>}
      {r.decisionReason && <div className="ap-meta">{r.decisionReason}</div>}
      <div className="ap-actions">
        <button className="btn primary" onClick={() => void respond(convId, { requestId: r.requestId, behavior: 'allow' })}>允许一次</button>
        {r.canAlways && (
          <button className="btn" title={r.alwaysLabel} onClick={() => void respond(convId, { requestId: r.requestId, behavior: 'always' }, r.alwaysLabel)}>
            总是允许{r.alwaysLabel ? <code>{r.alwaysLabel}</code> : null}
          </button>
        )}
        <button className="btn ghost" onClick={() => setDenying(true)}>拒绝…</button>
      </div>
      {denying && (
        <div className="deny-box">
          <input autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="告诉 Claude 为什么拒绝（可选）"
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) deny(); }} />
          <button className="btn" onClick={deny}>拒绝</button>
        </div>
      )}
    </div>
  );
}

function PlanApproval({ convId, item }: { convId: string; item: ApprovalItem }) {
  const respond = useStore(s => s.respond);
  const r = item.request;
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');
  const approve = (nextMode: ModeId, note: string) => void respond(convId, { requestId: r.requestId, behavior: 'allow', nextMode }, note);
  return (
    <div className="approval plan-card" data-testid="approval">
      <div className="ap-title"><Icon name="plan" />Claude 的计划，批准后开始执行</div>
      <div className="box pad plan-body"><Markdown text={String(r.input.plan ?? '')} /></div>
      <div className="ap-actions">
        <button className="btn primary" onClick={() => approve('default', '批准了计划，切到「默认：询问」')}>批准，开始执行</button>
        <button className="btn" onClick={() => approve('acceptEdits', '批准了计划，切到「自动接受编辑」')}>批准，并自动接受编辑</button>
        <button className="btn ghost" onClick={() => setRevising(true)}>继续完善计划…</button>
      </div>
      {revising && (
        <div className="deny-box">
          <input autoFocus value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="哪里要改？比如：先别动数据库，只改前端"
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void respond(convId, { requestId: r.requestId, behavior: 'deny', message: feedback || '用户希望继续完善计划' }, feedback); }} />
          <button className="btn" onClick={() => void respond(convId, { requestId: r.requestId, behavior: 'deny', message: feedback || '用户希望继续完善计划' }, feedback)}>发给 Claude</button>
        </div>
      )}
    </div>
  );
}

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

function QuestionCard({ convId, item }: { convId: string; item: ApprovalItem }) {
  const respond = useStore(s => s.respond);
  const r = item.request;
  const questions = (r.input.questions as Question[] | undefined) ?? [];
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const toggle = (qi: number, label: string, multi: boolean) =>
    setPicked(p => {
      const cur = p[qi] ?? [];
      return { ...p, [qi]: multi ? (cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label]) : [label] };
    });
  const answerOf = (qi: number) => [...(picked[qi] ?? []), ...(other[qi]?.trim() ? [other[qi].trim()] : [])].join(', ');
  const complete = questions.every((_, qi) => answerOf(qi));
  const submit = () => {
    const answers = Object.fromEntries(questions.map((q, qi) => [q.question, answerOf(qi)]));
    void respond(convId, { requestId: r.requestId, behavior: 'allow', updatedInput: { ...r.input, answers } }, Object.values(answers).join('；'));
  };
  return (
    <div className="approval question-card" data-testid="approval">
      <div className="ap-title"><Icon name="ask" />Claude 想问你</div>
      {questions.map((q, qi) => (
        <div className="q" key={qi}>
          <div className="q-text">{q.header && <span className="q-chip">{q.header}</span>}{q.question}</div>
          <div className="q-opts">
            {q.options.map(o => (
              <button key={o.label} className={`q-opt${picked[qi]?.includes(o.label) ? ' on' : ''}`} onClick={() => toggle(qi, o.label, q.multiSelect)}>
                <b>{o.label}</b>{o.description && <span>{o.description}</span>}
              </button>
            ))}
          </div>
          <input className="q-other" placeholder="其他（自己填）" value={other[qi] ?? ''} onChange={e => setOther(s => ({ ...s, [qi]: e.target.value }))} />
        </div>
      ))}
      <div className="ap-actions">
        <button className="btn primary" disabled={!complete} onClick={submit}>提交回答</button>
        <button className="btn ghost" onClick={() => void respond(convId, { requestId: r.requestId, behavior: 'deny', message: '用户跳过了这些问题，请根据已有信息继续，或者在回复里直接问用户。' }, '跳过了')}>跳过</button>
      </div>
    </div>
  );
}

function ResolvedApproval({ item }: { item: ApprovalItem }) {
  const r = item.request;
  const what = r.toolName === 'ExitPlanMode' ? '计划' : r.toolName === 'AskUserQuestion' ? '问题' : toolTitle(r).replace(/^Claude 想/, '');
  const text =
    item.resolved === 'cancelled' ? `审批已取消（${what}）`
      : item.resolved === 'deny' ? `你拒绝了：${what}${item.note ? `（${item.note}）` : ''}`
        : item.resolved === 'always' ? `总是允许${item.note ? `：${item.note}` : ''}`
          : r.toolName === 'AskUserQuestion' ? `你回答了：${item.note ?? ''}`
            : item.note ?? '你允许了一次';
  return (
    <div className={`ap-done${item.resolved === 'deny' ? ' deny' : ''}`}>
      <Icon name={item.resolved === 'deny' || item.resolved === 'cancelled' ? 'x' : 'check'} size={14} />{text}
    </div>
  );
}

function ApprovalView({ convId, item, projectPath }: { convId: string; item: ApprovalItem; projectPath: string }) {
  if (item.resolved) return <ResolvedApproval item={item} />;
  if (item.request.toolName === 'ExitPlanMode') return <PlanApproval convId={convId} item={item} />;
  if (item.request.toolName === 'AskUserQuestion') return <QuestionCard convId={convId} item={item} />;
  return <GenericApproval convId={convId} item={item} projectPath={projectPath} />;
}

// ---------------- 对话区 ----------------

function ItemView({ item, convId, projectPath }: { item: Item; convId: string; projectPath: string }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="bubble">
            {(item.skillsMode || item.images > 0) && (
              <div className="bubble-tags">
                {item.skillsMode && <span className="chip-mode"><Icon name="wrench" size={12} />Skills 配置模式</span>}
                {item.images > 0 && <span className="chip-mode"><Icon name="image" size={12} />{item.images} 张图片</span>}
              </div>
            )}
            {item.text}
          </div>
        </div>
      );
    case 'text':
      return <div className="msg assistant"><Markdown text={item.text} />{item.streaming && <span className="caret" />}</div>;
    case 'thinking':
      return <ThinkingRow item={item} />;
    case 'tool':
      return <ToolRow item={item} projectPath={projectPath} />;
    case 'approval':
      return <ApprovalView convId={convId} item={item} projectPath={projectPath} />;
    case 'notice':
      return (
        <div className={`notice ${item.tone}`}>
          <Icon name={item.tone === 'blocked' ? 'ban' : item.tone === 'error' ? 'alert' : 'info'} size={14} />
          <div><div>{item.text}</div>{item.detail && <code className="notice-detail">{item.detail}</code>}</div>
        </div>
      );
    case 'turn-end':
      return item.durationMs > 0 ? <div className="turn-end">用时 {secs(item.durationMs)} 秒</div> : null;
  }
}

export function Thread() {
  const activeId = useStore(s => s.activeId);
  const conv = useStore(s => (s.activeId ? s.convs[s.activeId] : null));
  const activeProject = useStore(s => s.activeProject);
  const project = useStore(s => s.app?.projects.find(p => p.path === (conv?.meta.projectPath ?? s.activeProject)));
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const items = conv?.timeline.items ?? [];

  // 用户停在底部时，新内容出来就自动滚到底；往上翻看时不打扰
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  useLayoutEffect(() => { stick.current = true; }, [activeId]);

  const waiting = conv && (conv.status === 'running' || conv.status === 'starting') && !items.some(i =>
    (i.kind === 'text' && i.streaming) || (i.kind === 'thinking' && !i.endedAt) || (i.kind === 'tool' && i.status === 'running') || (i.kind === 'approval' && !i.resolved));
  const lastIsUser = items[items.length - 1]?.kind === 'user';

  return (
    <div className="thread" ref={ref} onScroll={e => {
      const el = e.currentTarget;
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }}>
      <div className="col">
        {!conv || items.length === 0 ? (
          <div className="hero">
            <div className="hero-t">要在 <b>{project?.name ?? activeProject ?? ''}</b> 里做什么？</div>
            <div className="hero-s">直接在下面输入。读文件、改文件、跑命令都会显示在这里；需要你同意的操作会先问你。</div>
          </div>
        ) : (
          items.map(it => <ItemView key={it.id} item={it} convId={conv.meta.id} projectPath={conv.meta.projectPath} />)
        )}
        {waiting && lastIsUser && <div className="act"><div className="act-head static"><span className="verb shimmer">{conv.status === 'starting' ? '正在启动 Claude Code' : '思考中'}</span></div></div>}
      </div>
    </div>
  );
}
