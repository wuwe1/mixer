// diff 的样子，照 GitHub：左边旧、新两列行号，加的行绿底、删的行红底，代码照常高亮；成对改过的行里，真改了的那几个字底色再深一点。
// 高亮：旧的一边（没变的 + 删掉的）、新的一边（没变的 + 加上的）各拼成一段交给 Worker，再按行放回去。
import { type CSSProperties, Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { enc } from "@shared/api";
import { changed, type FileDiff, type Line, parseDiff } from "@/lib/diff";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import { langOf, type Token, tokenize } from "./code";

/** 改了这么多行以上先不画，点了再画 */
const MAX = 1500;

function useTokens(f: FileDiff, on: boolean) {
	const [a, b] = useMemo(() => {
		const a: string[] = [];
		const b: string[] = [];
		for (const h of f.hunks) for (const l of h.lines) {
			if (l.t !== "+") a.push(l.text);
			if (l.t !== "-") b.push(l.text);
		}
		return [a.join("\n"), b.join("\n")];
	}, [f]);
	const lang = langOf(f.path);
	const [ta, setA] = useState<Token[][] | null>(null);
	const [tb, setB] = useState<Token[][] | null>(null);
	const skip = !on || lang === "text";
	useEffect(() => { if (skip || !a || a.length > 200_000) return setA(null); return tokenize(a, lang, setA); }, [a, lang, skip]);
	useEffect(() => { if (skip || !b || b.length > 200_000) return setB(null); return tokenize(b, lang, setB); }, [b, lang, skip]);
	return useMemo(() => {
		const m = new Map<Line, Token[]>();
		let i = 0;
		let j = 0;
		for (const h of f.hunks) for (const l of h.lines) {
			const t = l.t === "-" ? ta?.[i] : tb?.[j];
			if (l.t !== "+") i++;
			if (l.t !== "-") j++;
			if (t) m.set(l, t);
		}
		return m;
	}, [f, ta, tb]);
}

/** 一段里连着的删掉的行和紧跟着的加上的行，按顺序一对一配起来，找出真改了的那段 */
function useEmphasis(f: FileDiff) {
	return useMemo(() => {
		const m = new Map<Line, [number, number]>();
		for (const h of f.hunks) {
			const ls = h.lines;
			for (let i = 0; i < ls.length; ) {
				if (ls[i].t !== "-") { i++; continue; }
				let j = i;
				while (j < ls.length && ls[j].t === "-") j++;
				let k = j;
				while (k < ls.length && ls[k].t === "+") k++;
				for (let n = 0; n < Math.min(j - i, k - j); n++) {
					const r = changed(ls[i + n].text, ls[j + n].text);
					if (r) { m.set(ls[i + n], r[0]); m.set(ls[j + n], r[1]); }
				}
				i = k;
			}
		}
		return m;
	}, [f]);
}

/** 一行的字：按词上色，em 那段再套一层深底 */
function Text({ text, toks, em, emCls }: { text: string; toks?: Token[]; em?: [number, number]; emCls: string }) {
	const out: ReactNode[] = [];
	let pos = 0;
	for (const [s, light, dark] of toks ?? [[text, "", ""] as Token]) {
		const end = pos + s.length;
		const cuts = em ? [pos, Math.min(end, Math.max(pos, em[0])), Math.min(end, Math.max(pos, em[1])), end] : [pos, end];
		const style = light ? ({ "--shiki-light": light, "--shiki-dark": dark } as CSSProperties) : undefined;
		for (let i = 0; i < cuts.length - 1; i++) {
			if (cuts[i + 1] <= cuts[i]) continue;
			out.push(<span key={`${pos}-${i}`} style={style} className={em && i === 1 ? cn("rounded-xs", emCls) : undefined}>{s.slice(cuts[i] - pos, cuts[i + 1] - pos)}</span>);
		}
		pos = end;
	}
	return out;
}

const ROW = {
	"+": { line: "bg-added/10", gutter: "bg-added/15", sign: "text-added", em: "bg-added/30" },
	"-": { line: "bg-removed/10", gutter: "bg-removed/15", sign: "text-removed", em: "bg-removed/30" },
	" ": { line: "", gutter: "", sign: "", em: "" },
};

/** diff 那里的一句灰字：不显示内容的原因、出错 */
/**
 * 一个文件没提交的改动：「改动」里展开一个文件、「文件」里切到改动，都用它。path 是 null 先不拿；
 * 拿到之前是 null，拿不到是原因，没有 diff 时是 none。again 变了再拿一次（拿到之前先显示旧的）
 */
export function useDiff(project: string, path: string | null, none: string, again?: unknown): FileDiff | string | null {
	const { data, error } = useApi<{ diff: string }>(path === null ? null : `/api/repo/${enc(project)}/diff?path=${enc(path)}`, { again });
	return useMemo(() => (error ? error.message : data ? (parseDiff(data.diff)[0] ?? none) : null), [data, error, none]);
}

export const Note = ({ children }: { children: ReactNode }) => <p className="px-3 py-2 text-xs text-muted-foreground">{children}</p>;

/** 一个文件的 diff（不带文件名那行） */
export function Hunks({ file }: { file: FileDiff }) {
	const big = file.add + file.del > MAX;
	const [all, setAll] = useState(false);
	const show = !big || all;
	const toks = useTokens(file, show);
	const em = useEmphasis(file);
	if (file.binary) return <Note>二进制文件，不显示内容</Note>;
	if (!file.hunks.length) return <Note>{file.kind === "R" ? `只改了名字，原来是 ${file.from}` : "内容没变（可能只改了权限）"}</Note>;
	if (!show)
		return (
			<button type="button" onClick={() => setAll(true)} className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
				改了 {file.add + file.del} 行，点这里显示
			</button>
		);
	// 新文件只有一段，那行 @@ 没什么用
	const heads = !(file.kind === "A" && file.hunks.length === 1);
	return (
		<div className="overflow-x-auto overscroll-x-contain">
			<div className="diff grid w-max min-w-full grid-cols-[auto_auto_1fr] font-mono text-xs leading-code">
				{file.hunks.map((h, i) => (
					<Fragment key={i}>
						{heads && <div className="col-span-3 bg-muted px-3 py-0.5 text-muted-foreground">{h.head}</div>}
						{h.lines.map((l, j) => {
							const r = ROW[l.t];
							return (
								<Fragment key={j}>
									<span className={cn("px-2 text-right text-muted-foreground/60 tabular-nums select-none", r.gutter)}>{l.a}</span>
									<span className={cn("px-2 text-right text-muted-foreground/60 tabular-nums select-none", r.gutter)}>{l.b}</span>
									<span className={cn("pr-4 whitespace-pre", r.line)}>
										<span className={cn("inline-block w-4 text-center select-none", r.sign)}>{l.t === " " ? "" : l.t}</span>
										<Text text={l.text} toks={toks.get(l)} em={em.get(l)} emCls={r.em} />
									</span>
								</Fragment>
							);
						})}
					</Fragment>
				))}
			</div>
		</div>
	);
}
