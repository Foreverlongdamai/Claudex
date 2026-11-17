// Claude Code 的设置文件（settings.json）：表单里能改的几项，保存时只改这几项，其他字段原样保留（M3）。
// 纯函数，单元测试直接跑。

export type SettingsScope = 'user' | 'project' | 'local';

/** 表单里的内容（读出来给界面，界面改完整份发回来） */
export interface SettingsForm {
  /** 默认模型；空字符串表示不设 */
  model: string;
  /** 环境变量 */
  env: Array<{ key: string; value: string }>;
  /** 权限：总是允许、总是拒绝、总是询问的规则 */
  allow: string[];
  deny: string[];
  ask: string[];
  /** 默认权限模式；空字符串表示不设 */
  defaultMode: string;
  /** hooks 的 JSON 文字（空字符串表示没有） */
  hooks: string;
}

/** 看起来是密钥的环境变量：界面上默认打码 */
export const isSecretKey = (key: string) => /token|secret|password|passwd|api[_-]?key|credential|auth/i.test(key);

/** 打码：只露出前 4 个字符 */
export function mask(value: string): string {
  if (!value) return '';
  return value.length <= 6 ? '••••••' : `${value.slice(0, 4)}${'•'.repeat(Math.min(16, value.length - 4))}`;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function toForm(settings: Record<string, unknown>): SettingsForm {
  const env = settings.env && typeof settings.env === 'object' ? (settings.env as Record<string, unknown>) : {};
  const perm = settings.permissions && typeof settings.permissions === 'object' ? (settings.permissions as Record<string, unknown>) : {};
  return {
    model: typeof settings.model === 'string' ? settings.model : '',
    env: Object.entries(env).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) })),
    allow: strList(perm.allow),
    deny: strList(perm.deny),
    ask: strList(perm.ask),
    defaultMode: typeof perm.defaultMode === 'string' ? perm.defaultMode : '',
    hooks: settings.hooks && typeof settings.hooks === 'object' && Object.keys(settings.hooks).length ? JSON.stringify(settings.hooks, null, 2) : ''
  };
}

/** 检查表单：有问题返回原因 */
export function checkForm(f: SettingsForm): string | null {
  const keys = new Set<string>();
  for (const { key } of f.env) {
    const k = key.trim();
    if (!k) return '环境变量的名字不能为空';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return `环境变量名「${k}」不对：只能用字母、数字和下划线，不能以数字开头`;
    if (keys.has(k)) return `环境变量「${k}」写了两次`;
    keys.add(k);
  }
  if (f.hooks.trim()) {
    try {
      const h = JSON.parse(f.hooks);
      if (!h || typeof h !== 'object' || Array.isArray(h)) return 'hooks 要是一个 JSON 对象，比如 {"PreToolUse": [...]}';
    } catch (e) {
      return `hooks 不是合法的 JSON：${e instanceof Error ? e.message : e}`;
    }
  }
  return null;
}

/**
 * 把表单改动写回设置：只动表单管的这几项（model、env、permissions 的 allow/deny/ask/defaultMode、hooks），
 * 其他字段和顺序原样保留；改成空的就把那一项删掉。
 */
export function applyForm(original: Record<string, unknown>, before: SettingsForm, after: SettingsForm): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (before.model !== after.model) {
    if (after.model.trim()) next.model = after.model.trim();
    else delete next.model;
  }
  if (!same(before.env, after.env)) {
    const env = Object.fromEntries(after.env.map(e => [e.key.trim(), e.value]));
    if (Object.keys(env).length) next.env = env;
    else delete next.env;
  }
  const permKeys = ['allow', 'deny', 'ask', 'defaultMode'] as const;
  if (permKeys.some(k => !same(before[k], after[k]))) {
    const perm: Record<string, unknown> = { ...((original.permissions as Record<string, unknown>) ?? {}) };
    for (const k of ['allow', 'deny', 'ask'] as const) {
      if (same(before[k], after[k])) continue;
      const list = after[k].map(s => s.trim()).filter(Boolean);
      if (list.length) perm[k] = list;
      else delete perm[k];
    }
    if (before.defaultMode !== after.defaultMode) {
      if (after.defaultMode) perm.defaultMode = after.defaultMode;
      else delete perm.defaultMode;
    }
    if (Object.keys(perm).length) next.permissions = perm;
    else delete next.permissions;
  }
  if (before.hooks.trim() !== after.hooks.trim()) {
    if (after.hooks.trim()) next.hooks = JSON.parse(after.hooks);
    else delete next.hooks;
  }
  return next;
}
