// 06c App 能不能拦住没批准的项目级 MCP：用 disabledMcpjsonServers 拦，只查状态，不花 token。
import path from 'node:path';
import { session, reporter, BASE, SANDBOX, sleep } from './lib.mjs';

const r = reporter('06c-mcp-gate');
const s = session({ ...BASE, cwd: path.join(SANDBOX, 'mcp'), permissionMode: 'default', settings: { disabledMcpjsonServers: ['lumen-echo'] } });
const seen = [];
try {
  await s.q.initializationResult();
  for (let i = 0; i < 5; i++) {
    const st = (await s.q.mcpServerStatus()).find(x => x.name === 'lumen-echo');
    seen.push(st?.status ?? '(没有)');
    await sleep(1000);
  }
} finally {
  await s.close();
}
r.note('disabledMcpjsonServers 拦住后的状态变化', seen);
r.check('没批准的项目 MCP 可以被 App 拦住、不启动', !seen.includes('connected'), seen);
r.save();
