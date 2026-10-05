// 在 Worker 里跑 shiki：高亮大文件时页面不卡。收 { code, lang, tokens }，回 html；tokens 时回每行的 [文字, 浅色, 深色][]（diff 要一行一行拼）。失败回 null。
// 用 shiki/core + JavaScript 正则引擎（不带 oniguruma 的 wasm），两套主题直接带上，语言用到哪个才加载哪个（名字、别名都认）。
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";

let hl: Promise<HighlighterCore> | null = null;
const highlighter = () =>
	(hl ??= createHighlighterCore({
		themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
		langs: [],
		// 个别语法里 JavaScript 正则做不到的规则跳过，不让整个语言用不了
		engine: createJavaScriptRegexEngine({ forgiving: true }),
	}));

/** 别名 → 语言的名字（ts → typescript、sh → shellscript） */
const ids = new Map(bundledLanguagesInfo.flatMap((i) => [[i.id, i.id], ...(i.aliases ?? []).map((a) => [a, i.id])] as [string, string][]));
/** 没有语法、照原文显示的 */
const PLAIN = new Set(["text", "txt", "plain", "plaintext"]);

async function language(h: HighlighterCore, lang: string) {
	const id = ids.get(lang.toLowerCase());
	if (!id) return "text";
	if (!h.getLoadedLanguages().includes(id)) await h.loadLanguage(bundledLanguages[id as keyof typeof bundledLanguages]);
	return id;
}

addEventListener("message", async (e: MessageEvent<{ code: string; lang: string; tokens?: boolean }>) => {
	try {
		const h = await highlighter();
		let l = "text";
		if (!PLAIN.has(e.data.lang)) {
			try { l = await language(h, e.data.lang); } catch { l = "text"; }
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
