// 测试用的假 gh：把收到的参数和代理设置记到 CLAUDEX_GH_LOG 里，打印一个假的 PR 地址。
import fs from 'node:fs';

const log = process.env.CLAUDEX_GH_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), proxy: process.env.HTTPS_PROXY ?? null, cwd: process.cwd() }) + '\n');
if (process.env.CLAUDEX_GH_FAIL) {
  console.error('GraphQL: something went wrong');
  process.exit(1);
}
console.log('Creating pull request for feature into main\n\nhttps://github.com/example/demo/pull/7');
