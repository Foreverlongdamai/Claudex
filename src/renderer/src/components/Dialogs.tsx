// 弹窗：切到完全访问的确认、项目 MCP 服务器批准、添加项目时的信任确认、设置。
import { useState, type ReactNode } from 'react';
import { EFFORTS, type Effort, type ModeId } from '@shared/types';
import { MODES, MODE_ORDER } from '../modes';
import { useStore } from '../store';
import { Icon } from './Icon';

const EFFORT_LABEL: Record<Effort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };

function Modal({ children, wide, onClose }: { children: ReactNode; wide?: boolean; onClose: () => void }) {
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog">{children}</div>
    </div>
  );
}

function BypassDialog({ convId }: { convId: string | null }) {
  const { applyMode, closeDialog } = useStore.getState();
  const blacklist = useStore(s => s.app?.prefs.blacklist ?? []);
  const [noAsk, setNoAsk] = useState(false);
  return (
    <Modal onClose={closeDialog}>
      <h2><Icon name="unlock" />切换到完全访问？</h2>
      <p>切换后，Claude 改文件、运行命令都<b>直接执行，不再询问</b>。只对当前对话生效。</p>
      <div className="warnbox">
        下面这些高危操作仍然会被拦截（保底黑名单）：
        <ul>{blacklist.filter(r => r.enabled).map(r => <li key={r.id}>{r.label}</li>)}</ul>
      </div>
      <div className="mfoot">
        <label><input type="checkbox" checked={noAsk} onChange={e => setNoAsk(e.target.checked)} /> 不再提示</label>
        <button className="btn" onClick={closeDialog}>取消</button>
        <button className="btn red" data-testid="confirm-bypass" onClick={() => void applyMode(convId, 'bypassPermissions', noAsk)}>切换到完全访问</button>
      </div>
    </Modal>
  );
}

function McpDialog({ projectPath, servers }: { projectPath: string; servers: { name: string; command: string }[] }) {
  const { finishMcpGate, closeDialog } = useStore.getState();
  const project = useStore(s => s.app?.projects.find(p => p.path === projectPath));
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const all = (v: boolean) => setDecisions(Object.fromEntries(servers.map(s => [s.name, v])));
  const complete = servers.every(s => s.name in decisions);
  return (
    <Modal onClose={closeDialog}>
      <h2><Icon name="plug" />这个项目带了 MCP 服务器</h2>
      <p>项目「{project?.name}」的 <code>.mcp.json</code> 里配置了下面的服务器。启动后它们会在你的电脑上运行这些命令，请只批准你认识的。</p>
      <div className="mcp-list">
        {servers.map(s => (
          <div className="mcp-row" key={s.name}>
            <div className="mcp-main"><b>{s.name}</b><code>{s.command}</code></div>
            <div className="seg">
              <button className={decisions[s.name] === true ? 'on' : ''} onClick={() => setDecisions(d => ({ ...d, [s.name]: true }))}>启动</button>
              <button className={decisions[s.name] === false ? 'on' : ''} onClick={() => setDecisions(d => ({ ...d, [s.name]: false }))}>不启动</button>
            </div>
          </div>
        ))}
      </div>
      <div className="mfoot">
        <span className="note">选择会记住，以后不再问</span>
        <button className="btn ghost" onClick={() => all(false)}>全部不启动</button>
        <button className="btn ghost" onClick={() => all(true)}>全部启动</button>
        <button className="btn primary" disabled={!complete} onClick={() => void finishMcpGate(decisions)}>确定并发送</button>
      </div>
    </Modal>
  );
}

function TrustDialog() {
  const d = useStore(s => s.dialog);
  const { confirmTrust, closeDialog } = useStore.getState();
  if (d?.kind !== 'trust') return null;
  const { check } = d;
  return (
    <Modal onClose={closeDialog}>
      <h2><Icon name="folderPlus" />添加项目「{check.name}」</h2>
      <p className="mono-p">{check.path}</p>
      <div className="warnbox">
        这个项目自带了会自动运行的配置，只添加你信任的项目：
        <ul>
          {check.hooks > 0 && <li>{check.hooks} 个 hook：Claude 工作时会自动执行命令</li>}
          {check.mcpServers.map(s => <li key={s.name}>MCP 服务器 <b>{s.name}</b>：<code>{s.command}</code>（第一次对话前会单独问你要不要启动）</li>)}
        </ul>
      </div>
      <div className="mfoot">
        <button className="btn" onClick={closeDialog}>取消</button>
        <button className="btn primary" onClick={() => void confirmTrust()}>信任并添加</button>
      </div>
    </Modal>
  );
}

function SettingsDialog() {
  const app = useStore(s => s.app)!;
  const env = useStore(s => s.env);
  const models = useStore(s => s.models);
  const { setPrefs, closeDialog, setTheme } = useStore.getState();
  const prefs = app.prefs;
  const [bash, setBash] = useState(prefs.gitBashPath ?? '');
  return (
    <Modal wide onClose={closeDialog}>
      <div className="mhead"><h2><Icon name="gear" />设置</h2><span className="sp" /><button className="ibtn" onClick={closeDialog}><Icon name="x" /></button></div>
      <div className="settings">
        <div className="sec">新对话的默认设置</div>
        <div className="row"><div className="lbl">模式</div><div className="val">
          <select value={prefs.defaultMode} onChange={e => void setPrefs({ defaultMode: e.target.value as ModeId })}>
            {MODE_ORDER.map(m => <option key={m} value={m}>{MODES[m].label}</option>)}
          </select></div></div>
        <div className="row"><div className="lbl">模型</div><div className="val">
          <select value={prefs.defaultModel} onChange={e => void setPrefs({ defaultModel: e.target.value })}>
            {!models.some(m => m.value === prefs.defaultModel) && <option value={prefs.defaultModel}>{prefs.defaultModel}</option>}
            {models.map(m => <option key={m.value} value={m.value}>{m.displayName}</option>)}
          </select></div></div>
        <div className="row"><div className="lbl">思考强度</div><div className="val">
          <select value={prefs.defaultEffort} onChange={e => void setPrefs({ defaultEffort: e.target.value as Effort })}>
            {EFFORTS.map(e => <option key={e} value={e}>{EFFORT_LABEL[e]}</option>)}
          </select></div></div>

        <div className="sec">权限</div>
        <div className="row"><div className="lbl">切到完全访问前确认<small>关掉后切换时不再弹窗</small></div><div className="val">
          <button className={`mini-sw${prefs.skipBypassConfirm ? '' : ' on'}`} onClick={() => void setPrefs({ skipBypassConfirm: !prefs.skipBypassConfirm })} /></div></div>
        <div className="row top"><div className="lbl">保底黑名单<small>任何模式下都拦截</small></div><div className="val col-val">
          {prefs.blacklist.map(r => (
            <label key={r.id} className="rule-row">
              <button className={`mini-sw${r.enabled ? ' on' : ''}`} onClick={() => void setPrefs({ blacklist: prefs.blacklist.map(x => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) })} />
              {r.label}
            </label>
          ))}
        </div></div>

        <div className="sec">运行环境</div>
        <div className="row top"><div className="lbl">Git Bash<small>Claude 运行 Bash 命令要用</small></div><div className="val col-val">
          <div className={`env-line${env?.gitBashPath ? ' ok' : ' bad'}`}>
            <Icon name={env?.gitBashPath ? 'check' : 'alert'} size={14} />
            {env?.gitBashPath ? `${env.gitBashPath}（${env.gitBashSource === 'prefs' ? '手动指定' : '自动找到'}）` : '没找到 Git Bash：Claude 只能用 PowerShell，部分 Skills 会用不了'}
          </div>
          <div className="inline">
            <input value={bash} placeholder="手动指定 bash.exe 的路径，留空表示自动查找" onChange={e => setBash(e.target.value)} />
            <button className="btn sm" onClick={() => void setPrefs({ gitBashPath: bash.trim() || null })}>保存</button>
          </div>
          <small className="hint">改完对新开的对话生效</small>
        </div></div>
        <div className="row"><div className="lbl">同时运行的对话上限<small>每个约占 250 MB 内存</small></div><div className="val">
          <input type="number" min={1} max={16} value={prefs.maxLiveSessions} onChange={e => void setPrefs({ maxLiveSessions: Math.max(1, Math.min(16, Number(e.target.value) || 4)) })} style={{ width: 80 }} /></div></div>
        <div className="row"><div className="lbl">主题</div><div className="val">
          <select value={prefs.theme} onChange={e => void setTheme(e.target.value as 'dark' | 'light')}><option value="dark">深色</option><option value="light">浅色</option></select></div></div>
        <div className="row"><div className="lbl">API</div><div className="val">{env?.relayHost ? `走中转：${env.relayHost}（令牌在 Claude Code 的设置里，Claudex 不读取也不保存）` : '直连 Anthropic API'}</div></div>
        <div className="row"><div className="lbl">版本</div><div className="val">Claudex {env?.appVersion}</div></div>
      </div>
    </Modal>
  );
}

export function Dialogs() {
  const d = useStore(s => s.dialog);
  if (!d) return null;
  switch (d.kind) {
    case 'bypass': return <BypassDialog convId={d.convId} />;
    case 'mcp': return <McpDialog projectPath={d.projectPath} servers={d.servers} />;
    case 'trust': return <TrustDialog />;
    case 'settings': return <SettingsDialog />;
  }
}
