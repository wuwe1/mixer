// 在 Worker 里跑 shiki：高亮大文件时页面不卡。收 { code, lang }，回 html（失败回 null）。
import type { HighlighterGeneric } from "shiki";

type H = HighlighterGeneric<string, string>;
let hl: Promise<H> | null = null;
const highlighter = () => (hl ??= import("shiki/bundle/web").then((m) => m.createHighlighter({ themes: ["github-light", "github-dark"], langs: [] }) as Promise<H>));

addEventListener("message", async (e: MessageEvent<{ code: string; lang: string }>) => {
	try {
		const h = await highlighter();
		let l = e.data.lang;
		if (!h.getLoadedLanguages().includes(l)) {
			try { await h.loadLanguage(l as never); } catch { l = "text"; }
		}
		// 超长的行（压缩过的、lock 文件）不分词，不然一行就能卡好几秒
		postMessage(h.codeToHtml(e.data.code, { lang: l, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false, tokenizeMaxLineLength: 2000 }));
	} catch {
		postMessage(null);
	}
});
