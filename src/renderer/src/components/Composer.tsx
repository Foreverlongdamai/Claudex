// 输入框：/ 命令菜单、@ 引用文件、粘贴图片、模型选择器、上下文用量、发送/停止；下方是模式菜单、项目、分支。
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { EFFORTS, type CommandInfo, type Effort, type ImageAttachment, type ModeId } from '@shared/types';
import { MODES, MODE_ORDER } from '../modes';
import { useCurrentSettings, useStore } from '../store';
import { Icon } from './Icon';

const EFFORT_LABEL: Record<Effort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
// 模型列表还没加载出来时，常见别名先显示成好看的名字
const ALIAS_NAME: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);
  return ref;
}

export function ModeMenu() {
  const settings = useCurrentSettings();
  const requestMode = useStore(s => s.requestMode);
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  if (!settings) return null;
  const mode = MODES[settings.mode];
  const item = (m: ModeId) => (
    <button key={m} className={`mitem${m === 'bypassPermissions' ? ' danger' : m === 'skills' ? ' env' : ''}${m === settings.mode ? ' on' : ''}`}
      data-mode={m} onClick={() => { setOpen(false); requestMode(m); }}>
      <Icon name={MODES[m].icon} />
      <span className="mi"><b>{MODES[m].label}</b><span>{MODES[m].desc}</span></span>
      <Icon name="check" size={14} className="tick" />
    </button>
  );
  return (
    <div className="dd" ref={ref}>
      <button className={`mchip mode-${settings.mode}`} data-testid="mode-button" onClick={() => setOpen(o => !o)}>
        <Icon name={mode.icon} size={14} />{mode.label}<Icon name="down" size={14} />
      </button>
      {open && (
        <div className="menu">
          <div className="menu-sec">Claude Code 自带</div>
          {MODE_ORDER.filter(m => MODES[m].group === 'builtin').map(item)}
          <div className="menu-sep" />
          <div className="menu-sec">自定义</div>
          {MODE_ORDER.filter(m => MODES[m].group === 'custom').map(item)}
          <div className="menu-foot">Shift+Tab 依次切换</div>
        </div>
      )}
    </div>
  );
}

function ModelPicker() {
  const settings = useCurrentSettings();
  const models = useStore(s => s.models);
  const modelsError = useStore(s => s.modelsError);
  const env = useStore(s => s.env);
  const setModel = useStore(s => s.setModel);
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  if (!settings) return null;
  const current = models.find(m => m.value === settings.model);
  const efforts = current?.efforts.length ? current.efforts : EFFORTS;
  const pickModel = (value: string) => {
    const m = models.find(x => x.value === value);
    const allowed = m?.efforts.length ? m.efforts : EFFORTS;
    void setModel(value, allowed.includes(settings.effort) ? settings.effort : allowed.includes('high') ? 'high' : allowed[allowed.length - 1]);
  };
  const fastReason = env?.fastUnavailableReason ?? (current && !current.supportsFast ? `${current.displayName} 不支持快速模式` : null);
  return (
    <div className="dd" ref={ref}>
      <button className="chip" data-testid="model-button" onClick={() => setOpen(o => !o)}>
        <span>{current?.displayName ?? ALIAS_NAME[settings.model] ?? settings.model} · {EFFORT_LABEL[settings.effort]}</span><Icon name="down" size={14} />
      </button>
      {open && (
        <div className="pop">
          <div className="pop-sec">模型</div>
          {models.length === 0 && <div className="pop-note">{modelsError ? `读取模型列表失败：${modelsError}` : '正在读取模型列表…'}</div>}
          {models.map(m => (
            <button key={m.value} className={`opt${m.value === settings.model ? ' on' : ''}`} onClick={() => pickModel(m.value)}>
              <span className="opt-main">{m.displayName}</span>
              <span className="opt-desc">{m.description}</span>
              <Icon name="check" size={14} className="tick" />
            </button>
          ))}
          <div className="pop-sec">思考强度</div>
          <div className="seg">
            {EFFORTS.map(e => (
              <button key={e} className={e === settings.effort ? 'on' : ''} disabled={!efforts.includes(e)} onClick={() => void setModel(settings.model, e)}>{EFFORT_LABEL[e]}</button>
            ))}
          </div>
          <div className="pop-sec">速度</div>
          <div className="seg">
            <button className="on">标准</button>
            <button disabled title={fastReason ?? undefined}>⚡ 快速</button>
          </div>
          {fastReason && <div className="pop-note">{fastReason}</div>}
          <div className="pop-foot">从下一条消息开始生效</div>
        </div>
      )}
    </div>
  );
}

function UsageRing() {
  const usage = useStore(s => (s.activeId ? s.convs[s.activeId]?.usage : undefined));
  const pct = usage ? Math.min(100, Math.max(0, usage.percentage)) : 0;
  const c = 2 * Math.PI * 7;
  return (
    <span className="ring" title={usage ? `上下文已用 ${pct.toFixed(0)}%（${usage.totalTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens）` : '上下文用量（第一轮回复后显示）'}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r="7" fill="none" stroke="var(--border-strong)" strokeWidth="2" />
        <circle cx="9" cy="9" r="7" fill="none" stroke={pct > 85 ? 'var(--danger)' : 'var(--muted)'} strokeWidth="2" strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 9 9)" />
      </svg>
      {usage ? `${pct.toFixed(0)}%` : ''}
    </span>
  );
}

interface Popup {
  kind: 'slash' | 'file';
  items: Array<{ key: string; desc: string }>;
  sel: number;
  start: number;
  end: number;
}

function readImage(file: File): Promise<ImageAttachment | null> {
  return new Promise(resolve => {
    if (!file.type.startsWith('image/') || file.size > MAX_IMAGE_BYTES) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ mediaType: file.type, data: url.slice(url.indexOf(',') + 1), name: file.name || '粘贴的图片' });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function Composer() {
  const activeId = useStore(s => s.activeId);
  const status = useStore(s => (s.activeId ? s.convs[s.activeId]?.status : 'new'));
  const projectPath = useStore(s => (s.activeId ? s.convs[s.activeId]?.meta.projectPath : s.activeProject) ?? null);
  const project = useStore(s => s.app?.projects.find(p => p.path === projectPath));
  const branch = useStore(s => (projectPath ? s.branches[projectPath] : null));
  const sentToken = useStore(s => s.sentToken);
  const send = useStore(s => s.send);
  const interrupt = useStore(s => s.interrupt);
  const toast = useStore(s => s.toast);
  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const commands = useRef<{ project: string; list: CommandInfo[] } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = status === 'running' || status === 'starting';

  // 真正发出去之后才清空（遇到 MCP 批准弹窗时，内容要留着）
  useEffect(() => { setText(''); setImages([]); setPopup(null); }, [sentToken]);
  useEffect(() => { input.current?.focus(); }, [activeId, projectPath]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [text]);

  const addImages = async (files: File[]) => {
    const read = (await Promise.all(files.map(readImage))).filter((x): x is ImageAttachment => !!x);
    if (read.length < files.length) toast('只支持图片，单张不超过 5 MB');
    setImages(cur => [...cur, ...read].slice(0, MAX_IMAGES));
  };

  const refreshPopup = async (value: string, caret: number) => {
    const before = value.slice(0, caret);
    let m: RegExpExecArray | null;
    if (projectPath && (m = /^\/(\S*)$/.exec(before))) {
      if (commands.current?.project !== projectPath) {
        commands.current = { project: projectPath, list: [] };
        try { commands.current.list = await window.claudex.listCommands(projectPath); } catch { /* 拿不到就不提示 */ }
      }
      const q = m[1].toLowerCase();
      const list = commands.current.list;
      const starts = list.filter(c => c.name.toLowerCase().startsWith(q));
      const contains = list.filter(c => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)));
      const items = [...starts, ...contains].slice(0, 30).map(c => ({ key: '/' + c.name, desc: c.description }));
      setPopup(items.length ? { kind: 'slash', items, sel: 0, start: 0, end: caret } : null);
    } else if (projectPath && (m = /(^|\s)@(\S*)$/.exec(before))) {
      const files = await window.claudex.listFiles(projectPath, m[2]);
      const items = files.slice(0, 30).map(f => ({ key: '@' + f, desc: '' }));
      setPopup(items.length ? { kind: 'file', items, sel: 0, start: caret - m[2].length - 1, end: caret } : null);
    } else setPopup(null);
  };

  const pick = (i: number) => {
    if (!popup) return;
    const it = popup.items[i];
    const next = text.slice(0, popup.start) + it.key + ' ' + text.slice(popup.end);
    const caret = popup.start + it.key.length + 1;
    setText(next);
    setPopup(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(caret, caret); });
  };

  const submit = () => {
    if (!text.trim() && !images.length) return;
    void send(text, images);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // 输入法正在选字
    if (popup) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPopup({ ...popup, sel: (popup.sel + 1) % popup.items.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPopup({ ...popup, sel: (popup.sel - 1 + popup.items.length) % popup.items.length }); return; }
      if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); pick(popup.sel); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPopup(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        {popup && (
          <div className="popup">
            <div className="pg">{popup.kind === 'slash' ? '命令和 Skills' : '文件'}</div>
            {popup.items.map((it, i) => (
              <div key={it.key} className={`pi${i === popup.sel ? ' sel' : ''}`} onMouseDown={e => { e.preventDefault(); pick(i); }}>
                <span className="pk">{it.key}</span><span className="pd">{it.desc}</span>
              </div>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="attachments">
            {images.map((img, i) => (
              <div className="thumb" key={i} title={img.name}>
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
                <button onClick={() => setImages(cur => cur.filter((_, j) => j !== i))} title="移除"><Icon name="x" size={12} /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          data-testid="composer-input"
          rows={1}
          value={text}
          disabled={!projectPath}
          placeholder={projectPath ? '给 Claude 发消息，@ 引用文件，/ 打开命令和 Skills，可以直接粘贴图片' : '先在左边添加一个项目'}
          onChange={e => { setText(e.target.value); void refreshPopup(e.target.value, e.target.selectionStart); }}
          onClick={e => void refreshPopup(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={e => {
            const files = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'));
            if (files.length) { e.preventDefault(); void addImages(files); }
          }}
        />
        <div className="cbar">
          <button className="chip" title="添加图片" onClick={() => fileInput.current?.click()}><Icon name="plus" /></button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={e => { void addImages([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <span className="sp" />
          <ModelPicker />
          <UsageRing />
          {running ? (
            <button className="send" data-testid="stop-button" title="停止（Esc）" onClick={() => void interrupt()}><Icon name="stop" /></button>
          ) : (
            <button className="send" data-testid="send-button" title="发送（Enter）" disabled={!projectPath || (!text.trim() && !images.length)} onClick={submit}><Icon name="up" /></button>
          )}
        </div>
      </div>
      <div className="under">
        <ModeMenu />
        {project && <span className="uchip" title={project.path}><Icon name="folder" size={14} />{project.name}</span>}
        {branch && <span className="uchip" title="Git 分支"><Icon name="branch" size={14} />{branch}</span>}
        <span className="sp" />
        <span className="uhint">Enter 发送 · Shift+Enter 换行 · Shift+Tab 切换模式</span>
      </div>
    </div>
  );
}
