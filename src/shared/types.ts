// 主进程、preload、界面三方共用的类型。界面能调用什么、主进程会推什么事件，都以这里为准。

/** 5 个模式：前 4 个是 Claude Code 自带的，skills 是 Claudex 自定义的“Skills 配置”。 */
export type ModeId = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'skills';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface Project {
  path: string;
  name: string;
  addedAt: number;
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

export interface ImageAttachment {
  mediaType: string;
  /** base64，不带 data: 前缀 */
  data: string;
  name: string;
}

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
  | { kind: 'mode'; convId: string; mode: ModeId };

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
  newConversation(projectPath: string): Promise<ConversationMeta>;
  openConversation(convId: string): Promise<OpenedConversation>;
  deleteConversation(convId: string): Promise<AppState>;
  send(convId: string, text: string, images?: ImageAttachment[]): Promise<void>;
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
}
