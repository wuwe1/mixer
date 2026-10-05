// 在 Worker 里跑 shiki：高亮大文件时页面不卡。收 { code, lang, tokens }，回 html；tokens 时回每行的 [文字, 浅色, 深色][]（diff 要一行一行拼）。失败回 null。
import type { HighlighterGeneric } from "shiki";

type H = HighlighterGeneric<string, string>;
let hl: Promise<H> | null = null;
const highlighter = () => (hl ??= import("shiki/bundle/web").then((m) => m.createHighlighter({ themes: ["github-light", "github-dark"], langs: [] }) as Promise<H>));

addEventListener("message", async (e: MessageEvent<{ code: string; lang: string; tokens?: boolean }>) => {
	try {
		const h = await highlighter();
		let l = e.data.lang;
		if (!h.getLoadedLanguages().includes(l)) {
			try { await h.loadLanguage(l as never); } catch { l = "text"; }
		}
		// 超长的行（压缩过的、lock 文件）不分词，不然一行就能卡好几秒
		const opts = { lang: l, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false as const, tokenizeMaxLineLength: 2000 };
		if (!e.data.tokens) return postMessage(h.codeToHtml(e.data.code, opts));
		const style = (s: unknown, k: string) => (s && typeof s === "object" ? ((s as Record<string, string>)[k] ?? "") : "");
		postMessage(h.codeToTokens(e.data.code, opts).tokens.map((line) => line.map((t) => [t.content, style(t.htmlStyle, "--shiki-light"), style(t.htmlStyle, "--shiki-dark")])));
	} catch {
		postMessage(null);
	}
});
