// 对话相关的小工具（主进程和界面共用）。
import type { ConversationMeta } from './types';

/** 对话实际的工作目录：在 worktree 里（还没接手）就是 worktree，否则是项目文件夹 */
export function convCwd(meta: Pick<ConversationMeta, 'projectPath' | 'worktree' | 'workdir'>): string {
  if (meta.workdir) return meta.workdir; // 员工在派活的主对话的目录里干活
  return meta.worktree && !meta.worktree.handedOff ? meta.worktree.cwd : meta.projectPath;
}

/** 员工的对话 */
export const isEmployeeConv = (meta: Pick<ConversationMeta, 'employee'>) => !!meta.employee;

// ---------------- 团队消息的包装（派给员工的任务、员工交回的结果） ----------------

const attr = (v: string) => v.replace(/[\r\n]+/g, ' ').replace(/"/g, '”');

export function wrapTask(t: { id: string; from: string; title: string }, body: string): string {
  return `<claudex-task id="${attr(t.id)}" from="${attr(t.from)}" title="${attr(t.title)}">\n${body.trim()}\n</claudex-task>`;
}

export function wrapResult(t: { id: string; employee: string; name: string; status: string; title: string; chain?: string; toEmployee?: boolean }, body: string): string {
  const hint = t.toEmployee
    ? '（这是你请同事帮忙的那部分交回的结果，不是用户发的消息。接着做你的任务；等请同事帮忙的部分都回来了，再按格式汇报。）'
    : '（这是员工交回的结果，不是用户发的消息。核对是否达到要求；需要返工就用 assign_task 带上 continue_task；然后向用户汇报。）';
  return `<claudex-task-result id="${attr(t.id)}" employee="${attr(t.employee)}" name="${attr(t.name)}" status="${attr(t.status)}" title="${attr(t.title)}"${t.chain ? ` chain="${attr(t.chain)}"` : ''}>\n` +
    `${hint}\n\n${body.trim()}\n</claudex-task-result>`;
}

export interface TaskMessage { kind: 'task' | 'result'; attrs: Record<string, string>; body: string }

/** 认出团队消息；不是就返回 null */
export function parseTeamMessage(text: string): TaskMessage | null {
  const m = /^\s*<claudex-(task|task-result)((?:\s+[\w-]+="[^"]*")*)>\n?([\s\S]*?)\n?<\/claudex-\1>\s*$/.exec(text);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  let body = m[3];
  if (m[1] === 'task-result') body = body.replace(/^（这是(员工交回的结果|你请同事帮忙的那部分)[^\n]*\n\n?/, '');
  return { kind: m[1] === 'task' ? 'task' : 'result', attrs, body };
}

/** 还在 worktree 里干活（没接手） */
export const inWorktree = (meta: Pick<ConversationMeta, 'worktree'>) => !!meta.worktree && !meta.worktree.handedOff;
