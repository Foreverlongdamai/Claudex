// 管理（M3）：Skills、MCP 服务器、Claude Code 设置，在一个大弹窗里分三个标签页。
import { useEffect, useMemo, useState } from 'react';
import type { McpServerInput, McpServerView, SettingsForm, SettingsScope, SettingsView, SkillDoc, SkillEntry } from '@shared/types';
import { checkSkill } from '@shared/skillFile';
import { isSecretKey, mask } from '@shared/claudeSettings';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Modal } from './Dialogs';

export type ManageTab = 'skills' | 'mcp' | 'settings';
const api = window.claudex;
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
const SOURCE_LABEL: Record<SkillEntry['source'], string> = { project: '项目', user: '用户', plugin: '插件 · 只读' };

// ---------------- Skills ----------------

function SkillsPane({ projectPath }: { projectPath: string | null }) {
  const { tryRunSkill, toast } = useStore.getState();
  const [list, setList] = useState<SkillEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [doc, setDoc] = useState<SkillDoc | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ scope: 'user' | 'project'; name: string; description: string } | null>(null);
  const load = async (select?: string) => {
    const l = await api.listSkillFiles(projectPath);
    setList(l);
    const target = select ?? doc?.entry.path ?? l[0]?.path;
    if (target) await open(target);
  };
  const open = async (file: string) => {
    try {
      const d = await api.readSkillFile(file);
      setDoc(d);
      setText(d.content);
      setErr(null);
    } catch (e) { setErr(errText(e)); }
  };
  useEffect(() => { void load(); }, [projectPath]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!doc && text !== doc.content;
  const live = useMemo(() => (doc && !doc.entry.readOnly ? checkSkill(text, doc.entry.path.split(/[\\/]/).slice(-2)[0]) : []), [text, doc]);
  const shown = (list ?? []).filter(s => !q || s.name.toLowerCase().includes(q.toLowerCase()) || s.description.toLowerCase().includes(q.toLowerCase()));
  const save = async () => {
    if (!doc) return;
    try {
      const d = await api.saveSkillFile(doc.entry.path, text);
      setDoc(d);
      setText(d.content);
      setErr(null);
      toast(`已保存 ${d.entry.name}：新对话里立刻能用`);
      setList(await api.listSkillFiles(projectPath));
    } catch (e) { setErr(errText(e)); }
  };
  const create = async () => {
    if (!creating) return;
    try {
      const d = await api.createSkill(creating.scope, projectPath, creating.name, creating.description);
      setCreating(null);
      await load(d.entry.path);
    } catch (e) { setErr(errText(e)); }
  };
  const remove = async () => {
    if (!doc || !confirm(`删除 Skill「${doc.entry.name}」？\n整个文件夹移到回收站。`)) return;
    try {
      await api.deleteSkill(doc.entry.path);
      setDoc(null);
      await load('');
    } catch (e) { setErr(errText(e)); }
  };
  const invokeName = doc ? (doc.entry.plugin ? `${doc.entry.plugin}:${doc.entry.name}` : doc.entry.name) : '';
  return (
    <div className="split" data-testid="skills-pane">
      <div className="slist">
        <div className="search"><Icon name="search" size={14} /><input value={q} placeholder={`搜索 ${list?.length ?? ''} 个 Skills…`} data-testid="skill-search" onChange={e => setQ(e.target.value)} /></div>
        {creating ? (
          <div className="screate" data-testid="skill-create-form">
            <select value={creating.scope} onChange={e => setCreating({ ...creating, scope: e.target.value as 'user' | 'project' })}>
              <option value="project" disabled={!projectPath}>项目级（只在这个项目，进 git）</option>
              <option value="user">用户级（所有项目都能用）</option>
            </select>
            <input autoFocus value={creating.name} placeholder="名字：小写字母、数字、-" data-testid="skill-new-name" onChange={e => setCreating({ ...creating, name: e.target.value })} />
            <input value={creating.description} placeholder="做什么、什么时候用" data-testid="skill-new-desc" onChange={e => setCreating({ ...creating, description: e.target.value })} />
            <div className="row-btns"><button className="btn sm" onClick={() => setCreating(null)}>取消</button><button className="btn sm primary" data-testid="skill-create" disabled={!creating.name.trim()} onClick={() => void create()}>新建</button></div>
          </div>
        ) : (
          <button className="btn sm full-btn" data-testid="skill-new" onClick={() => setCreating({ scope: projectPath ? 'project' : 'user', name: '', description: '' })}><Icon name="plus" size={13} />新建 Skill</button>
        )}
        {list === null && <div className="q-empty"><i className="spin" /> 正在读取…</div>}
        {shown.map(s => (
          <button key={s.path} className={`skill${doc?.entry.path === s.path ? ' active' : ''}`} data-testid="skill-item" data-skill={s.name} data-source={s.source} onClick={() => { if (!dirty || confirm('还没保存，确定切换吗？')) void open(s.path); }}>
            <span className="sn">{s.name}<span className="src">{s.plugin ? `${s.plugin} · 只读` : SOURCE_LABEL[s.source]}</span>{s.problems > 0 && <span className="warn" title="格式有问题">⚠</span>}</span>
            <span className="sd">{s.description}</span>
          </button>
        ))}
      </div>
      <div className="sedit">
        {doc ? (
          <>
            <div className="sbar">
              <span className="mono" title={doc.entry.path}>{doc.entry.path.split(/[\\/]/).slice(-2).join('/')}</span>
              {doc.entry.readOnly ? <span className="ro">只读（插件自带）</span> : live.length ? <span className="badc" data-testid="skill-problems">⚠ {live.length} 个问题</span> : <span className="okc" data-testid="skill-ok">✓ 格式正确</span>}
              <span className="sp" />
              <button className="btn sm" data-testid="skill-try" title={`新开一个对话，输入框里填好 /${invokeName}`} onClick={() => tryRunSkill(invokeName)}>在新对话中试运行</button>
              {!doc.entry.readOnly && <button className="btn sm ghost danger-text" data-testid="skill-delete" onClick={() => void remove()}>删除</button>}
              {!doc.entry.readOnly && <button className="btn sm primary" data-testid="skill-save" disabled={!dirty || live.length > 0} onClick={() => void save()}>保存</button>}
            </div>
            <textarea className="editor" spellCheck={false} readOnly={doc.entry.readOnly} value={text} data-testid="skill-editor" onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.ctrlKey && e.key === 's') { e.preventDefault(); if (dirty && !live.length) void save(); } }} />
            {live.length > 0 && <ul className="problems">{live.map(p => <li key={p}>{p}</li>)}</ul>}
          </>
        ) : <div className="q-empty">选一个 Skill 看看，或者新建一个。</div>}
        {err && <p className="field-err" data-testid="skill-error">{err}</p>}
      </div>
    </div>
  );
}

// ---------------- MCP 服务器 ----------------

const SCOPE_LABEL: Record<string, string> = { user: '用户级', project: '项目级', local: '本地级', plugin: '插件', claudeai: 'claude.ai', managed: '管理员', dynamic: '临时' };
const STATUS_LABEL: Record<string, [string, string]> = {
  connected: ['已连接', 'ok'], failed: ['连接失败', 'bad'], 'needs-auth': ['需要登录', 'warn'], pending: ['还在连', 'warn'], disabled: ['停用', 'off']
};
const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);
const kv = (s: string, sep: RegExp) => Object.fromEntries(lines(s).map(l => { const m = sep.exec(l); return m ? [l.slice(0, m.index).trim(), l.slice(m.index + m[0].length).trim()] : [l, '']; }));

function McpForm({ projectPath, init, onDone }: { projectPath: string; init: McpServerInput & { old?: { name: string; scope: string } }; onDone: (saved: boolean) => void }) {
  const [f, setF] = useState(init);
  const [args, setArgs] = useState((init.args ?? []).join('\n'));
  const [env, setEnv] = useState(Object.entries(init.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  const [headers, setHeaders] = useState(Object.entries(init.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    const input: McpServerInput = f.type === 'stdio'
      ? { name: f.name.trim(), scope: f.scope, type: 'stdio', command: f.command ?? '', args: lines(args), env: kv(env, /=/) }
      : { name: f.name.trim(), scope: f.scope, type: f.type, url: f.url ?? '', headers: kv(headers, /:\s*/) };
    try {
      await api.saveMcpServer(projectPath, input, init.old ?? null);
      onDone(true);
    } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  return (
    <div className="mcp-form form" data-testid="mcp-form">
      <label>名称<input value={f.name} data-testid="mcp-name" onChange={e => setF({ ...f, name: e.target.value })} /></label>
      <label>范围<select value={f.scope} data-testid="mcp-scope" onChange={e => setF({ ...f, scope: e.target.value as McpServerInput['scope'] })}>
        <option value="project">项目级（写进项目的 .mcp.json，进 git）</option>
        <option value="local">本地级（只有你自己、只在这个项目）</option>
        <option value="user">用户级（你所有的项目）</option>
      </select></label>
      <label>类型<select value={f.type} data-testid="mcp-type" onChange={e => setF({ ...f, type: e.target.value as McpServerInput['type'] })}>
        <option value="stdio">stdio（在本机运行一个命令）</option><option value="http">HTTP</option><option value="sse">SSE</option>
      </select></label>
      {f.type === 'stdio' ? <>
        <label>命令<input value={f.command ?? ''} placeholder="比如 npx、node、uvx" data-testid="mcp-command" onChange={e => setF({ ...f, command: e.target.value })} /></label>
        <label>参数<small>一行一个</small><textarea rows={3} value={args} data-testid="mcp-args" onChange={e => setArgs(e.target.value)} /></label>
        <label>环境变量<small>一行一个，KEY=VALUE</small><textarea rows={3} value={env} onChange={e => setEnv(e.target.value)} /></label>
      </> : <>
        <label className="full">地址<input value={f.url ?? ''} placeholder="https://…" data-testid="mcp-url" onChange={e => setF({ ...f, url: e.target.value })} /></label>
        <label className="full">请求头<small>一行一个，Name: value</small><textarea rows={3} value={headers} onChange={e => setHeaders(e.target.value)} /></label>
      </>}
      {err && <p className="field-err full">{err}</p>}
      <div className="row-btns full">
        <span className="note">用 Claude Code 自己的 <code>claude mcp add-json</code> 保存，和命令行里加的一样</span>
        <button className="btn sm" onClick={() => onDone(false)}>取消</button>
        <button className="btn sm primary" data-testid="mcp-save" disabled={busy || !f.name.trim()} onClick={() => void save()}>{busy ? '正在保存…' : '保存'}</button>
      </div>
    </div>
  );
}

function McpPane({ projectPath }: { projectPath: string | null }) {
  const { toast } = useStore.getState();
  const [list, setList] = useState<McpServerView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<(McpServerInput & { old?: { name: string; scope: string } }) | null>(null);
  const load = async () => {
    if (!projectPath) return;
    setBusy(true);
    setErr(null);
    try { setList(await api.listMcpServers(projectPath)); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  useEffect(() => { setList(null); void load(); }, [projectPath]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!projectPath) return <div className="mpad"><div className="q-empty">先在左栏选一个项目：MCP 服务器按项目查（项目级、本地级的只在那个项目里）。</div></div>;
  const remove = async (s: McpServerView) => {
    if (!confirm(`删除 MCP 服务器「${s.name}」（${SCOPE_LABEL[s.scope] ?? s.scope}）？`)) return;
    try { await api.removeMcpServer(projectPath, s.name, s.scope); toast(`已删除 ${s.name}`); await load(); } catch (e) { setErr(errText(e)); }
  };
  const approve = async (s: McpServerView) => { await api.setMcpApproval(projectPath, s.name, true); await load(); };
  return (
    <div className="mpad" data-testid="mcp-pane">
      <div className="mtop">
        <span className="note">用户级、项目级（.mcp.json）、本地级的都在这里；状态是实际连一次查出来的。项目里没批准过的服务器不会启动。</span>
        <span className="sp" />
        <button className="btn sm" data-testid="mcp-refresh" disabled={busy} onClick={() => void load()}>{busy ? <><i className="spin" />正在检查</> : '检查状态'}</button>
        <button className="btn primary sm" data-testid="mcp-add" onClick={() => setEditing({ name: '', scope: 'project', type: 'stdio', command: '', args: [] })}><Icon name="plus" size={13} />添加服务器</button>
      </div>
      {editing && <McpForm projectPath={projectPath} init={editing} onDone={saved => { setEditing(null); if (saved) { toast('已保存，新对话和下一条消息起生效'); void load(); } }} />}
      {err && <p className="field-err">{err}</p>}
      {list === null ? <div className="q-empty"><i className="spin" /> 正在连各个服务器，查状态…</div> : list.length === 0 ? <div className="q-empty">还没有 MCP 服务器。</div> : (
        <table className="tbl">
          <thead><tr><th>名称</th><th>类型</th><th>范围</th><th>状态</th><th>工具</th><th /></tr></thead>
          <tbody>{list.map(s => {
            const [label, tone] = s.unapproved ? ['没批准（不启动）', 'off'] : STATUS_LABEL[s.status] ?? [s.status, 'off'];
            return (
              <tr key={`${s.scope}:${s.name}`} data-testid="mcp-row" data-server={s.name} data-status={s.unapproved ? 'unapproved' : s.status}>
                <td><b className="mono">{s.name}</b><div className="td-sub" title={s.target}>{s.target}</div></td>
                <td>{s.type}</td>
                <td>{SCOPE_LABEL[s.scope] ?? s.scope}</td>
                <td><span className={`mst ${tone}`} title={s.error ?? ''}>{label}</span></td>
                <td title={s.tools.join('\n')}>{s.tools.length || '—'}</td>
                <td className="acts">
                  {s.unapproved && <button className="link sm" data-testid="mcp-approve" onClick={() => void approve(s)}>批准</button>}
                  {s.editable && s.input && <button className="link sm" data-testid="mcp-edit" onClick={() => setEditing({ ...s.input!, old: { name: s.name, scope: s.scope } })}>编辑</button>}
                  {s.editable && <button className="link sm danger" data-testid="mcp-remove" onClick={() => void remove(s)}>删除</button>}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </div>
  );
}

// ---------------- Claude Code 设置 ----------------

const SCOPE_FILES: Record<SettingsScope, string> = { user: '用户级 · ~/.claude/settings.json', project: '项目级 · .claude/settings.json（进 git）', local: '本地级 · .claude/settings.local.json（只有你）' };

function SettingsPane({ projectPath }: { projectPath: string | null }) {
  const { toast } = useStore.getState();
  const [scope, setScope] = useState<SettingsScope>('user');
  const [view, setView] = useState<SettingsView | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [shown, setShown] = useState<Record<number, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const load = async (s = scope) => {
    setErr(null);
    try {
      const v = await api.readClaudeSettings(s, projectPath);
      setView(v);
      setForm(v.form);
      setShown({});
    } catch (e) { setErr(errText(e)); }
  };
  useEffect(() => { void load(); }, [scope, projectPath]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!view && !!form && JSON.stringify(view.form) !== JSON.stringify(form);
  const save = async () => {
    if (!view || !form) return;
    try {
      const v = await api.saveClaudeSettings(scope, projectPath, view.form, form);
      setView(v);
      setForm(v.form);
      setErr(null);
      toast('已保存：新对话和每个对话的下一条消息起生效');
    } catch (e) { setErr(errText(e)); }
  };
  const set = (patch: Partial<SettingsForm>) => setForm(f => (f ? { ...f, ...patch } : f));
  const listField = (k: 'allow' | 'ask' | 'deny', label: string, hint: string) => (
    <div className="row top"><div className="lbl">{label}<small>{hint}</small></div><div className="val">
      <textarea rows={Math.max(2, Math.min(8, form![k].length + 1))} className="mono-in" value={form![k].join('\n')} data-testid={`set-${k}`} onChange={e => set({ [k]: e.target.value.split('\n') })} />
    </div></div>
  );
  return (
    <div className="mpad settings" data-testid="settings-pane">
      <div className="seg scope-seg">
        {(['user', 'project', 'local'] as SettingsScope[]).map(s => (
          <button key={s} className={scope === s ? 'on' : ''} data-testid={`set-scope-${s}`} disabled={s !== 'user' && !projectPath} onClick={() => { if (!dirty || confirm('还没保存，确定切换吗？')) setScope(s); }}>{SCOPE_FILES[s]}</button>
        ))}
      </div>
      {view && <p className="note mono-p" data-testid="set-path">{view.path}{view.exists ? '' : '（还没有这个文件，保存时新建）'}</p>}
      {view?.error && <p className="field-err">{view.error}</p>}
      {form && !view?.error && <>
        <div className="sec">常用</div>
        <div className="row"><div className="lbl">默认模型<small>空着表示用 Claude Code 的默认</small></div><div className="val">
          <input list="model-names" value={form.model} placeholder="opus / sonnet / haiku 或完整的模型 ID" data-testid="set-model" onChange={e => set({ model: e.target.value })} />
          <datalist id="model-names"><option value="opus" /><option value="sonnet" /><option value="haiku" /></datalist>
        </div></div>
        <div className="row"><div className="lbl">默认权限模式</div><div className="val">
          <select value={form.defaultMode} data-testid="set-mode" onChange={e => set({ defaultMode: e.target.value })}>
            <option value="">不设</option><option value="default">默认：询问</option><option value="acceptEdits">自动接受编辑</option><option value="plan">计划模式</option><option value="bypassPermissions">完全访问</option>
          </select></div></div>
        <div className="sec">环境变量</div>
        {form.env.map((e, i) => {
          const secret = isSecretKey(e.key);
          return (
            <div className="row env-row" key={i} data-testid="set-env-row">
              <input className="mono-in" value={e.key} placeholder="名字" onChange={ev => set({ env: form.env.map((x, j) => (j === i ? { ...x, key: ev.target.value } : x)) })} />
              {secret && !shown[i]
                ? <input className="mono-in" value={mask(e.value)} readOnly onFocus={() => setShown({ ...shown, [i]: true })} title="点一下显示" />
                : <input className="mono-in" value={e.value} placeholder="值" onChange={ev => set({ env: form.env.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)) })} />}
              {secret && <button className="btn sm ghost" onClick={() => setShown({ ...shown, [i]: !shown[i] })}>{shown[i] ? '隐藏' : '显示'}</button>}
              <button className="ibtn sm" title="删掉这个变量" onClick={() => set({ env: form.env.filter((_, j) => j !== i) })}><Icon name="x" size={13} /></button>
            </div>
          );
        })}
        <button className="btn sm" data-testid="set-env-add" onClick={() => set({ env: [...form.env, { key: '', value: '' }] })}><Icon name="plus" size={13} />加一个环境变量</button>
        <div className="sec">权限规则</div>
        {listField('allow', '总是允许', '一行一条，比如 Bash(npm test)、Read(./docs/**)')}
        {listField('ask', '总是询问', '一行一条')}
        {listField('deny', '总是拒绝', '一行一条，比如 Bash(curl *)')}
        <div className="sec">Hooks</div>
        <div className="row top"><div className="lbl">hooks<small>JSON，和 settings.json 里的写法一样；空着表示没有</small></div><div className="val">
          <textarea rows={6} className="mono-in" spellCheck={false} value={form.hooks} data-testid="set-hooks" onChange={e => set({ hooks: e.target.value })} />
        </div></div>
      </>}
      {err && <p className="field-err" data-testid="set-error">{err}</p>}
      <div className="mfoot">
        <span className="note">保存时只改动过的项，其他内容原样保留；保存前备份成 .claudex-bak</span>
        <button className="btn" disabled={!dirty} onClick={() => view && setForm(view.form)}>还原</button>
        <button className="btn primary" data-testid="set-save" disabled={!dirty} onClick={() => void save()}>保存</button>
      </div>
    </div>
  );
}

export function ManageDialog({ tab }: { tab: ManageTab }) {
  const projectPath = useStore(s => s.activeProject);
  const project = useStore(s => s.app?.projects.find(p => p.path === s.activeProject));
  const { closeDialog } = useStore.getState();
  const [cur, setCur] = useState<ManageTab>(tab);
  useEffect(() => setCur(tab), [tab]);
  return (
    <Modal wide onClose={closeDialog}>
      <div className="manage" data-testid="manage-dialog">
        <div className="mhead">
          <div className="mtabs">
            <button className={`mtab${cur === 'skills' ? ' active' : ''}`} data-testid="manage-tab-skills" onClick={() => setCur('skills')}>Skills</button>
            <button className={`mtab${cur === 'mcp' ? ' active' : ''}`} data-testid="manage-tab-mcp" onClick={() => setCur('mcp')}>MCP 服务器</button>
            <button className={`mtab${cur === 'settings' ? ' active' : ''}`} data-testid="manage-tab-settings" onClick={() => setCur('settings')}>Claude Code 设置</button>
          </div>
          <span className="sp" />
          {project && <span className="note">项目：{project.name}</span>}
          <button className="ibtn" onClick={closeDialog}><Icon name="x" /></button>
        </div>
        <div className="mbody">
          {cur === 'skills' && <SkillsPane projectPath={projectPath} />}
          {cur === 'mcp' && <McpPane projectPath={projectPath} />}
          {cur === 'settings' && <SettingsPane projectPath={projectPath} />}
        </div>
      </div>
    </Modal>
  );
}
