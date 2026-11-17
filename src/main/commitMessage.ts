// 提交说明留空时让 Claude 来写：起一个一次性的 Claude Code 进程（不带工具、不留会话记录），
// 把暂存的改动和最近几条提交说明给它，按仓库原来的语言和风格写。用 Haiku，快而且便宜。
import { sdkExecutable } from './environment';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { stagedSummary } from './git';

/** 去掉模型偶尔会加的代码块围栏和引号 */
export function cleanMessage(text: string): string {
  let s = text.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(s);
  if (fence) s = fence[1].trim();
  if (/^["'“].*["'”]$/s.test(s) && !s.slice(1, -1).includes('\n')) s = s.slice(1, -1).trim();
  return s.split(/\r?\n/).filter(l => !/^co-authored-by:/i.test(l.trim())).join('\n').trim();
}

export async function writeCommitMessage(root: string, env: Record<string, string | undefined>, timeoutMs = 90_000): Promise<string> {
  const { stat, diff, recent } = await stagedSummary(root);
  const prompt = [
    'Write a git commit message for the staged changes below.',
    'Rules:',
    '- Output ONLY the commit message itself: no code fences, no surrounding quotes, no explanation, no "Co-Authored-By" lines.',
    '- First line: a concise summary of what changed (aim for under 60 characters).',
    '- If the change is not trivial, add a blank line and then a short body of "- " bullet points about what changed and why.',
    '- Use the same language and style as the recent commit messages. If there are none, write in Simplified Chinese.',
    '',
    'Recent commit messages (newest first):',
    recent || '(none)',
    '',
    'Staged changes (git diff --cached --stat):',
    stat,
    '',
    'Staged diff (may be truncated):',
    diff
  ].join('\n');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const q = query({
    prompt,
    options: {
      ...sdkExecutable(),
      cwd: root,
      env,
      model: 'haiku',
      tools: [],
      maxTurns: 1,
      persistSession: false,
      permissionMode: 'default',
      strictMcpConfig: true,
      mcpServers: {},
      abortController: abort
    }
  });
  try {
    for await (const m of q) {
      if (m.type !== 'result') continue;
      if (m.subtype === 'success' && !m.is_error) return cleanMessage(m.result);
      throw new Error(m.subtype === 'success' ? String(m.result) : `Claude 没写出来（${m.subtype}）`);
    }
    throw new Error('Claude 没有返回提交说明');
  } catch (e) {
    if (abort.signal.aborted) throw new Error('Claude 写提交说明超时了，请自己写一句再提交');
    throw e;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
