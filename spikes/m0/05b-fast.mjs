// 05b 快速模式再试一次：完整设置 + 对话中途 applyFlagSettings({ fastMode: true })。
import { session, reporter, freshDir, BASE } from './lib.mjs';

const r = reporter('05b-fast');
const dir = freshDir('fast');
const s = session({ ...BASE, cwd: dir, model: 'claude-opus-5-5', permissionMode: 'default', settings: { fastMode: true } });
try {
  const t1 = await s.turn('Reply with exactly: one');
  r.cost(t1);
  r.note('启动时带 fastMode 设置：init 状态', { state: s.st.init?.fast_mode_state, reason: s.st.init?.fast_mode_disabled_reason, speed: t1.result.usage?.speed });
  await s.q.applyFlagSettings({ fastMode: true });
  const t2 = await s.turn('Reply with exactly: two');
  r.cost(t2);
  const inits = s.st.msgs.filter(m => m.type === 'system' && m.subtype === 'init');
  const last = inits[inits.length - 1];
  r.note('中途 applyFlagSettings 后', { state: last?.fast_mode_state, reason: last?.fast_mode_disabled_reason, speed: t2.result.usage?.speed });
  const other = s.st.msgs.filter(m => m.type === 'system' && /fast/i.test(JSON.stringify(m))).map(m => m.subtype);
  r.note('其他提到 fast 的系统消息', [...new Set(other)]);
  r.check('快速模式实际生效（usage.speed = fast）', t1.result.usage?.speed === 'fast' || t2.result.usage?.speed === 'fast', { t1: t1.result.usage?.speed, t2: t2.result.usage?.speed });
} finally {
  await s.close();
}
r.save();
