// 表格（回复里的 Markdown 表格、图解的 Table 共用）：放得下就是普通的表；放不下（手机上常见）按内容挑：
// - 列不多、格子里是长句子（比如「位置 / 问题 / 后果」）：一行一张卡片，第一列当标题，其余每格上面一行小字写列名
// - 列多、格子短（数字、对比）：横着滚，第一列钉在左边
// 放不放得下按每列要多宽估：最长那格的字数（汉字算一个字宽，字母数字算半个多），一列最多算 14 个字宽，再加左右留白。
// 卡片靠 CSS 换排法（index.css 的 .table-cards），列名在每格的 data-label 上：Markdown 的由 rehypeTableLabels 补，图解的自己写
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Mode = "table" | "scroll" | "cards";

/** 一格的字要多宽（单位：字宽）：全角算 1，其余算 0.6 */
const width = (s: string) => {
	let w = 0;
	for (const ch of s) w += /[⺀-鿿가-힯豈-﫿＀-￯]/.test(ch) ? 1 : 0.6;
	return w;
};

/** 放不下时怎么排：列不多或格子里多是长句子就排成卡片，不然横着滚 */
function pick(table: HTMLTableElement, room: number): Mode {
	const rows = [...table.rows];
	const cols = Math.max(0, ...rows.map((r) => r.cells.length));
	if (!cols) return "table";
	const font = Number.parseFloat(getComputedStyle(table).fontSize) || 13;
	const need: number[] = Array(cols).fill(3);
	let chars = 0;
	let cells = 0;
	for (const r of rows)
		[...r.cells].forEach((c, i) => {
			const w = width(c.textContent?.trim() ?? "");
			need[i] = Math.max(need[i], Math.min(w, 14));
			// 几个字的格子（序号、状态、数字）不折行：不然列被挤窄时「1 ✓」也断成两行
			c.toggleAttribute("data-short", w <= 6);
			if (r.parentElement?.tagName === "TBODY") { chars += w; cells++; }
		});
	// 每列左右各 12px 留白
	if (need.reduce((a, b) => a + b, 0) * font + cols * 24 <= room) return "table";
	return cols <= 4 || chars / Math.max(cells, 1) > 12 ? "cards" : "scroll";
}

/** 包在 <table> 外面：量宽度、挑排法；不是放得下的那种，右上角能换着看 */
export function TableFrame({ children, className }: { children: ReactNode; className?: string }) {
	const box = useRef<HTMLDivElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	// 横着滚、右边还有：右边渐隐，看得出能往左拖
	const [more, setMore] = useState(false);
	const edge = () => {
		const s = scroller.current;
		setMore(!!s && s.scrollLeft + s.clientWidth < s.scrollWidth - 1);
	};
	const [auto, setAuto] = useState<Mode>("table");
	// 人点过「按表格看 / 按卡片看」就照他的
	const [chosen, setChosen] = useState<Mode | null>(null);
	useLayoutEffect(() => {
		const el = box.current;
		const table = el?.querySelector("table");
		if (!el || !table) return;
		const measure = () => {
			setAuto(pick(table, el.clientWidth));
			edge();
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [children]);
	const mode = auto === "table" ? "table" : (chosen ?? auto);
	useLayoutEffect(edge, [mode]);
	return (
		<div ref={box} className={cn("table-box not-prose", className)}>
			{auto !== "table" && (
				<div className="flex justify-end">
					<Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setChosen(mode === "cards" ? "scroll" : "cards")}>
						{mode === "cards" ? "按表格看" : "按卡片看"}
					</Button>
				</div>
			)}
			<div ref={scroller} onScroll={edge} data-more={mode === "scroll" && more ? "" : undefined} className={cn("table-frame", mode === "cards" ? "table-cards" : "overflow-x-auto rounded-lg border", mode === "scroll" && "table-scroll")}>
				{children}
			</div>
		</div>
	);
}
