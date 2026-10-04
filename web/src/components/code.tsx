// 代码高亮：shiki，按需加载（第一次用到才下载），深浅两套主题跟着页面切换。太长的文件不高亮，直接显示。
import { useEffect, useState } from "react";
import type { HighlighterGeneric } from "shiki";
import { cn } from "@/lib/utils";

type H = HighlighterGeneric<string, string>;
let hl: Promise<H> | null = null;
const highlighter = () => (hl ??= import("shiki/bundle/web").then((m) => m.createHighlighter({ themes: ["github-light", "github-dark"], langs: [] }) as Promise<H>));

const EXT: Record<string, string> = {
	ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", json: "json", jsonc: "jsonc", md: "markdown",
	py: "python", css: "css", scss: "scss", html: "html", sh: "bash", zsh: "bash", bash: "bash", yaml: "yaml", yml: "yaml", toml: "toml",
	rs: "rust", go: "go", sql: "sql", tex: "latex", xml: "xml", svg: "xml", vue: "vue", java: "java", c: "c", h: "c", cpp: "cpp", swift: "swift", rb: "ruby", lua: "lua",
};
export const langOf = (path: string) => EXT[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text";

export function Code({ code, lang = "text", lines = false, className }: { code: string; lang?: string; lines?: boolean; className?: string }) {
	const [html, setHtml] = useState<string | null>(null);
	useEffect(() => {
		setHtml(null);
		if (lang === "text" || code.length > 400_000) return;
		let live = true;
		(async () => {
			const h = await highlighter();
			let l = lang;
			if (!h.getLoadedLanguages().includes(l)) {
				try { await h.loadLanguage(l as never); } catch { l = "text"; }
			}
			const out = h.codeToHtml(code, { lang: l, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false });
			if (live) setHtml(out);
		})();
		return () => { live = false; };
	}, [code, lang]);
	const cls = cn("code text-[12.5px] leading-[1.65]", lines && "code-lines", className);
	if (html) return <div className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
	return (
		<div className={cls}>
			<pre className="shiki">
				<code>{code.split("\n").map((l, i) => <span key={i} className="line">{l}{"\n"}</span>)}</code>
			</pre>
		</div>
	);
}
