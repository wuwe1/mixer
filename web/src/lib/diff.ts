// 把 git 的统一 diff 拆成文件 → 段 → 行，带新旧两边的行号。git diff / git show / diff --no-index 的输出都认。

export type Line = { t: "+" | "-" | " "; text: string; a?: number; b?: number };
type Hunk = { head: string; lines: Line[] };
export type FileDiff = { path: string; from?: string; kind: "M" | "A" | "D" | "R"; binary: boolean; hunks: Hunk[]; add: number; del: number };

const strip = (p: string) => p.replace(/^"|"$/g, "").replace(/^[ab]\//, "");

export function parseDiff(text: string): FileDiff[] {
	const out: FileDiff[] = [];
	let f: FileDiff | null = null;
	let h: Hunk | null = null;
	let a = 0;
	let b = 0;
	const start = (path = "") => {
		f = { path, kind: "M", binary: false, hunks: [], add: 0, del: 0 };
		out.push(f);
		h = null;
		return f;
	};
	for (const l of text.split("\n")) {
		if (l.startsWith("diff --git ") || l.startsWith("diff --cc ")) {
			// 「diff --git a/x b/x」：路径里有空格时分不清，后面的 ---/+++、rename to 会改对
			const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
			start(m?.[2] ?? "");
			continue;
		}
		const cur = f as FileDiff | null;
		if (h && cur && /^[+\- ]/.test(l)) {
			const t = l[0] as Line["t"];
			const line: Line = { t, text: l.slice(1) };
			if (t !== "+") line.a = a++;
			if (t !== "-") line.b = b++;
			if (t === "+") cur.add++;
			if (t === "-") cur.del++;
			h.lines.push(line);
			continue;
		}
		const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
		if (hm) {
			const file = cur ?? start();
			a = Number(hm[1]);
			b = Number(hm[2]);
			h = { head: l, lines: [] };
			file.hunks.push(h);
			continue;
		}
		if (!cur || h) continue;
		if (l.startsWith("new file mode")) cur.kind = "A";
		else if (l.startsWith("deleted file mode")) cur.kind = "D";
		else if (l.startsWith("rename from ")) { cur.kind = "R"; cur.from = l.slice(12); }
		else if (l.startsWith("rename to ")) cur.path = l.slice(10);
		else if (l.startsWith("Binary files ")) cur.binary = true;
		else if (l.startsWith("--- ") && l !== "--- /dev/null" && !cur.path) cur.path = strip(l.slice(4));
		else if (l.startsWith("+++ ") && l !== "+++ /dev/null") cur.path = strip(l.slice(4));
	}
	return out;
}

/** 一对删掉、加上的行：去掉相同的头和尾，中间是真改了的 [开始, 结束)。几乎整行都变了就不标 */
export function changed(x: string, y: string): [[number, number], [number, number]] | null {
	let p = 0;
	while (p < x.length && p < y.length && x[p] === y[p]) p++;
	let s = 0;
	while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
	if (p + s < Math.min(x.length, y.length) * 0.3) return null;
	return [[p, x.length - s], [p, y.length - s]];
}
