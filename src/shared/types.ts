// 主进程、preload、界面三方共用的类型。界面能调用什么、主进程会推什么事件，都以这里为准。
import type { DiffFile } from './gitDiff';
import type { EmployeeProfile } from './profile';

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
  /** 员工的对话（团队功能）；没有就是主对话（老板） */
  employee?: { id: string };
  /** 员工在派活的主对话的目录里干活（主对话在 worktree 里时就是那个 worktree） */
  workdir?: string;
  /** 自动化的一次运行（C4）：不在左栏的对话列表里，从“自动化”的审查队列打开 */
  automation?: { id: string; runId: string; name: string };
}

export type { EmployeeProfile, MemoryScope } from './profile';
export type { Schedule, ScheduleKind } from './schedule';

/** 自动化（C4）：按计划让 Claude 自动跑任务 */
export interface Automation {
  id: string;
  name: string;
  projectPath: string;
  /** 要 Claude 做什么（每次运行发给 Claude 的消息） */
  prompt: string;
  schedule: import('./schedule').Schedule;
  /** worktree：每次在新的 worktree 里跑（推荐，不碰本地文件）；local：直接在项目文件夹里跑 */
  place: 'worktree' | 'local';
  mode: ModeId;
  model?: string;
  effort?: Effort;
  enabled: boolean;
  createdAt: number;
  /** 下一次按计划运行的时刻（停用时没有） */
  nextRunAt?: number;
}

/** 自动化的一次运行：一个新对话；跑完进审查队列 */
export interface AutomationRun {
  id: string;
  automationId: string;
  /** 运行时自动化的名字 */
  name: string;
  projectPath: string;
  convId: string;
  /** 按计划 / 用户点了“现在跑一次” / App 没开时错过了，开 App 后补跑 */
  trigger: 'schedule' | 'manual' | 'catchup';
  /** running 在跑；waiting 暂停了，等用户审批或回答；done 跑完；failed 出错 */
  status: 'running' | 'waiting' | 'done' | 'failed';
  startedAt: number;
  endedAt?: number;
  /** Claude 最后的回复（摘要） */
  summary?: string;
  /** 在审查队列里处理过了（看过、标为已读、忽略） */
  read: boolean;
}

export interface AutomationState {
  automations: Automation[];
  runs: AutomationRun[];
}

export interface TeamTask {
  /** 任务编号，显示成 #12 */
  id: string;
  projectPath: string;
  employeeId: string;
  employeeName: string;
  /** 员工做这个活的对话 */
  convId: string;
  /** 派活的对话：主对话，或者请同事帮忙的那个员工的对话 */
  fromConvId: string;
  /** 派活的是主对话（负责人）还是员工（请同事帮忙） */
  fromKind?: 'boss' | 'employee';
  /** 派活方的名字（主对话标题或员工名字） */
  fromName?: string;
  title: string;
  /** 任务说明 */
  text?: string;
  /** running 在做；waiting 等同事帮忙的部分；handed 已经转交给同事；done 已交回；failed 没做完 */
  status: 'running' | 'waiting' | 'handed' | 'done' | 'failed';
  createdAt: number;
  endedAt?: number;
  /** 员工交回的汇报 */
  result?: string;
  /** 请同事帮忙：这是哪个任务的一部分 */
  parentId?: string;
  /** 转交：从哪个任务转来的 / 转交给了哪个任务 */
  handedFrom?: string;
  handedTo?: string;
  /** 在等哪些同事的任务 */
  waitingFor?: string[];
  /** 交接链的深度（防止员工之间推来推去） */
  depth?: number;
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
  /** 关掉窗口时缩到托盘，在后台运行（自动化要按时跑） */
  closeToTray: boolean;
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
  | { kind: 'project-env'; convId: string; projectPath: string; env: CondaEnv }
  /** Claudex 替用户发进对话的消息（派给员工的任务、员工交回的结果），界面要显示出来 */
  | { kind: 'injected'; convId: string; text: string }
  /** 对话里加一条提示 */
  | { kind: 'notice'; convId: string; tone: 'info' | 'ok' | 'error'; text: string; detail?: string }
  /** 任务开始、完成 */
  | { kind: 'task'; task: TeamTask }
  /** 项目的员工档案变了 */
  | { kind: 'team'; projectPath: string }
  /** 自动化或者它的运行记录变了（整份发过来，数据不大） */
  | { kind: 'automation'; state: AutomationState }
  /** 主进程要界面打开某个页面（托盘菜单、系统通知被点了） */
  | { kind: 'navigate'; to: 'automation' } | { kind: 'navigate'; to: 'conversation'; convId: string };

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
  // ---- 团队（老板-员工） ----
  listEmployees(projectPath: string): Promise<EmployeeProfile[]>;
  /** 新建或修改员工档案（写到项目的 .claude/agents/<编号>.md） */
  saveEmployee(projectPath: string, profile: EmployeeProfile, isNew: boolean): Promise<EmployeeProfile[]>;
  /** 删掉员工档案（长期记忆和他的对话保留） */
  deleteEmployee(projectPath: string, id: string): Promise<EmployeeProfile[]>;
  listTasks(projectPath: string): Promise<TeamTask[]>;
  /** 和某个员工开一个新对话（用户直接找他聊） */
  newEmployeeConversation(projectPath: string, employeeId: string): Promise<ConversationMeta>;
  /** 项目里能用的 Skills（全局、项目、插件里的） */
  listSkills(projectPath: string): Promise<CommandInfo[]>;
  /** 停止一个正在做的任务 */
  stopTask(taskId: string): Promise<void>;
  // ---- 自动化（C4） ----
  listAutomations(): Promise<AutomationState>;
  /** 新建（没有 id）或修改；设置不对时报错 */
  saveAutomation(a: Omit<Automation, 'id' | 'createdAt' | 'nextRunAt'> & { id?: string }): Promise<AutomationState>;
  deleteAutomation(id: string): Promise<AutomationState>;
  setAutomationEnabled(id: string, enabled: boolean): Promise<AutomationState>;
  /** 现在跑一次（不影响计划） */
  runAutomation(id: string): Promise<AutomationRun>;
  /** 审查队列里标为已读（或忽略） */
  markRunRead(runId: string): Promise<AutomationState>;
  /** 删掉一次运行的记录和它的对话（worktree 里的改动先存到分支上） */
  deleteRun(runId: string): Promise<AutomationState>;
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
