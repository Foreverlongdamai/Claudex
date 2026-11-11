// 还没有项目时的欢迎页：说明怎么开始，顺便显示运行环境检查结果。
import { useStore } from '../store';
import { Icon } from './Icon';

export function Welcome() {
  const env = useStore(s => s.env);
  const models = useStore(s => s.models);
  const modelsError = useStore(s => s.modelsError);
  const pickProject = useStore(s => s.pickProject);
  const checks = [
    { ok: models.length > 0, wait: !models.length && !modelsError, text: models.length ? `Claude Code 已连接，可用模型：${models.map(m => m.displayName).join('、')}` : modelsError ? `连不上 Claude Code：${modelsError}` : '正在连接 Claude Code…' },
    { ok: !!env?.gitBashPath, text: env?.gitBashPath ? `Git Bash：${env.gitBashPath}` : '没找到 Git Bash：Claude 只能用 PowerShell（可以在设置里手动指定）' },
    { ok: true, text: env?.relayHost ? `API：走中转（${env.relayHost}）` : 'API：直连 Anthropic' }
  ];
  return (
    <div className="welcome">
      <div className="welcome-in">
        <div className="logo big" />
        <h1>欢迎使用 Claudex</h1>
        <p>本机 Claude Code 的图形界面。你的 Skills、MCP、CLAUDE.md 和设置都会照常生效。</p>
        <button className="btn primary lg" data-testid="welcome-add-project" onClick={() => void pickProject()}><Icon name="folderPlus" />打开一个项目文件夹</button>
        <div className="checks">
          {checks.map((c, i) => (
            <div key={i} className={`env-line ${c.wait ? 'wait' : c.ok ? 'ok' : 'bad'}`}>
              {c.wait ? <i className="spin" /> : <Icon name={c.ok ? 'check' : 'alert'} size={14} />}{c.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
