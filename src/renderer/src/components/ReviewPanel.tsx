// 改动面板（C2：Git 审查和提交）：按“上一轮 / 未暂存 / 已暂存 / 整个分支”看改动，
// 暂存、撤销，在某一行写评论发给 Claude，写提交说明（留空让 Claude 写）后提交、推送、开 PR。
import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { DiffFile, DiffLine, GitDiffResult, GitFileState, GitScope, GitStatus } from '@shared/types';
import { useActiveCwd, useStore } from '../store';
import { Icon } from './Icon';

const api = window.claudex;

const SCOPES: Array<{ id: GitScope; label: string; title: string }> = [
  { id: 'turn', label: '上一轮', title: 'Claude 上一轮回复里改的文件' },
  { id: 'unstaged', label: '未暂存', title: '还没暂存的改动' },
  { id: 'staged', label: '已暂存', title: '已暂存、准备提交的改动' },
  { id: 'branch', label: '整个分支', title: '当前分支上还没推送（或相对默认分支）的全部改动' }
];

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/** 点一次变成“确定撤销？”，3 秒内再点一次才执行 */
function ConfirmButton({ label, confirm, onConfirm, testId, className = '' }: { label: string; confirm: string; onConfirm: () => void; testId?: string; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button className={`${className}${armed ? ' armed' : ''}`} data-testid={testId}
      onClick={e => { e.stopPropagation(); if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirm : label}
    </button>
  );
}

// ---------------- 一个文件的 diff（每行可以评论） ----------------

interface SentComment { key: string; text: string }

const lineKey = (file: DiffFile, l: DiffLine) => `${file.path}|${l.oldNo ?? ''}|${l.newNo ?? ''}|${l.text}`;

/** 发给 Claude 的评论消息：文件、行号、这一行的内容、评论 */
function commentMessage(file: DiffFile, l: DiffLine, text: string): string {
  const where = l.newNo ? `第 ${l.newNo} 行` : `改动前的第 ${l.oldNo} 行（这一行已经删掉了）`;
  return `【代码评论】${file.path} ${where}\n> ${l.text.trim() || '（空行）'}\n${text.trim()}`;
}

function ReviewDiff({ file, sent, onSend }: { file: DiffFile; sent: SentComment[]; onSend: (l: DiffLine, text: string) => void }) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [limit, setLimit] = useState(800);
  const rows = file.lines.slice(0, limit);
  const submit = (l: DiffLine) => {
    if (!text.trim()) return;
    onSend(l, text);
    setOpenAt(null);
    setText('');
  };
  return (
    <div className="diff rdiff">
      {rows.map((l, i) => {
        if (l.type === '@') return <div key={i} className="dl hunk"><span className="code">{l.text}</span></div>;
        const key = lineKey(file, l);
        return (
          <Fragment key={i}>
            <div className={`dl ${l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}`} data-testid="diff-line">
              <button className="cbtn" title="评论这一行，让 Claude 改" data-testid="comment-button" onClick={() => { setOpenAt(i); setText(''); }}>+</button>
              <span className="ln">{l.oldNo ?? ''}</span>
              <span className="ln">{l.newNo ?? ''}</span>
              <span className="sg">{l.type === ' ' ? '' : l.type}</span>
              <span className="code">{l.text}</span>
            </div>
            {sent.filter(c => c.key === key).map((c, j) => (
              <div key={j} className="cnote"><Icon name="comment" size={13} /><span>{c.text}<small>已发给 Claude</small></span></div>
            ))}
            {openAt === i && (
              <div className="cbox">
                <textarea autoFocus rows={3} value={text} placeholder="写下要 Claude 怎么改（Ctrl+Enter 发送）" data-testid="comment-input"
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape') { e.stopPropagation(); setOpenAt(null); }
                    if (e.key === 'Enter' && e.ctrlKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(l); }
                  }} />
                <div className="row2">
                  <button className="btn sm ghost" onClick={() => setOpenAt(null)}>取消</button>
                  <button className="btn sm primary" data-testid="comment-send" disabled={!text.trim()} onClick={() => submit(l)}>发给 Claude</button>
                </div>
              </div>
            )}
          </Fragment>
        );
      })}
      {file.lines.length > limit && <button className="link sm more-lines" onClick={() => setLimit(Infinity)}>还有 {file.lines.length - limit} 行，展开全部</button>}
    </div>
  );
}

// ---------------- 文件卡片 ----------------

function FileCard({ file, scope, state, live, cwd, sent, onComment }: {
  file: DiffFile; scope: GitScope; state?: GitFileState; live: boolean; cwd: string; sent: SentComment[];
  onComment: (file: DiffFile, l: DiffLine, text: string) => void;
}) {
  const gitAction = useStore(s => s.gitAction);
  const [collapsed, setCollapsed] = useState(false);
  const slash = file.path.lastIndexOf('/');
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
  const name = file.path.slice(slash + 1);
  const paths = file.oldPath ? [file.path, file.oldPath] : [file.path];
  // “上一轮”和“整个分支”里：文件还有没暂存的改动就能暂存，只有暂存的就能取消暂存
  const dirty = !!state && (state.untracked || state.y !== '.');
  const staged = !!state && !state.untracked && state.x !== '.';
  const canStage = scope === 'unstaged' || ((scope === 'turn' || scope === 'branch') && dirty);
  const canUnstage = scope === 'staged' || ((scope === 'turn' || scope === 'branch') && staged && !dirty);
  const canRevert = scope === 'unstaged' || (scope === 'turn' && !live);
  const tag = file.change === 'added' ? '新文件' : file.change === 'deleted' ? '已删除' : file.change === 'renamed' ? '改名' : null;
  let body;
  if (file.binary) body = <div className="rfile-note">二进制文件，不显示内容</div>;
  else if (file.tooLarge) body = <div className="rfile-note">文件太大或者改动太多，这里不显示具体的行</div>;
  else if (!file.lines.length) body = <div className="rfile-note">{file.change === 'renamed' ? `从 ${file.oldPath} 改名过来，内容没变` : file.change === 'added' ? '空文件' : '只改了文件权限'}</div>;
  else body = <ReviewDiff file={file} sent={sent} onSend={(l, text) => onComment(file, l, text)} />;
  return (
    <div className={`rfile${collapsed ? ' collapsed' : ''}`} data-testid="review-file" data-path={file.path}>
      <div className="rfile-head" onClick={() => setCollapsed(!collapsed)}>
        <Icon name="right" size={12} className="chev" />
        <span className="fn" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}><span className="dir">{dir}</span>{name}</span>
        {tag && <span className={`ftag ${file.change}`}>{tag}</span>}
        {staged && scope !== 'staged' && <span className="ftag">已暂存</span>}
        <span className="nums"><span className="add">+{file.add}</span><span className="del">−{file.del}</span></span>
        <span className="acts" onClick={e => e.stopPropagation()}>
          {canStage && <button data-testid="stage-file" onClick={() => void gitAction('stage', cwd, paths)}>暂存</button>}
          {canUnstage && <button data-testid="unstage-file" onClick={() => void gitAction('unstage', cwd, paths)}>取消暂存</button>}
          {canRevert && (
            <ConfirmButton label="撤销" confirm="确定撤销？" className="danger" testId="revert-file"
              onConfirm={() => void gitAction('revert', cwd, paths, scope)} />
          )}
        </span>
      </div>
      {!collapsed && body}
    </div>
  );
}

// ---------------- 提交框 ----------------

function CommitBox({ cwd, status }: { cwd: string; status: GitStatus }) {
  const commit = useStore(s => s.commit);
  const busy = useStore(s => s.gitBusy);
  const commitToken = useStore(s => s.commitToken);
  const [message, setMessage] = useState('');
  const [menu, setMenu] = useState(false);
  useEffect(() => { setMessage(''); }, [commitToken]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const changes = status.files.length;
  const stagedCount = status.files.filter(f => !f.untracked && f.x !== '.').length;
  const branch = status.branch;
  const neverPushed = status.hasRemote && !!branch && !status.upstream && !status.unborn;
  const canPush = !changes && status.hasRemote && !!branch && (status.ahead > 0 || neverPushed);
  const onDefault = !branch || branch === status.defaultBranch;
  const run = (kind: 'commit' | 'push' | 'pr') => {
    setMenu(false);
    if (kind === 'pr' && onDefault) {
      useStore.setState({ dialog: { kind: 'pr-branch', cwd, message } });
      return;
    }
    void commit(cwd, { message, kind });
  };
  const info = [
    changes ? `提交到 ${branch ?? '（分离 HEAD）'}：${stagedCount ? `已暂存的 ${stagedCount} 个文件` : `全部 ${changes} 个文件`}` : '没有要提交的改动',
    status.ahead > 0 && `${status.ahead} 个提交还没推送`,
    neverPushed && '这个分支还没推送过',
    status.behind > 0 && `远程比本地多 ${status.behind} 个提交`
  ].filter(Boolean).join(' · ');
  const primary = changes ? { kind: 'commit' as const, label: '提交' } : canPush ? { kind: 'push' as const, label: '推送' } : { kind: 'commit' as const, label: '提交' };
  const options: Array<{ kind: 'commit' | 'push' | 'pr'; label: string }> = changes
    ? [{ kind: 'commit', label: '提交' }, { kind: 'push', label: '提交并推送' }, { kind: 'pr', label: '提交并开 PR' }]
    : [{ kind: 'push', label: '推送' }, { kind: 'pr', label: '开 PR' }];
  const disabled = !!busy || (!changes && !canPush && !(status.hasRemote && !onDefault));
  return (
    <div className="commit" data-testid="commit-box">
      <textarea rows={2} value={message} placeholder="提交说明（留空让 Claude 来写）" data-testid="commit-message"
        disabled={!!busy} onChange={e => setMessage(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey && !e.nativeEvent.isComposing && changes) { e.preventDefault(); run('commit'); } }} />
      <div className="commit-row">
        <span className="commit-info" data-testid="commit-info">{busy ? <><i className="spin" />{busy}</> : info}</span>
        <span className="sp" />
        <div className="dd">
          <div className="split-btn">
            <button className="btn primary sm" data-testid="commit-button" disabled={disabled || (!changes && !canPush)} onClick={() => run(primary.kind)}>{primary.label}</button>
            <button className="btn primary sm" data-testid="commit-more" title="更多提交方式" disabled={disabled} onClick={e => { e.stopPropagation(); setMenu(!menu); }}><Icon name="down" size={13} /></button>
          </div>
          {menu && (
            <div className="menu right commit-menu" onClick={e => e.stopPropagation()}>
              {options.map(o => {
                const off = (o.kind === 'push' && !changes && !canPush) || ((o.kind === 'push' || o.kind === 'pr') && !status.hasRemote);
                return <button key={o.kind} className="simple" data-commit={o.kind} disabled={off} onClick={() => run(o.kind)}>{o.label}</button>;
              })}
              {!status.hasRemote && <div className="menu-foot">还没有设置远程仓库，不能推送</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------- 面板 ----------------

export function ReviewPanel() {
  const open = useStore(s => s.reviewOpen);
  const activeId = useStore(s => s.activeId);
  const cwd = useActiveCwd();
  const scope = useStore(s => s.reviewScope);
  const tick = useStore(s => s.gitTick);
  const status = useStore(s => (cwd ? s.git[cwd] : undefined));
  const savedWidth = useStore(s => s.app?.prefs.reviewWidth ?? 460);
  const { setReviewScope, toggleReview, gitAction, gitInit, send, setPrefs } = useStore.getState();
  const [width, setWidth] = useState(savedWidth);
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<SentComment[]>([]);
  const seq = useRef(0);
  const viewKey = `${cwd}|${scope}|${activeId}`;
  const lastKey = useRef('');

  useEffect(() => { setWidth(savedWidth); }, [savedWidth]);

  useEffect(() => {
    if (!open || !cwd) return;
    const my = ++seq.current;
    // 换了范围或对话：先清掉旧内容；只是文件有变化：保留旧内容，读完再换（不闪）
    if (lastKey.current !== viewKey) { setDiff(null); setError(null); lastKey.current = viewKey; }
    setLoading(true);
    api.gitDiff(cwd, scope, activeId)
      .then(d => { if (my === seq.current) { setDiff(d); setError(null); } })
      .catch(e => { if (my === seq.current) setError(errText(e)); })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, [open, cwd, scope, activeId, tick, viewKey]);

  if (!open || !cwd) return null;

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev: MouseEvent) => {
      w = Math.max(320, Math.min(window.innerWidth - 264 - 380, startW + startX - ev.clientX));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      void setPrefs({ reviewWidth: Math.round(w) });
    };
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onComment = (file: DiffFile, l: DiffLine, text: string) => {
    setSent(s => [...s, { key: lineKey(file, l), text: text.trim() }]);
    void send(commentMessage(file, l, text), []);
  };

  const files = diff?.files ?? [];
  const allPaths = files.flatMap(f => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
  const stateOf = (p: string) => status?.files.find(f => f.path === p);
  const notRepo = status && !status.repo;

  return (
    <aside className="review" style={{ width }} data-testid="review-panel">
      <div className="rev-drag" onMouseDown={startResize} title="拖动调整宽度" />
      <div className="rev-top">
        <div className="seg rev-seg">
          {SCOPES.map(s => (
            <button key={s.id} className={scope === s.id ? 'on' : ''} data-scope={s.id} title={s.title} onClick={() => setReviewScope(s.id)}>{s.label}</button>
          ))}
        </div>
        <span className="sp" />
        <button className="ibtn sm" title="刷新" onClick={() => useStore.setState(s => ({ gitTick: s.gitTick + 1 }))}>
          {loading ? <i className="spin" /> : <Icon name="refresh" size={14} />}
        </button>
        <button className="ibtn sm" title="关闭面板" data-testid="review-close" onClick={() => toggleReview(false)}><Icon name="x" size={14} /></button>
      </div>
      {notRepo ? (
        <div className="rev-body">
          <div className="rev-empty" data-testid="not-repo">
            <Icon name="branch" size={22} />
            <p>这个项目还不是 Git 仓库。改动面板要靠 Git 来对比改动、提交。</p>
            <button className="btn" data-testid="git-init" onClick={() => void gitInit(cwd)}>初始化 Git 仓库</button>
            <span className="hint">会在项目文件夹里运行 git init（默认分支 main），不会改动你的文件</span>
          </div>
        </div>
      ) : (
        <>
          <div className="rev-sub" data-testid="review-desc">
            <span className="rev-desc">
              {diff ? <>{diff.live && <span className="live-dot" />}{diff.desc}{files.length ? ` · ${files.length} 个文件` : ''}</> : error ? '' : '正在读取…'}
            </span>
            {scope === 'unstaged' && files.length > 0 && <button className="link sm" data-testid="stage-all" onClick={() => void gitAction('stage', cwd, allPaths)}>全部暂存</button>}
            {scope === 'staged' && files.length > 0 && <button className="link sm" data-testid="unstage-all" onClick={() => void gitAction('unstage', cwd, allPaths)}>全部取消暂存</button>}
            {scope === 'turn' && !diff?.live && files.length > 0 && (
              <ConfirmButton label="撤销这一轮" confirm="确定撤销这一轮的全部改动？" className="link sm danger" testId="revert-turn"
                onConfirm={() => void gitAction('revert', cwd, allPaths, 'turn')} />
            )}
          </div>
          <div className="rev-body">
            {error && <div className="notice error"><Icon name="alert" size={14} /><div>读取改动失败<code className="notice-detail">{error}</code></div></div>}
            {diff && !files.length && <div className="rev-empty" data-testid="review-empty"><p>{diff.empty ?? '没有改动'}</p></div>}
            {files.map(f => (
              <FileCard key={`${scope}:${f.path}`} file={f} scope={scope} state={stateOf(f.path)} live={!!diff?.live} cwd={cwd}
                sent={sent} onComment={onComment} />
            ))}
          </div>
          {status?.repo && <CommitBox cwd={cwd} status={status} />}
        </>
      )}
    </aside>
  );
}
