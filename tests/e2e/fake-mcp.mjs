// 端到端测试用的最小 MCP 服务器（stdio，一行一条 JSON-RPC），只有一个 echo 工具：原样回出 text。
import readline from 'node:readline';

const send = m => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // 通知不用回
  const ok = result => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-echo', version: '1.0.0' } });
    case 'tools/list':
      return ok({ tools: [{ name: 'echo', description: 'Echo back the given text, prefixed with "echo: "', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
    case 'tools/call':
      return ok({ content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }] });
    case 'ping':
      return ok({});
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
