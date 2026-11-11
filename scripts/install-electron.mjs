// npm 11 不会自动执行依赖包的安装脚本，Electron 本体需要手动下载。
// 本机直连 GitHub 不通（M0 发现），默认从国内镜像 npmmirror 下载；设置 ELECTRON_MIRROR 可以换镜像。
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const electronDir = path.dirname(require.resolve('electron/package.json'));
if (existsSync(path.join(electronDir, 'path.txt'))) {
  console.log('Electron 本体已就绪');
} else {
  process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';
  console.log(`下载 Electron 本体（镜像：${process.env.ELECTRON_MIRROR}）…`);
  await import(pathToFileURL(path.join(electronDir, 'install.js')).href);
}
