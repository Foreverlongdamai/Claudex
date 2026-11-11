// Claude 回复里的 Markdown。不渲染原始 HTML（react-markdown 默认就不渲染），链接用系统浏览器打开。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} onClick={e => { e.preventDefault(); if (href) void window.claudex.openExternal(href); }}>
              {children}
            </a>
          ),
          table: ({ children }) => <div className="md-table"><table>{children}</table></div>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
