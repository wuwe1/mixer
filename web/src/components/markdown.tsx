// Claude 回复的 Markdown：GFM（表格、任务列表），代码块用 shiki 高亮，链接新窗口打开；```ui 代码块画成图解（components/visual）。
// remark-cjk-friendly：CommonMark 里「**（readings）**加了」这种收尾的 ** 前面是全角标点、后面紧跟汉字的不算加粗，中文里到处都是；
// 删除线（~~）同样的毛病，gfm-strikethrough 那个管
import { useDeferredValue } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import remarkGfm from "remark-gfm";
import { Code } from "./code";
import { Visual } from "./lazy";
import { TableFrame } from "./table";

/** hast 里用得到的那点（不为这个装 @types/hast） */
type HNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HNode[] };
const text = (n: HNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(text).join(""));
const kids = (n: HNode, tag: string) => (n.children ?? []).filter((c) => c.tagName === tag);

/** 表格每一格带上它那一列的列名（data-label）：手机上排成卡片时写在格子上面（components/table.tsx） */
const rehypeTableLabels = () => (root: HNode) => {
	const visit = (n: HNode) => {
		if (n.tagName === "table") {
			const head = kids(n, "thead").flatMap((t) => kids(t, "tr"))[0];
			const labels = head ? kids(head, "th").map((th) => text(th).trim()) : [];
			for (const tr of kids(n, "tbody").flatMap((t) => kids(t, "tr")))
				kids(tr, "td").forEach((td, i) => { if (labels[i]) td.properties = { ...td.properties, dataLabel: labels[i] }; });
			return;
		}
		n.children?.forEach(visit);
	};
	visit(root);
};

// 放在外面：每次画都是同一份，代码块不会每来一个字就重新挂载（高亮重来、横着滚的位置丢掉）
const PLUGINS = [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough];
const REHYPE = [rehypeTableLabels];
const COMPONENTS: Components = {
	a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
	pre: ({ children }) => <>{children}</>,
	table: ({ node: _n, ...p }) => (
		<TableFrame className="my-4">
			<table {...p} />
		</TableFrame>
	),
	code: ({ className, children }) => {
		const m = /language-(\w+)/.exec(className ?? "");
		const text = String(children ?? "");
		if (m?.[1] === "ui") return <Visual source={text} />;
		if (!m && !text.includes("\n")) return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-normal">{children}</code>;
		return <Code code={text.replace(/\n$/, "")} lang={m?.[1] ?? "text"} className="not-prose my-3 overflow-x-auto rounded-lg border bg-muted/40 p-3" />;
	},
};

/**
 * 正在写的回复每来一段字整条重新解析，长了很费（10KB 一次好几毫秒，手机上再慢几倍）：用 deferred 的那一份画，
 * 忙不过来时 React 跳过中间几版、直接画最新的，滚动、打字不卡
 */
export function Markdown({ text: now }: { text: string }) {
	const text = useDeferredValue(now);
	return (
		<div className="prose prose-sm prose-neutral max-w-none break-words dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight prose-a:underline-offset-4 prose-code:before:content-none prose-code:after:content-none prose-pre:bg-transparent prose-pre:p-0">
			<ReactMarkdown remarkPlugins={PLUGINS} rehypePlugins={REHYPE} components={COMPONENTS}>
				{text}
			</ReactMarkdown>
		</div>
	);
}
