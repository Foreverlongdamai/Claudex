// 对话相关的小工具（主进程和界面共用）。
import type { ConversationMeta } from './types';

/** 对话实际的工作目录：在 worktree 里（还没接手）就是 worktree，否则是项目文件夹 */
export function convCwd(meta: Pick<ConversationMeta, 'projectPath' | 'worktree'>): string {
  return meta.worktree && !meta.worktree.handedOff ? meta.worktree.cwd : meta.projectPath;
}

/** 还在 worktree 里干活（没接手） */
export const inWorktree = (meta: Pick<ConversationMeta, 'worktree'>) => !!meta.worktree && !meta.worktree.handedOff;
