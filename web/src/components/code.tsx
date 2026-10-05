// 代码高亮：shiki 放在 Worker 里跑（第一次用到才起），先显示原文，高亮好了再换上；一次只跑一个，过时的请求直接丢掉。
// 深浅两套主题跟着页面切换。太长的文件不高亮，直接显示。
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const EXT: Record<string, string> = {
	ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", json: "json", jsonc: "jsonc", md: "markdown",
	py: "python", css: "css", scss: "scss", html: "html", sh: "bash", zsh: "bash", bash: "bash", yaml: "yaml", yml: "yaml", toml: "toml",
	rs: "rust", go: "go", sql: "sql", tex: "latex", xml: "xml", svg: "xml", vue: "vue", java: "java", c: "c", h: "c", cpp: "cpp", swift: "swift", rb: "ruby", lua: "lua",
};
export const langOf = (path: string) => EXT[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text";

/** 一行的词：[文字, 浅色主题的颜色, 深色主题的颜色] */
export type Token = [string, string, string];
type Out = string | Token[][] | null;
type Job = { code: string; lang: string; tokens: boolean; done: (out: Out) => void };
let worker: Worker | null = null;
let running: Job | null = null;
const queue: Job[] = [];
// 最近高亮过的，再打开同一个文件不用重跑
const cache = new Map<string, Exclude<Out, null>>();
const keyOf = (code: string, lang: string, tokens: boolean) => `${lang}\0${tokens ? "t" : "h"}\0${code}`;

function pump() {
	if (running || !queue.length) return;
	running = queue.shift()!;
	if (!worker) {
		worker = new Worker(new URL("../lib/highlight-worker.ts", import.meta.url), { type: "module" });
		worker.onmessage = (e: MessageEvent<Out>) => {
			const j = running!;
			running = null;
			if (e.data !== null) {
				cache.set(keyOf(j.code, j.lang, j.tokens), e.data);
				if (cache.size > 30) cache.delete(cache.keys().next().value!);
			}
			j.done(e.data);
			pump();
		};
		// Worker 自己挂了：这一个就显示原文，接着跑下一个
		worker.onerror = () => {
			running?.done(null);
			running = null;
			pump();
		};
	}
	worker.postMessage({ code: running.code, lang: running.lang, tokens: running.tokens });
}

/** 排队高亮；返回的函数撤销（还没开始跑的就不跑了） */
function run(code: string, lang: string, tokens: boolean, done: (out: Out) => void) {
	const hit = cache.get(keyOf(code, lang, tokens));
	if (hit) {
		done(hit);
		return () => {};
	}
	const job: Job = { code, lang, tokens, done };
	queue.push(job);
	pump();
	return () => {
		job.done = () => {};
		const i = queue.indexOf(job);
		if (i >= 0) queue.splice(i, 1);
	};
}
const highlight = (code: string, lang: string, done: (html: string | null) => void) => run(code, lang, false, done as (out: Out) => void);
/** 分好词、上好色的每一行（diff 用）；失败给 null */
export const tokenize = (code: string, lang: string, done: (lines: Token[][] | null) => void) => run(code, lang, true, done as (out: Out) => void);

export function Code({ code, lang = "text", lines = false, className }: { code: string; lang?: string; lines?: boolean; className?: string }) {
	const [html, setHtml] = useState<string | null>(null);
	useEffect(() => {
		if (lang === "text" || code.length > 400_000) return setHtml(null);
		setHtml(null);
		return highlight(code, lang, setHtml);
	}, [code, lang]);
	const cls = cn("code text-xs leading-code", lines && "code-lines", className);
	if (html) return <div className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
	return (
		<div className={cls}>
			<pre className="shiki">
				<code>{code.split("\n").map((l, i) => <span key={i} className="line">{l}{"\n"}</span>)}</code>
			</pre>
		</div>
	);
}
