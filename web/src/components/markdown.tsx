// Claude 回复的 Markdown：GFM（表格、任务列表），代码块用 shiki 高亮，链接新窗口打开。
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Code } from "./code";

export function Markdown({ text }: { text: string }) {
	return (
		<div className="prose prose-sm prose-neutral max-w-none break-words dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight prose-a:underline-offset-4 prose-code:before:content-none prose-code:after:content-none prose-pre:bg-transparent prose-pre:p-0 prose-table:text-[13px]">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
					pre: ({ children }) => <>{children}</>,
					code: ({ className, children }) => {
						const m = /language-(\w+)/.exec(className ?? "");
						const text = String(children ?? "");
						if (!m && !text.includes("\n")) return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] font-normal">{children}</code>;
						return <Code code={text.replace(/\n$/, "")} lang={m?.[1] ?? "text"} className="not-prose my-3 overflow-x-auto rounded-lg border bg-muted/40 p-3" />;
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}
