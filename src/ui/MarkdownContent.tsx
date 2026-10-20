import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { openExternal } from '../data/client';

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href && /^https?:\/\//.test(href)) void openExternal(href).catch(() => undefined);
      }}
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="markdown__table">
      <table>{children}</table>
    </div>
  ),
};

export default function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore',macros:{'\\ensuremath':'#1'} }]]} components={components}>
        {children.replace(/\\\(([\s\S]*?)\\\)/g, (_, math: string) => `$${math}$`).replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `$$${math}$$`)}
      </ReactMarkdown>
    </div>
  );
}
