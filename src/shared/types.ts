// 主进程、preload、界面三方共用的类型。界面能调用什么、主进程会推什么事件，都以这里为准。
import type { DiffFile } from './gitDiff';

export type { DiffFile, DiffLine } from './gitDiff';

/** 5 个模式：前 4 个是 Claude Code 自带的，skills 是 Claudex 自定义的“Skills 配置”。 */
export type ModeId = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'skills';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface Project {
  path: string;
  name: string;
  addedAt: number;
  /** 项目指定的 conda 环境：项目里所有对话和终端都用它 */
  condaEnv?: CondaEnv;
}

export interface CondaEnv {
  /** 环境名（base 或者 envs 下面的文件夹名；按路径建的环境是文件夹名） */
  name: string;
  /** 环境的完整路径 */
  prefix: string;
}

export interface CondaInfo {
  available: boolean;
  root: string | null;
  envs: CondaEnv[];
}

export interface ConversationMeta {
  /** Claudex 自己的对话 ID（创建时就有） */
  id: string;
  /** Claude Code 的会话 ID（第一条消息之后才有，用来续接） */
  sessionId?: string;
  projectPath: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode: ModeId;
  model: string;
  effort: Effort;
  /** 在独立的 worktree 里干活（C3）；没有就是直接在项目文件夹里 */
  worktree?: WorktreeInfo;
}

export interface WorktreeInfo {
  /** worktree 的根目录 */
  path: string;
  /** 对话实际的工作目录（项目是仓库里的子目录时，是 worktree 里对应的子目录） */
  cwd: string;
  /** worktree 的分支，例如 claudex/1117-1530 */
  branch: string;
  /** 从哪个提交开始的 */
  base: string;
  /** 开始时本地在哪个分支上 */
  baseBranch: string | null;
  /** 已经接手到本地：worktree 删掉了，对话改在本地项目文件夹里继续 */
  handedOff?: { at: number; files: number };
}

export interface HandoffResult {
  /** 搬到本地的文件数 */
  files: number;
  /** 合并时有冲突的文件（已经写上冲突标记） */
  conflicts: string[];
  /** 存着接手时全部改动的分支 */
  branch: string;
  meta: ConversationMeta;
  /** worktree 文件夹没删干净（还有程序占着），可以稍后手动删 */
  leftover?: string;
}

/** 保底黑名单：任何模式下都拦截的高危命令。pattern 是正则表达式源码。 */
export interface BlacklistRule {
  id: string;
  label: string;
  tools: string[];
  pattern: string;
  flags?: string;
  enabled: boolean;
}

/** 内置终端用的 shell */
export type ShellKind = 'powershell' | 'gitbash' | 'cmd';

export interface ShellInfo {
  kind: ShellKind;
  label: string;
  path: string | null;
  available: boolean;
}

export interface TermInfo {
  id: string;
  /** 对话 ID，或者还没发消息的新对话用 project:<路径> */
  key: string;
  shell: ShellKind;
  shellLabel: string;
  cwd: string;
  alive: boolean;
  exitCode?: number;
  /** 之前的输出（切回这个对话时重新显示） */
  buffer: string;
  /** 终端当前的行列数 */
  cols: number;
  rows: number;
}

export type TermEvent =
  | { kind: 'data'; id: string; data: string }
  | { kind: 'exit'; id: string; exitCode: number };

export interface Prefs {
  defaultMode: ModeId;
  defaultModel: string;
  defaultEffort: Effort;
  /** null 表示自动查找 */
  gitBashPath: string | null;
  /** 同时运行的对话进程上限（每个约 250 MB） */
  maxLiveSessions: number;
  theme: 'dark' | 'light';
  /** 切到完全访问时不再弹确认 */
  skipBypassConfirm: boolean;
  blacklist: BlacklistRule[];
  /** 内置终端默认用的 shell */
  terminalShell: ShellKind;
  /** 改动面板的宽度（像素） */
  reviewWidth: number;
}

export interface AppState {
  projects: Project[];
  conversations: ConversationMeta[];
  prefs: Prefs;
  /** 项目路径 → MCP 服务器名 → 是否批准 */
  mcpApprovals: Record<string, Record<string, boolean>>;
}

export interface ModelOption {
  value: string;
  displayName: string;
  description: string;
  efforts: Effort[];
  supportsFast: boolean;
}

export interface EnvInfo {
  appVersion: string;
  gitBashPath: string | null;
  gitBashSource: 'prefs' | 'auto' | 'none';
  /** 走中转时的中转地址（只取主机名，不含令牌） */
  relayHost: string | null;
  /** 快速模式为什么不可用；null 表示可用 */
  fastUnavailableReason: string | null;
}

export type ConvStatus = 'new' | 'starting' | 'idle' | 'running' | 'dormant' | 'error';

export interface PermissionRequest {
  requestId: string;
  /** 对应的工具调用 ID，用来把审批和那一行活动记录对上 */
  toolUseId?: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  /** 有权限建议时才能“总是允许” */
  canAlways: boolean;
  /** “总是允许”会写进去的规则，例如 Bash(pnpm test:*) */
  alwaysLabel?: string;
}

export interface PermissionDecision {
  requestId: string;
  behavior: 'allow' | 'always' | 'deny';
  message?: string;
  /** AskUserQuestion 的回答等，会替换工具输入 */
  updatedInput?: Record<string, unknown>;
  /** 批准计划后切到哪个模式 */
  nextMode?: ModeId;
}

export interface UsageInfo {
  percentage: number;
  totalTokens: number;
  maxTokens: number;
}

export interface McpServerInfo {
  name: string;
  command: string;
}

/** 添加项目时的安全检查结果 */
export interface ProjectCheck {
  path: string;
  name: string;
  /** 项目设置里自带的 hooks 数量（会自动执行命令） */
  hooks: number;
  mcpServers: McpServerInfo[];
}

export interface CommandInfo {
  name: string;
  description: string;
}

/** 非图片附件：只带路径，原地引用（见 shared/attachments.ts） */
export interface FileAttachment {
  path: string;
  name: string;
  size: number;
  isDir?: boolean;
}

export interface ImageAttachment {
  mediaType: string;
  /** base64，不带 data: 前缀 */
  data: string;
  name: string;
}

// ---------------- Git 审查和提交（C2） ----------------

/** 改动面板的 4 个范围：上一轮（Claude 上一轮回复里改的）、未暂存、已暂存、整个分支 */
export type GitScope = 'turn' | 'unstaged' | 'staged' | 'branch';

export interface GitFileState {
  /** 相对仓库根目录 */
  path: string;
  /** 重命名前的路径 */
  origPath?: string;
  /** 暂存区的状态（git status 的 X，'.' 表示没变） */
  x: string;
  /** 工作区的状态（git status 的 Y） */
  y: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  repo: boolean;
  /** 仓库根目录 */
  root: string | null;
  /** 当前分支；分离 HEAD 时为 null */
  branch: string | null;
  detached: boolean;
  /** 还没有任何提交 */
  unborn: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** 默认分支（main / master） */
  defaultBranch: string | null;
  hasRemote: boolean;
  files: GitFileState[];
  /** 全部未提交改动（已暂存、未暂存、新文件）的行数 */
  add: number;
  del: number;
}

export interface GitDiffResult {
  scope: GitScope;
  /** 这个范围是什么，比如“相对 origin/main：还没推送的提交和未提交的改动” */
  desc: string;
  files: DiffFile[];
  /** 没有文件时显示什么 */
  empty?: string;
  /** 上一轮：这一轮还在进行，显示到现在为止的改动 */
  live?: boolean;
}

export type CommitKind = 'commit' | 'push' | 'pr';

export interface CommitRequest {
  /** 留空让 Claude 来写 */
  message: string;
  kind: CommitKind;
  /** 开 PR 时在默认分支上：先切到这个新分支再提交 */
  newBranch?: string;
}

export interface CommitResult {
  branch: string | null;
  commit?: { hash: string; subject: string; message: string; files: number; generated: boolean };
  /** 推送到了哪里，例如 origin/main */
  pushed?: string;
  prUrl?: string;
  /** 出错的那一步和原因；前面成功的步骤照样返回 */
  error?: { step: 'message' | 'branch' | 'commit' | 'push' | 'pr'; message: string };
}

export type GitEvent =
  | { kind: 'dirty'; root: string }
  | { kind: 'turn'; convId: string };

/** SDK 消息原样转发，界面自己解析 */
export type SdkMessageLike = { type: string; [k: string]: unknown };

export type ConvEvent =
  | { kind: 'sdk'; convId: string; msg: SdkMessageLike }
  | { kind: 'status'; convId: string; status: ConvStatus; error?: string }
  | { kind: 'permission'; convId: string; request: PermissionRequest }
  | { kind: 'permission-cancel'; convId: string; requestId: string }
  | { kind: 'meta'; convId: string; meta: ConversationMeta }
  | { kind: 'usage'; convId: string; usage: UsageInfo }
  | { kind: 'blocked'; convId: string; toolName: string; rule: string; detail: string }
  | { kind: 'mode'; convId: string; mode: ModeId }
  /** Claude 用 set_project_env 登记了项目环境 */
  | { kind: 'project-env'; convId: string; projectPath: string; env: CondaEnv };

export interface OpenedConversation {
  meta: ConversationMeta;
  status: ConvStatus;
  /** 历史消息（来自 SDK 的 getSessionMessages） */
  history: SdkMessageLike[];
  /** 还在等回答的审批（切换对话再切回来时用） */
  pending: PermissionRequest[];
  usage?: UsageInfo;
}

/** preload 暴露给界面的接口：window.claudex */
export interface ClaudexApi {
  getState(): Promise<AppState>;
  getEnv(): Promise<EnvInfo>;
  listModels(): Promise<ModelOption[]>;
  /** 弹出文件夹选择框，返回安全检查结果（还没添加） */
  pickProject(): Promise<ProjectCheck | null>;
  checkProject(path: string): Promise<ProjectCheck>;
  addProject(path: string): Promise<AppState>;
  removeProject(path: string): Promise<AppState>;
  /** worktree：在新的 worktree 里开对话（C3） */
  newConversation(projectPath: string, opts?: { worktree?: boolean }): Promise<ConversationMeta>;
  /** 这个项目能不能开 worktree：能返回 null，不能返回原因 */
  worktreeCheck(projectPath: string): Promise<string | null>;
  /** 把 worktree 对话的改动搬到本地，删掉 worktree，对话改在本地继续 */
  handoff(convId: string): Promise<HandoffResult>;
  /** 本机的 conda 和它的环境；force 时重新查 */
  condaInfo(force?: boolean): Promise<CondaInfo>;
  /** 指定项目的 conda 环境（prefix 为 null 表示不指定，需要时让 Claude 来选） */
  setProjectEnv(projectPath: string, prefix: string | null): Promise<AppState>;
  openConversation(convId: string): Promise<OpenedConversation>;
  deleteConversation(convId: string): Promise<AppState>;
  send(convId: string, text: string, images?: ImageAttachment[], files?: FileAttachment[]): Promise<void>;
  /** 拖进来或选中的文件在硬盘上的完整路径（不是硬盘上的文件时返回空字符串）。只在 preload 里实现，不走 IPC */
  pathForFile(file: File): string;
  interrupt(convId: string): Promise<void>;
  setMode(convId: string, mode: ModeId): Promise<void>;
  setModel(convId: string, model: string, effort: Effort): Promise<void>;
  respondPermission(convId: string, decision: PermissionDecision): Promise<void>;
  /** 项目里没批准过的 MCP 服务器 */
  pendingMcp(projectPath: string): Promise<McpServerInfo[]>;
  setMcpApproval(projectPath: string, name: string, approved: boolean): Promise<void>;
  listCommands(projectPath: string): Promise<CommandInfo[]>;
  listFiles(projectPath: string, query: string): Promise<string[]>;
  gitBranch(projectPath: string): Promise<string | null>;
  setPrefs(patch: Partial<Prefs>): Promise<AppState>;
  setTheme(theme: 'dark' | 'light'): Promise<void>;
  openExternal(url: string): Promise<void>;
  onEvent(cb: (ev: ConvEvent) => void): () => void;
  // ---- 内置终端（C1） ----
  listShells(): Promise<ShellInfo[]>;
  /** 打开（或接回）某个对话的终端 */
  /** size：面板的行列数，新建终端时按它启动（避免启动后马上改大小） */
  termOpen(key: string, cwd: string, shell: ShellKind, size?: { cols: number; rows: number }): Promise<TermInfo>;
  termRestart(id: string, shell: ShellKind, size?: { cols: number; rows: number }): Promise<TermInfo>;
  /** 结束终端进程（连同它启动的子进程） */
  termKill(id: string): Promise<void>;
  termRekey(from: string, to: string): Promise<void>;
  termWrite(id: string, data: string): void;
  termResize(id: string, cols: number, rows: number): void;
  onTerm(cb: (ev: TermEvent) => void): () => void;
  // ---- Git 审查和提交（C2） ----
  gitStatus(cwd: string): Promise<GitStatus>;
  /** convId：上一轮要知道是哪个对话 */
  gitDiff(cwd: string, scope: GitScope, convId: string | null): Promise<GitDiffResult>;
  gitStage(cwd: string, paths: string[]): Promise<void>;
  gitUnstage(cwd: string, paths: string[]): Promise<void>;
  /** 撤销改动。上一轮：恢复成这一轮开始前的样子；未暂存：恢复成暂存区里的样子。新文件移到回收站 */
  gitRevert(cwd: string, scope: GitScope, paths: string[], convId: string | null): Promise<void>;
  gitCommit(cwd: string, req: CommitRequest): Promise<CommitResult>;
  gitInit(cwd: string): Promise<void>;
  /** 检查新分支名能不能用，能用返回 null，否则返回原因 */
  gitCheckBranch(cwd: string, name: string): Promise<string | null>;
  /** 监视这个目录所在仓库的文件变化（同时只监视一个），有变化时推 dirty 事件；null 停止监视 */
  gitWatch(cwd: string | null): Promise<void>;
  onGit(cb: (ev: GitEvent) => void): () => void;
}
