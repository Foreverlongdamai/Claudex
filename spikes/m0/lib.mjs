// M0 验证脚本的公共工具：一次性提问、流式会话（多轮）、结果记录。
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SANDBOX = path.join(ROOT, 'sandbox');
export const RESULTS = path.join(ROOT, 'results');
export const INSTALLED_CLI = 'D:\\tools\\claude-code\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
// 测试默认用最便宜的模型；中转不支持时用环境变量 M0_MODEL 换掉
export const TEST_MODEL = process.env.M0_MODEL || 'claude-haiku-5-5';
// SDK 调起的 Claude Code 自己找不到 Git Bash（01b 验证过），要显式告诉它，否则只有 PowerShell 工具
export const GIT_BASH = 'D:\\git\\Git\\bin\\bash.exe';
// 不需要续接的测试不写会话记录，免得测试会话混进用户的对话历史
export const BASE = {
  model: TEST_MODEL, maxBudgetUsd: 0.5, persistSession: false,
  env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: GIT_BASH }
};

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 读 ~/.claude/settings.json 里的 env（中转地址和令牌）。只用于传给子进程，绝不打印。 */
export function userSettingsEnv() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {};
  } catch {
    return {};
  }
}

/** 在 sandbox/ 下建一个干净的目录。 */
export function freshDir(name) {
  const d = path.join(SANDBOX, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 去掉看起来像密钥的字符串，防止写进结果文件。 */
export function scrub(v) {
  return JSON.parse(JSON.stringify(v ?? null).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'));
}

export function toolUsesOf(msgs) {
  const out = [];
  for (const m of msgs) {
    if (m.type !== 'assistant') continue;
    for (const b of m.message?.content || []) if (b.type === 'tool_use') out.push({ id: b.id, name: b.name, input: b.input });
  }
  return out;
}

export function toolResultsOf(msgs) {
  const out = [];
  for (const m of msgs) {
    if (m.type !== 'user' || !Array.isArray(m.message?.content)) continue;
    for (const b of m.message.content) {
      if (b.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content : (b.content || []).map(c => c.text || '').join('');
      out.push({ id: b.tool_use_id, isError: !!b.is_error, text });
    }
  }
  return out;
}

export function assistantText(msgs) {
  return msgs.filter(m => m.type === 'assistant')
    .flatMap(m => m.message?.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n');
}

/** 一次性提问：跑到 result 为止，返回 init、result、工具调用等。出错不抛，放在 error 里。 */
export async function once(prompt, options = {}, timeoutMs = 180000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  const msgs = [];
  const stderr = [];
  let init = null, result = null, tInit = null, error = null;
  try {
    const q = query({ prompt, options: { abortController: ac, stderr: d => stderr.push(d), ...options } });
    for await (const m of q) {
      msgs.push(m);
      if (m.type === 'system' && m.subtype === 'init' && !init) { init = m; tInit = Date.now() - t0; }
      if (m.type === 'result') result = m;
    }
  } catch (e) {
    error = String(e?.message || e);
  } finally {
    clearTimeout(timer);
  }
  return {
    init, result, msgs, error,
    stderr: scrub(stderr.join('').slice(-1500)),
    toolUses: toolUsesOf(msgs), toolResults: toolResultsOf(msgs), text: assistantText(msgs),
    tInit, elapsed: Date.now() - t0
  };
}

/** 流式会话：一个进程里多轮对话，可以中途调 setPermissionMode 等控制方法。 */
export function session(options = {}) {
  const buf = [];
  let wake = null;
  let closed = false;
  const input = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buf.length) { yield buf.shift(); continue; }
        if (closed) return;
        await new Promise(r => { wake = r; });
        wake = null;
      }
    }
  };
  const stderr = [];
  const q = query({ prompt: input, options: { stderr: d => stderr.push(d), ...options } });
  const st = { init: null, msgs: [], waiters: [], error: null, done: false };
  const pump = (async () => {
    try {
      for await (const m of q) {
        st.msgs.push(m);
        if (m.type === 'system' && m.subtype === 'init') st.init = m;
        if (m.type === 'result') st.waiters.shift()?.resolve(m);
      }
    } catch (e) {
      st.error = String(e?.message || e);
      for (const w of st.waiters.splice(0)) w.reject(e);
    }
    st.done = true;
  })();
  return {
    q, st, stderr,
    async turn(text, timeoutMs = 180000) {
      const start = st.msgs.length;
      const p = new Promise((resolve, reject) => st.waiters.push({ resolve, reject }));
      buf.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      wake?.();
      let timer;
      const result = await Promise.race([
        p,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('这一轮超时')), timeoutMs); })
      ]).finally(() => clearTimeout(timer));
      const msgs = st.msgs.slice(start);
      return { result, msgs, toolUses: toolUsesOf(msgs), toolResults: toolResultsOf(msgs), text: assistantText(msgs) };
    },
    async close() {
      closed = true;
      wake?.();
      try { q.close(); } catch { /* 已经结束 */ }
      await Promise.race([pump, sleep(3000)]);
    }
  };
}

/** 记录检查项和观察结果，最后写到 results/<name>.json。 */
export function reporter(name) {
  const checks = [];
  const notes = {};
  let cost = 0;
  const fmt = v => (typeof v === 'string' ? v : JSON.stringify(scrub(v)));
  return {
    check(label, ok, detail) {
      checks.push({ label, ok: !!ok, detail: scrub(detail) });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  (' + fmt(detail).slice(0, 300) + ')' : ''}`);
    },
    note(key, value) {
      notes[key] = scrub(value);
      console.log(`NOTE  ${key}: ${fmt(value).slice(0, 600)}`);
    },
    cost(res) { cost += res?.result?.total_cost_usd || res?.total_cost_usd || 0; },
    save() {
      fs.mkdirSync(RESULTS, { recursive: true });
      notes['合计花费 USD（按官方价估算）'] = Number(cost.toFixed(4));
      fs.writeFileSync(path.join(RESULTS, `${name}.json`),
        JSON.stringify({ name, at: new Date().toISOString(), checks, notes }, null, 2));
      const failed = checks.filter(c => !c.ok).length;
      console.log(`--- ${name}: ${checks.length - failed}/${checks.length} 通过，花费约 $${cost.toFixed(4)}`);
    }
  };
}
