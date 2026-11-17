// 输入框：/ 命令菜单、@ 引用文件、粘贴图片、模型选择器、上下文用量、发送/停止；下方是模式菜单、项目、分支。
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { EFFORTS, type CommandInfo, type Effort, type FileAttachment, type ImageAttachment, type ModeId } from '@shared/types';
import { DROP_EVENT, type DroppedFiles } from '../drop';
import { MODES, MODE_ORDER } from '../modes';
import { inWorktree } from '@shared/conv';
import { useActiveCwd, useCurrentSettings, useStore } from '../store';
import { FileChip } from './FileChip';
import { Icon } from './Icon';

const EFFORT_LABEL: Record<Effort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
// 模型列表还没加载出来时，常见别名先显示成好看的名字
const ALIAS_NAME: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 20;
/** Claude 能直接看的图片格式；其他图片（bmp、svg、太大的）按普通文件附加 */
const VISIBLE_IMAGE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function useOutsideClose(open: boolean, close: () => void) {
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

/** 在哪里干活：本地项目文件夹，还是新的 worktree（C3）。只在还没发第一条消息时能选 */
function PlaceMenu({ projectPath }: { projectPath: string }) {
  const draft = useStore(s => s.draft);
  const meta = useStore(s => (s.activeId ? s.convs[s.activeId]?.meta : null));
  const setDraftPlace = useStore(s => s.setDraftPlace);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useOutsideClose(open, () => setOpen(false));
  useEffect(() => {
    if (open) void window.claudex.worktreeCheck(projectPath).then(setProblem).catch(() => setProblem(null));
  }, [open, projectPath]);
  if (meta) {
    if (!meta.worktree) return null;
    return inWorktree(meta)
      ? <span className="uchip wt" title={`这个对话在独立的 worktree 里改代码：${meta.worktree.path}`} data-testid="place-chip"><Icon name="layers" size={14} />worktree</span>
      : <span className="uchip" title={`原来在 worktree 里，已经接手到本地（分支 ${meta.worktree.branch} 里存着当时的改动）`}><Icon name="layers" size={14} />已接手</span>;
  }
  const place = draft?.place ?? 'local';
  const pick = (p: 'local' | 'worktree') => { setOpen(false); setDraftPlace(p); };
  return (
    <div className="dd" ref={ref}>
      <button className={`mchip${place === 'worktree' ? ' place-wt' : ''}`} data-testid="place-button" onClick={() => setOpen(o => !o)}>
        <Icon name={place === 'worktree' ? 'layers' : 'folder'} size={14} />{place === 'worktree' ? '新 worktree' : '本地'}<Icon name="down" size={14} />
      </button>
      {open && (
        <div className="menu">
          <div className="menu-sec">这个对话在哪里改代码</div>
          <button className={`mitem${place === 'local' ? ' on' : ''}`} data-place="local" onClick={() => pick('local')}>
            <Icon name="folder" />
            <span className="mi"><b>本地</b><span>直接改项目文件夹里的文件</span></span>
            <Icon name="check" size={14} className="tick" />
          </button>
          <button className={`mitem${place === 'worktree' ? ' on' : ''}`} data-place="worktree" disabled={!!problem} onClick={() => pick('worktree')}>
            <Icon name="layers" />
            <span className="mi"><b>新 worktree</b><span>{problem ?? '在项目的独立副本里改，可以和别的对话同时改同一个项目；改完点“接手到本地”'}</span></span>
            <Icon name="check" size={14} className="tick" />
          </button>
          <div className="menu-foot">worktree 从当前分支最新的提交开始，本地没提交的改动不会带过去</div>
        </div>
      )}
    </div>
  );
}

/** 项目指定的 conda 环境：项目里所有对话和终端都用它。没装 conda 时不显示 */
function EnvMenu({ projectPath }: { projectPath: string }) {
  const conda = useStore(s => s.conda);
  const env = useStore(s => s.app?.projects.find(p => p.path === projectPath)?.condaEnv);
  const { loadConda, setProjectEnv } = useStore.getState();
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  useEffect(() => { if (open) void loadConda(true); }, [open, loadConda]);
  if (!conda?.available) return null;
  const pick = (prefix: string | null) => { setOpen(false); void setProjectEnv(projectPath, prefix); };
  return (
    <div className="dd" ref={ref}>
      <button className={`mchip${env ? ' env-set' : ''}`} data-testid="env-button" title={env ? `项目的 Python 环境：${env.prefix}` : '这个项目还没有指定 Python 环境，需要时 Claude 会先找现有的 conda 环境，没有就新建一个'}
        onClick={() => setOpen(o => !o)}>
        <Icon name="pkg" size={14} />{env ? env.name : 'Python 环境'}<Icon name="down" size={14} />
      </button>
      {open && (
        <div className="menu env-menu">
          <div className="menu-sec">这个项目用哪个 conda 环境（所有对话和终端都用它）</div>
          <button className={`mitem${!env ? ' on' : ''}`} data-env="" onClick={() => pick(null)}>
            <Icon name="spark" />
            <span className="mi"><b>不指定</b><span>需要运行 Python 时，Claude 先找现有的环境，没有就为这个项目新建一个，再登记成项目环境</span></span>
            <Icon name="check" size={14} className="tick" />
          </button>
          <div className="menu-sep" />
          {conda.envs.map(e => (
            <button key={e.prefix} className={`mitem${env?.prefix === e.prefix ? ' on' : ''}`} data-env={e.name} onClick={() => pick(e.prefix)}>
              <Icon name="pkg" />
              <span className="mi"><b>{e.name}</b><span className="mono">{e.prefix}</span></span>
              <Icon name="check" size={14} className="tick" />
            </button>
          ))}
          <div className="menu-foot">换了以后，正在运行的对话从下一条消息开始用新环境</div>
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
  const cwd = useActiveCwd();
  const branch = useStore(s => (cwd ? s.branches[cwd] : null));
  const sentToken = useStore(s => s.sentToken);
  const send = useStore(s => s.send);
  const interrupt = useStore(s => s.interrupt);
  const toast = useStore(s => s.toast);
  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const commands = useRef<{ project: string; list: CommandInfo[] } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = status === 'running' || status === 'starting';

  // 真正发出去之后才清空（遇到 MCP 批准弹窗时，内容要留着）
  useEffect(() => { setText(''); setImages([]); setFiles([]); setPopup(null); }, [sentToken]);
  useEffect(() => { input.current?.focus(); }, [activeId, projectPath]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [text]);

  /**
   * 拖进来、粘贴、用 + 选的文件：图片（5 MB 以内）直接作为图片发给 Claude；其他文件不复制、不上传内容，
   * 只把完整路径带在消息里（原地引用），Claude 按全局规则用对应的工具去读（Word、PDF、录音……）
   */
  const addFiles = async (list: File[], isDir: (i: number) => boolean = () => false) => {
    if (!projectPath) { toast('先在左边添加一个项目'); return; }
    const imgs: File[] = [];
    const refs: FileAttachment[] = [];
    let noPath = 0;
    list.forEach((f, i) => {
      const p = window.claudex.pathForFile(f);
      if (!isDir(i) && VISIBLE_IMAGE.includes(f.type) && f.size <= MAX_IMAGE_BYTES) imgs.push(f);
      else if (p) refs.push({ path: p, name: f.name, size: f.size, isDir: isDir(i) || undefined });
      else noPath++;
    });
    if (noPath) toast(`有 ${noPath} 个文件拿不到在硬盘上的位置（比如从网页拖来的），没有添加`);
    if (refs.length) {
      setFiles(cur => {
        const seen = new Set(cur.map(f => f.path.toLowerCase()));
        const next = [...cur, ...refs.filter(f => !seen.has(f.path.toLowerCase()) && seen.add(f.path.toLowerCase()))];
        if (next.length > MAX_FILES) toast(`一次最多附加 ${MAX_FILES} 个文件`);
        return next.slice(0, MAX_FILES);
      });
    }
    if (imgs.length) {
      const read = (await Promise.all(imgs.map(readImage))).filter((x): x is ImageAttachment => !!x);
      setImages(cur => {
        if (cur.length + read.length > MAX_IMAGES) toast(`一次最多附加 ${MAX_IMAGES} 张图片`);
        return [...cur, ...read].slice(0, MAX_IMAGES);
      });
    }
  };

  // 拖到对话区任何地方的文件，由 App 转发过来
  useEffect(() => {
    const onDrop = (e: Event) => {
      const d = (e as CustomEvent<DroppedFiles>).detail;
      void addFiles(d.files, i => d.dirs[i]);
    };
    window.addEventListener(DROP_EVENT, onDrop);
    return () => window.removeEventListener(DROP_EVENT, onDrop);
  }, [projectPath]);

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
      const files = await window.claudex.listFiles(cwd ?? projectPath, m[2]);
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
    if (!text.trim() && !images.length && !files.length) return;
    void send(text, images, files);
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
        {(images.length > 0 || files.length > 0) && (
          <div className="attachments">
            {images.map((img, i) => (
              <div className="thumb" key={i} title={img.name}>
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
                <button onClick={() => setImages(cur => cur.filter((_, j) => j !== i))} title="移除"><Icon name="x" size={12} /></button>
              </div>
            ))}
            {files.map(f => (
              <FileChip key={f.path} path={f.path} size={f.size} isDir={f.isDir} onRemove={() => setFiles(cur => cur.filter(x => x.path !== f.path))} />
            ))}
          </div>
        )}
        <textarea
          ref={input}
          data-testid="composer-input"
          rows={1}
          value={text}
          disabled={!projectPath}
          placeholder={projectPath ? '给 Claude 发消息，@ 引用文件，/ 打开命令和 Skills，可以拖入或粘贴文件、图片' : '先在左边添加一个项目'}
          onChange={e => { setText(e.target.value); void refreshPopup(e.target.value, e.target.selectionStart); }}
          onClick={e => void refreshPopup(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={e => {
            // 截图、在资源管理器里复制的文件都会出现在 files 里；纯文字粘贴时是空的
            const pasted = [...e.clipboardData.files];
            if (pasted.length) { e.preventDefault(); void addFiles(pasted); }
          }}
        />
        <div className="cbar">
          <button className="chip" title="添加文件或图片（也可以直接拖进来）" data-testid="attach-button" onClick={() => fileInput.current?.click()}><Icon name="plus" /></button>
          <input ref={fileInput} type="file" multiple hidden data-testid="attach-input" onChange={e => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <span className="sp" />
          <ModelPicker />
          <UsageRing />
          {running ? (
            <button className="send" data-testid="stop-button" title="停止（Esc）" onClick={() => void interrupt()}><Icon name="stop" /></button>
          ) : (
            <button className="send" data-testid="send-button" title="发送（Enter）" disabled={!projectPath || (!text.trim() && !images.length && !files.length)} onClick={submit}><Icon name="up" /></button>
          )}
        </div>
      </div>
      <div className="under">
        <ModeMenu />
        {project && <span className="uchip" title={project.path}><Icon name="folder" size={14} />{project.name}</span>}
        {projectPath && <PlaceMenu projectPath={projectPath} />}
        {projectPath && <EnvMenu projectPath={projectPath} />}
        {branch && <span className="uchip" title="Git 分支" data-testid="branch-chip"><Icon name="branch" size={14} />{branch}</span>}
        <span className="sp" />
        <span className="uhint">Enter 发送 · Shift+Enter 换行 · Shift+Tab 切换模式</span>
      </div>
    </div>
  );
}
