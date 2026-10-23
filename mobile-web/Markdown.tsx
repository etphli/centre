import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export function Markdown({text}:{text:string}) {return <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{a:({href,children})=>href&&/^(https?:|mailto:)/i.test(href)?<a href={href} target="_blank" rel="noreferrer">{children}</a>:<span>{children}</span>,img:({alt})=><span className="muted">{alt ? `[Image: ${alt}]` : '[Image]'}</span>}}>{text}</ReactMarkdown></div>;}
