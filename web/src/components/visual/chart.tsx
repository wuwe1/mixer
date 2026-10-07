// 图表：line（趋势）、bar（比大小，分组）、scatter（关系）。按 dataviz 的规矩：一个纵轴；线 2px；柱子最宽 24px、顶上 4px 圆角、底下方的；
// 网格线是细实线；字用文字的颜色，不用系列色；两组以上有图例；指上去出数值；能切成表格看数。系列色是 --series-1…8，按顺序用。
// 按容器的宽来画（不是画好了再缩放）：手机上字不会缩小。
import { useCallback, useMemo, useRef, useState } from "react";
import type { Spec } from "@shared/visual";
import { cn } from "@/lib/utils";
import { TableFrame } from "../table";
import { measure } from "./graph";
import { Frame } from "./index";

const H = 260;
const TICK = 11;
const color = (i: number) => `var(--series-${i + 1})`;

/** 刻度：4–6 个整齐的数 */
function ticks(lo: number, hi: number) {
	// 一样大的撑开一点：按数的大小撑，1e17 减 1 还是它自己
	if (!(hi > lo)) {
		const d = Math.max(1, Math.abs(lo) / 10);
		[lo, hi] = [lo - d, hi + d];
	}
	const raw = (hi - lo) / 4;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
	// 按个数算，不一路 += step：数很大、跨度很小时（纳秒时间戳）加上去还是原来的数，循环停不下来
	const start = Math.floor(lo / step) * step;
	const n = Math.min(20, Math.ceil((hi - start) / step - 1e-9));
	const out = [...new Set(Array.from({ length: n + 1 }, (_, i) => Number((start + i * step).toPrecision(12))))];
	return out.length > 1 ? out : [lo, hi];
}
const fmt = (v: number) => (Math.abs(v) >= 1e4 ? Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(v) : Number(v.toPrecision(6)).toLocaleString());

/** 柱子：顶上（离基线远的那头）4px 圆角，基线那头是方的 */
function bar(x: number, w: number, y0: number, y1: number) {
	const r = Math.min(4, w / 2, Math.abs(y1 - y0));
	if (y1 <= y0) return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
	return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

export function ChartView({ spec }: { spec: Spec<"Chart"> }) {
	const [hover, setHover] = useState<{ x: number; at: number; series?: number } | null>(null);
	const [table, setTable] = useState(false);
	const box = useRef<SVGSVGElement>(null);
	// 量的是 Frame 里面那一层的宽；用回调 ref：还在写、一开始没画出来的，画出来时也量得到
	const [W, setW] = useState(640);
	const seen = useRef<ResizeObserver | null>(null);
	const wrap = useCallback((el: HTMLElement | null) => {
		seen.current?.disconnect();
		if (!el) return;
		// contentRect 不含 padding
		seen.current = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
		seen.current.observe(el);
	}, []);
	const series = useMemo(() => spec.series.slice(0, spec.kind === "scatter" ? 3 : 8), [spec.series, spec.kind]);
	const c = useMemo(() => {
		const all = series.flatMap((s) => s.points);
		const cat = spec.kind === "bar" || all.some((p) => typeof p[0] === "string");
		const cats = cat ? [...new Set(all.map((p) => String(p[0])))] : [];
		const ys = all.map((p) => p[1]);
		const xs = cat ? [] : all.map((p) => Number(p[0]));
		const yt = ticks(Math.min(spec.kind === "bar" ? 0 : Math.min(...ys), ...ys), Math.max(spec.kind === "bar" ? 0 : -Infinity, ...ys));
		const xt = cat ? [] : ticks(Math.min(...xs), Math.max(...xs));
		const left = Math.max(...yt.map((t) => measure(fmt(t), TICK))) + 10;
		const m = { l: left, r: 12, t: spec.y ? 22 : 10, b: spec.x ? 38 : 24 };
		const pw = W - m.l - m.r;
		const ph = H - m.t - m.b;
		const [y0, y1] = [yt[0], yt[yt.length - 1]];
		const sy = (v: number) => m.t + ph - ((v - y0) / (y1 - y0)) * ph;
		const band = cats.length ? pw / cats.length : 0;
		const sx = cat ? (v: number | string) => m.l + band * (cats.indexOf(String(v)) + 0.5) : (v: number | string) => m.l + ((Number(v) - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * pw;
		return { cat, cats, yt, xt, m, pw, ph, sy, sx, band };
	}, [series, spec.kind, spec.x, spec.y, W]);
	if (!series.some((s) => s.points.length)) return null;

	// 指针在哪一列（类别、或最近的 x）；scatter 是最近的那个点
	const move = (e: React.PointerEvent) => {
		const r = box.current?.getBoundingClientRect();
		if (!r) return;
		const px = ((e.clientX - r.left) * W) / r.width;
		const py = ((e.clientY - r.top) * H) / r.height;
		if (spec.kind === "scatter") {
			let best: { d: number; s: number; i: number } | null = null;
			series.forEach((s, si) => s.points.forEach((p, i) => {
				const d = Math.hypot(c.sx(p[0]) - px, c.sy(p[1]) - py);
				if (d < 24 && (!best || d < best.d)) best = { d, s: si, i };
			}));
			const b = best as { d: number; s: number; i: number } | null;
			setHover(b ? { x: c.sx(series[b.s].points[b.i][0]), at: b.i, series: b.s } : null);
			return;
		}
		const xs = c.cat ? c.cats : [...new Set(series.flatMap((s) => s.points.map((p) => Number(p[0]))))].sort((a, b) => a - b);
		if (!xs.length) return;
		const near = xs.reduce((a, b) => (Math.abs(c.sx(b) - px) < Math.abs(c.sx(a) - px) ? b : a));
		setHover({ x: c.sx(near), at: c.cat ? c.cats.indexOf(String(near)) : Number(near) });
	};
	const key = (v: number | string) => (c.cat ? String(v) : Number(v));
	const rows = hover === null ? [] : spec.kind === "scatter" && hover.series !== undefined
		? [{ s: hover.series, p: series[hover.series].points[hover.at] }]
		: series.map((s, si) => ({ s: si, p: s.points.find((p) => key(p[0]) === (c.cat ? c.cats[hover.at] : hover.at)) })).filter((r) => r.p);
	const n = series.length;
	const gw = Math.min(c.band * 0.7, n * 24 + (n - 1) * 2);
	const bw = (gw - (n - 1) * 2) / n;

	return (
		<Frame ref={wrap}>
			<div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
				{spec.title && <div className="mr-auto text-md font-medium">{spec.title}</div>}
				{n > 1 && series.map((s, i) => (
					<span key={i} className="flex items-center gap-1.5 text-xs">
						<span className={cn("shrink-0", spec.kind === "line" ? "h-0.5 w-3 rounded-full" : spec.kind === "scatter" ? "size-2 rounded-full" : "size-2 rounded-sm")} style={{ background: color(i) }} />
						{s.name}
					</span>
				))}
				<button type="button" className="ml-auto text-2xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setTable(!table)}>{table ? "看图" : "看数据"}</button>
			</div>
			{table ? <DataTable spec={spec} series={series} /> : (
				<div className="relative">
					<svg ref={box} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full touch-pan-y" role="img" aria-label={spec.title} onPointerMove={move} onPointerLeave={() => setHover(null)}>
						{c.yt.map((t) => (
							<g key={t}>
								<line x1={c.m.l} x2={W - c.m.r} y1={c.sy(t)} y2={c.sy(t)} className={t === 0 ? "stroke-muted-foreground" : "stroke-border"} strokeWidth={1} />
								<text x={c.m.l - 6} y={c.sy(t) + 3.5} fontSize={TICK} textAnchor="end" className="fill-muted-foreground tabular-nums">{fmt(t)}</text>
							</g>
						))}
						{spec.y && <text x={4} y={11} fontSize={TICK} className="fill-muted-foreground">{spec.y}</text>}
						{c.cat
							? c.cats.map((k) => <text key={k} x={c.sx(k)} y={H - c.m.b + 16} fontSize={TICK} textAnchor="middle" className="fill-muted-foreground">{k}</text>)
							: c.xt.map((t) => <text key={t} x={c.sx(t)} y={H - c.m.b + 16} fontSize={TICK} textAnchor="middle" className="fill-muted-foreground tabular-nums">{fmt(t)}</text>)}
						{spec.x && <text x={W - c.m.r} y={H - 4} fontSize={TICK} textAnchor="end" className="fill-muted-foreground">{spec.x}</text>}
						{hover && spec.kind !== "scatter" && <line x1={hover.x} x2={hover.x} y1={c.m.t} y2={c.m.t + c.ph} className="stroke-muted-foreground" strokeWidth={1} />}
						{series.map((s, si) => {
							if (spec.kind === "bar") {
								return s.points.map((p, i) => {
									const x = c.sx(p[0]) - gw / 2 + si * (bw + 2);
									return <path key={i} d={bar(x, bw, c.sy(0), c.sy(p[1]))} style={{ fill: color(si) }} opacity={hover && c.cats[hover.at] !== String(p[0]) ? 0.45 : 1} />;
								});
							}
							if (spec.kind === "scatter") {
								return s.points.map((p, i) => <circle key={i} cx={c.sx(p[0])} cy={c.sy(p[1])} r={hover?.series === si && hover.at === i ? 6 : 4} strokeWidth={2} className="stroke-card" style={{ fill: color(si) }} />);
							}
							const pts = [...s.points].sort((a, b) => (c.cat ? 0 : Number(a[0]) - Number(b[0])));
							const last = pts[pts.length - 1];
							const on = hover && pts.find((p) => key(p[0]) === (c.cat ? c.cats[hover.at] : hover.at));
							return (
								<g key={si}>
									<path d={pts.map((p, i) => `${i ? "L" : "M"}${c.sx(p[0])},${c.sy(p[1])}`).join("")} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: color(si) }} />
									{last && <circle cx={c.sx(last[0])} cy={c.sy(last[1])} r={4} strokeWidth={2} className="stroke-card" style={{ fill: color(si) }} />}
									{on && <circle cx={c.sx(on[0])} cy={c.sy(on[1])} r={5} strokeWidth={2} className="stroke-card" style={{ fill: color(si) }} />}
								</g>
							);
						})}
					</svg>
					{hover && !!rows.length && (
						<div className="pointer-events-none absolute top-1 z-10 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm" style={hover.x > W / 2 ? { right: `${((W - hover.x) / W) * 100 + 1}%` } : { left: `${(hover.x / W) * 100 + 1}%` }}>
							<div className="mb-0.5 text-2xs text-muted-foreground">{spec.x ? `${spec.x} ` : ""}{String(rows[0].p?.[0])}</div>
							{rows.map((r) => (
								<div key={r.s} className="flex items-center gap-1.5 whitespace-nowrap">
									<span className="size-2 shrink-0 rounded-full" style={{ background: color(r.s) }} />
									{n > 1 && <span>{series[r.s].name}</span>}
									<span className="ml-auto pl-2 font-medium tabular-nums">{fmt(r.p?.[1] ?? 0)}</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}
			{spec.series.length > series.length && <div className="mt-1 text-2xs text-muted-foreground">只画了前 {series.length} 组</div>}
		</Frame>
	);
}

/** 同样的数，排成表：横轴一列，每组一列。和回复里的表一样放进 TableFrame（手机上放不下时排成卡片或横着滚） */
function DataTable({ spec, series }: { spec: Spec<"Chart">; series: Spec<"Chart">["series"] }) {
	const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))];
	if (xs.every((x) => typeof x === "number")) xs.sort((a, b) => Number(a) - Number(b));
	const head = spec.x ?? "x";
	return (
		<TableFrame>
			<table>
				<thead>
					<tr>
						<th>{head}</th>
						{series.map((s, i) => <th key={i}>{s.name}</th>)}
					</tr>
				</thead>
				<tbody>
					{xs.map((x) => (
						<tr key={String(x)}>
							<td data-label={head}>{x}</td>
							{series.map((s, i) => <td key={i} data-label={s.name} className="text-right tabular-nums">{s.points.find((p) => p[0] === x)?.[1] ?? ""}</td>)}
						</tr>
					))}
				</tbody>
			</table>
		</TableFrame>
	);
}
