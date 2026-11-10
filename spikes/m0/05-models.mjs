// 05 模型 / 思考强度 / 快速模式：中转实际支持哪些。
import { once, session, reporter, freshDir, BASE, userSettingsEnv } from './lib.mjs';

const r = reporter('05-models');
const dir = freshDir('models');

// 1. Claude Code 提供的模型列表（只发控制请求，不花 token）
const s = session({ ...BASE, cwd: dir, permissionMode: 'default' });
try {
  const models = await s.q.supportedModels();
  r.note('supportedModels', models.map(m => ({
    value: m.value, resolved: m.resolvedModel, name: m.displayName,
    effort: m.supportedEffortLevels, fast: m.supportsFastMode, auto: m.supportsAutoMode
  })));
} finally {
  await s.close();
}

// 2. 每个模型发一次最小请求。用隔离模式（不加载设置、Skills、工具）省 token，中转地址和令牌手动传。
const env = { ...process.env, ...userSettingsEnv() };
const lean = { ...BASE, cwd: dir, settingSources: [], env, tools: [], permissionMode: 'default', maxTurns: 1 };
for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
  const x = await once('Reply with exactly: ok', { ...lean, model }, 120000);
  r.cost(x);
  const ok = x.result && !x.result.is_error;
  r.check(`中转支持 ${model}`, ok, ok ? x.result.result.slice(0, 20) : (x.result?.result || x.error || '').slice(0, 200));
  r.note(`${model} 详情`, { usedModels: Object.keys(x.result?.modelUsage || {}), elapsedMs: x.elapsed, ttftMs: x.result?.ttft_ms, costUsd: x.result?.total_cost_usd });
}

// 3. 思考强度
for (const [model, effort] of [['claude-opus-5-5', 'low'], ['claude-haiku-5-5', 'max']]) {
  const x = await once('Reply with exactly: ok', { ...lean, model, effort }, 120000);
  r.cost(x);
  r.check(`思考强度 ${effort}（${model}）请求成功`, x.result && !x.result.is_error, (x.result?.result || x.error || '').slice(0, 200));
  r.note(`思考强度 ${effort}（${model}）init.effort`, x.init?.effort ?? '(未提供)');
}

// 4. 快速模式（Opus）
const f = await once('Reply with exactly: ok', { ...lean, model: 'claude-opus-5-5', settings: { fastMode: true } }, 120000);
r.cost(f);
r.note('快速模式：init 里的状态', { state: f.init?.fast_mode_state ?? '(未提供)', reason: f.init?.fast_mode_disabled_reason });
r.note('快速模式：请求结果', { ok: f.result && !f.result.is_error, result: (f.result?.result || f.error || '').slice(0, 200), speed: f.result?.usage?.speed, costUsd: f.result?.total_cost_usd });
r.save();
