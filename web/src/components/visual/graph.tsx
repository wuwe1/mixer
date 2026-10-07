// 图：节点和箭头（Graph，dagre 自动排）、树（换成从上到下的 Graph）、时序图（Sequence，自己排：一列一个参与者、一行一条消息）。
// Claude 只给关系，不给坐标；字宽用 canvas 量，节点按字的大小定。线、框是 border / muted-foreground，要盯住的用 foreground 加粗；
// Graph 的 kinds（节点的类型）按顺序用系列色（--series-1…）：浅底色加同色边框，同一类的另一种状态（alt）更浅、带斜线，图下出图例。
// 组是框：实线框（浅底）是真实存在的东西，虚线框是逻辑上的一组，能一层套一层
import { Graph as Dagre, layout } from "@dagrejs/dagre";
import { useId, useMemo } from "react";
import type { Spec, TreeItem } from "@/lib/visual";
import { cn } from "@/lib/utils";
import { useDone } from "./index";

const LABEL = 13;
const NOTE = 11;
let ctx: CanvasRenderingContext2D | null = null;
/** 一行字画出来多宽（px）。和页面同一个字体 */
export function measure(text: string, size: number, weight = 400) {
	ctx ??= document.createElement("canvas").getContext("2d");
	if (!ctx) return text.length * size * 0.6;
	ctx.font = `${weight} ${size}px ${getComputedStyle(document.body).fontFamily}`;
	return ctx.measureText(text).width;
}

/** 折线 → 平滑曲线（d3 的 curveBasis） */
function basis(ps: { x: number; y: number }[]) {
	if (ps.length < 3) return ps.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join("");
	let d = `M${ps[0].x},${ps[0].y}L${(5 * ps[0].x + ps[1].x) / 6},${(5 * ps[0].y + ps[1].y) / 6}`;
	for (let i = 2; i < ps.length; i++) {
		const [a, b, c] = [ps[i - 2], ps[i - 1], ps[i]];
		d += `C${(2 * a.x + b.x) / 3},${(2 * a.y + b.y) / 3},${(a.x + 2 * b.x) / 3},${(a.y + 2 * b.y) / 3},${(a.x + 4 * b.x + c.x) / 6},${(a.y + 4 * b.y + c.y) / 6}`;
	}
	const [a, b] = [ps[ps.length - 2], ps[ps.length - 1]];
	return `${d}C${(2 * a.x + b.x) / 3},${(2 * a.y + b.y) / 3},${(a.x + 2 * b.x) / 3},${(a.y + 2 * b.y) / 3},${b.x},${b.y}`;
}

/** svg 里 marker 的 id：useId 带的符号不能放进 url(#…) */
const useSvgId = () => useId().replace(/[^\w-]/g, "");

function Arrow({ id }: { id: string }) {
	return (
		<marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path d="M0,1L9,5L0,9z" className="fill-muted-foreground" />
		</marker>
	);
}

/** 大图在手机上不缩成看不清：最多缩到 0.6，再大就横着滚 */
function Canvas({ w, h, children }: { w: number; h: number; children: React.ReactNode }) {
	return (
		<div className="overflow-x-auto">
			<svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="mx-auto block h-auto max-w-full" style={{ minWidth: w * 0.6 }} role="img">
				{children}
			</svg>
		</div>
	);
}

export function GraphView({ spec }: { spec: Spec<"Graph"> }) {
	const g = useMemo(() => place(spec), [spec]);
	return <Drawing g={g} />;
}

type Placed = Spec<"Graph">["nodes"][number] & { x: number; y: number; w: number; h: number; tone?: number };
/** 排好的图：Graph（dagre）、Tree（自己排）都出这个，同一个画法 */
type Laid = {
	w: number;
	h: number;
	nodes: Placed[];
	groups: { id: string; label: string; x: number; y: number; w: number; h: number; dashed?: boolean }[];
	/** 图例：用到了的类型，tone 是第几个系列色（从 1 起） */
	legend: { label: string; tone: number }[];
	edges: { points: { x: number; y: number }[]; label?: string; lw: number; at: { x: number; y: number } | null; dashed?: boolean }[];
	missing: string[];
};

/** 第几个系列色的浅底（alt 更浅）、边框 */
const tint = (tone: number, alt?: boolean) => `color-mix(in oklab, var(--series-${tone}) ${alt ? 10 : 22}%, var(--card))`;
const line = (tone: number) => `var(--series-${tone})`;

function Drawing({ g }: { g: Laid }) {
	const done = useDone();
	const id = useSvgId();
	const tones = [...new Set(g.nodes.filter((n) => n.alt && n.tone).map((n) => n.tone as number))];
	return (
		<figure className="min-w-0 rounded-lg border bg-card p-3">
			<Canvas w={g.w} h={g.h}>
				<defs>
					<Arrow id={id} />
					{/* alt 的斜线：每个用到的系列色一种 */}
					{tones.map((t) => (
						<pattern key={t} id={`${id}-h${t}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
							<rect width="6" height="6" style={{ fill: tint(t, true) }} />
							<line x1="0" y1="0" x2="0" y2="6" strokeWidth="1.5" style={{ stroke: line(t) }} strokeOpacity={0.35} />
						</pattern>
					))}
				</defs>
				{g.groups.map((c) => (
					<g key={c.id}>
						<rect x={c.x} y={c.y} width={c.w} height={c.h} rx={8} className={c.dashed ? "fill-none stroke-muted-foreground" : "fill-muted/40 stroke-border"} strokeDasharray={c.dashed ? "5 4" : undefined} />
						{/* 描一圈底色：穿过标题的线不把字划花 */}
						<text x={c.x + 8} y={c.y + 14} fontSize={NOTE} fontWeight={c.dashed ? 400 : 500} className="fill-muted-foreground stroke-card" strokeWidth={3} paintOrder="stroke">{c.label}</text>
					</g>
				))}
				{g.edges.map((e, i) => (
					<g key={i}>
						<path d={basis(e.points)} fill="none" strokeWidth={1.25} strokeDasharray={e.dashed ? "4 3" : undefined} markerEnd={`url(#${id})`} className="stroke-muted-foreground" />
						{e.label && e.at && (
							<g>
								<rect x={e.at.x - e.lw / 2 - 3} y={e.at.y - 8} width={e.lw + 6} height={16} rx={3} className="fill-card" />
								<text x={e.at.x} y={e.at.y + 4} fontSize={NOTE} textAnchor="middle" className="fill-muted-foreground">{e.label}</text>
							</g>
						)}
					</g>
				))}
				{g.nodes.map((n) => <Box key={n.id} n={n} hatch={n.alt && n.tone ? `url(#${id}-h${n.tone})` : undefined} />)}
			</Canvas>
			{!!g.legend.length && (
				<figcaption className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
					{g.legend.map((k) => (
						<span key={k.tone} className="flex items-center gap-1.5">
							<span className="size-2.5 rounded-sm border" style={{ background: tint(k.tone), borderColor: line(k.tone) }} />
							{k.label}
						</span>
					))}
				</figcaption>
			)}
			{done && !!g.missing.length && <figcaption className="mt-2 text-2xs text-muted-foreground">没画的箭头：{g.missing.join("；")}</figcaption>}
		</figure>
	);
}

/** 叠成几层时后面露出来的那两层各错开多少 */
const STACK = 4;

/** 节点按字的大小定宽高（叠层的要多留出后面两层的位置） */
function sizeOf(n: { label: string; note?: string; emphasis?: boolean; shape?: string; stack?: boolean }) {
	const tw = Math.max(measure(n.label, LABEL, n.emphasis ? 600 : 500), n.note ? measure(n.note, NOTE) : 0);
	const [w, h] = [Math.max(tw + 24, 56), n.note ? 46 : 32];
	if (n.shape === "diamond") return { w: w * 1.5, h: h * 1.5 };
	return n.stack ? { w: w + STACK * 2, h: h + STACK * 2 } : { w, h };
}

/** 一个节点：有类型的上系列色（alt 用斜线），便签是没边框的灰底，叠层的在右下方露出两层 */
function Box({ n, hatch }: { n: Placed; hatch?: string }) {
	const note = n.shape === "note";
	const style = n.tone ? { fill: hatch ?? tint(n.tone, n.alt), stroke: n.emphasis ? undefined : line(n.tone) } : undefined;
	const cls = cn(note ? "fill-muted stroke-none" : "fill-card stroke-border", n.emphasis && "stroke-foreground");
	const sw = n.emphasis ? 1.75 : 1;
	const off = n.stack && n.shape !== "diamond" ? STACK * 2 : 0;
	const [w, h] = [n.w - off, n.h - off];
	const [l, t] = [n.x - n.w / 2, n.y - n.h / 2];
	const [cx, cy] = [l + w / 2, t + h / 2];
	const ly = n.note ? cy - 2 : cy + 4.5;
	const rx = n.shape === "round" ? h / 2 : note ? 2 : 6;
	return (
		<g opacity={n.dim ? 0.35 : undefined}>
			{[2, 1].map((k) => off > 0 && <rect key={k} x={l + STACK * k} y={t + STACK * k} width={w} height={h} rx={rx} className={cls} style={style} strokeWidth={1} />)}
			{n.shape === "diamond" ? (
				<polygon points={`${n.x},${t} ${l + n.w},${n.y} ${n.x},${t + n.h} ${l},${n.y}`} className={cls} style={style} strokeWidth={sw} />
			) : (
				<rect x={l} y={t} width={w} height={h} rx={rx} className={cls} style={style} strokeWidth={sw} />
			)}
			<text x={cx} y={ly} fontSize={note ? NOTE + 1 : LABEL} fontWeight={n.emphasis ? 600 : note ? 400 : 500} textAnchor="middle" className="fill-foreground">{n.label}</text>
			{n.note && <text x={cx} y={ly + 15} fontSize={NOTE} textAnchor="middle" className="fill-muted-foreground">{n.note}</text>}
		</g>
	);
}

/** dagre 排位置。指向不存在的节点的箭头不画，写完了在图下面列出来 */
function place(spec: Spec<"Graph">): Laid {
	const g = new Dagre({ compound: true, multigraph: true });
	const lr = spec.direction !== "TB";
	g.setGraph({ rankdir: lr ? "LR" : "TB", nodesep: 24, ranksep: lr ? 56 : 44, edgesep: 12, marginx: 8, marginy: 8 });
	g.setDefaultEdgeLabel(() => ({}));
	const groups = new Map((spec.groups ?? []).map((c) => [c.id, c]));
	const kinds = new Map((spec.kinds ?? []).slice(0, 8).map((k, i) => [k.id, { label: k.label, tone: i + 1 }]));
	const nodes = new Map<string, Spec<"Graph">["nodes"][number]>();
	for (const n of spec.nodes) {
		if (nodes.has(n.id)) continue;
		nodes.set(n.id, n);
		const { w, h } = sizeOf(n);
		g.setNode(n.id, { width: w, height: h });
	}
	for (const [cid] of groups) g.setNode(`group:${cid}`, { paddingTop: 20 });
	// 组套组：parent 指向别的组（不能是自己、不能绕成圈）
	const depth = (cid: string, seen = new Set<string>()): number => {
		const p = groups.get(cid)?.parent;
		if (!p || !groups.has(p) || seen.has(p) || p === cid) return 0;
		seen.add(cid);
		return 1 + depth(p, seen);
	};
	for (const [cid, c] of groups) if (c.parent && groups.has(c.parent) && c.parent !== cid && !ancestors(groups, c.parent).has(cid)) g.setParent(`group:${cid}`, `group:${c.parent}`);
	for (const n of nodes.values()) if (n.group && groups.has(n.group)) g.setParent(n.id, `group:${n.group}`);
	// 没有箭头、没有组：按 nodes 的顺序排成等宽的一行（TB 是一列），数组、栈、队列。交给 dagre 的话会叠成一列、顺序也不保
	if (!spec.edges.length && !groups.size) return row([...nodes.values()], lr, kinds);
	const missing: string[] = [];
	spec.edges.forEach((e, i) => {
		const lost = [e.from, e.to].filter((x) => !nodes.has(x));
		if (lost.length) { missing.push(`${e.from} → ${e.to}（没有 ${lost.join("、")}）`); return; }
		const lw = e.label ? measure(e.label, NOTE) : 0;
		g.setEdge({ v: e.from, w: e.to, name: String(i) }, { label: e.label, width: lw ? lw + 8 : 0, height: lw ? 16 : 0, labelpos: "c" });
	});
	layout(g);
	const info = g.graph();
	const placed = [...nodes.values()].map((n): Placed => {
		const p = g.node(n.id);
		return { ...n, x: p.x, y: p.y, w: p.width, h: p.height, tone: n.kind ? kinds.get(n.kind)?.tone : undefined };
	});
	// 外层的先画，里层的盖在上面
	const boxes = [...groups].sort(([a], [b]) => depth(a) - depth(b)).map(([cid, c]) => {
		const p = g.node(`group:${cid}`);
		// 空的组 dagre 不给位置
		return p && Number.isFinite(p.x) ? { id: cid, label: c.label, dashed: c.dashed, x: p.x - p.width / 2, y: p.y - p.height / 2 - 12, w: p.width, h: p.height + 12 } : null;
	}).filter((c) => c !== null);
	const used = new Set(placed.map((n) => n.tone));
	const legend = [...kinds.values()].filter((k) => used.has(k.tone));
	const edges = g.edges().map((ref) => {
		const e = g.edge(ref) as { points: { x: number; y: number }[]; x?: number; y?: number; label?: string };
		const src = spec.edges[Number(ref.name)];
		return { points: e.points, label: e.label, lw: e.label ? measure(e.label, NOTE) : 0, at: e.x !== undefined && e.y !== undefined ? { x: e.x, y: e.y } : null, dashed: src?.dashed };
	});
	// 组的标题往上挪了 12：整张图跟着往下让出来
	const top = Math.min(0, ...boxes.map((c) => c.y - 4));
	const shift = <T extends { y: number }>(o: T) => ({ ...o, y: o.y - top });
	return {
		w: Math.ceil(info.width ?? 0),
		h: Math.ceil((info.height ?? 0) - top),
		nodes: placed.map(shift),
		groups: boxes.map(shift),
		edges: edges.map((e) => ({ ...e, points: e.points.map(shift), at: e.at && shift(e.at) })),
		legend,
		missing,
	};
}

/** 排成一行（或一列）：一样宽、一样高，间距 8 */
function row(list: Spec<"Graph">["nodes"], lr: boolean, kinds: Map<string, { label: string; tone: number }>): Laid {
	const sizes = list.map(sizeOf);
	const [W, H, gap, m] = [Math.max(...sizes.map((s) => s.w)), Math.max(...sizes.map((s) => s.h)), 8, 8];
	const nodes = list.map((n, i): Placed => ({ ...n, w: W, h: H, x: m + W / 2 + (lr ? i * (W + gap) : 0), y: m + H / 2 + (lr ? 0 : i * (H + gap)), tone: n.kind ? kinds.get(n.kind)?.tone : undefined }));
	const used = new Set(nodes.map((n) => n.tone));
	const span = (size: number) => m * 2 + list.length * size + (list.length - 1) * gap;
	return { w: lr ? span(W) : m * 2 + W, h: lr ? m * 2 + H : span(H), nodes, groups: [], edges: [], legend: [...kinds.values()].filter((k) => used.has(k.tone)), missing: [] };
}

/** 一个组往外的所有组（防止 parent 绕成圈） */
function ancestors(groups: Map<string, { parent?: string }>, cid: string) {
	const out = new Set<string>();
	for (let p = groups.get(cid)?.parent; p && groups.has(p) && !out.has(p); p = groups.get(p)?.parent) out.add(p);
	return out;
}

/** 树自己排，不交给 dagre：dagre 为了少交叉会调换兄弟的先后，而树的子节点有顺序（1 + 2×3 的左右不能换） */
export function TreeView({ spec }: { spec: Spec<"Tree"> }) {
	const g = useMemo(() => tidy(spec.root as TreeItem), [spec.root]);
	return <Drawing g={g} />;
}

function tidy(root: TreeItem): Laid {
	const GAP = 16;
	const sized = new Map<TreeItem, { w: number; h: number; span: number }>();
	const measureAll = (t: TreeItem): number => {
		const s = sizeOf(t);
		const kids = (t.children ?? []).map(measureAll);
		const span = Math.max(s.w, kids.reduce((a, b) => a + b, 0) + GAP * Math.max(0, kids.length - 1));
		sized.set(t, { ...s, span });
		return span;
	};
	measureAll(root);
	const row = Math.max(...[...sized.values()].map((s) => s.h)) + 40;
	const nodes: Placed[] = [];
	const edges: Laid["edges"] = [];
	// 子树占 [left, left + span)：孩子们居中排在里面，自己在第一个和最后一个孩子的正中
	const put = (t: TreeItem, left: number, depth: number, id: string): Placed => {
		const s = sized.get(t) as { w: number; h: number; span: number };
		const kids = t.children ?? [];
		const width = kids.reduce((a, c) => a + (sized.get(c)?.span ?? 0), 0) + GAP * Math.max(0, kids.length - 1);
		let at = left + (s.span - width) / 2;
		const placed = kids.map((c, i) => {
			const p = put(c, at, depth + 1, `${id}.${i}`);
			at += (sized.get(c)?.span ?? 0) + GAP;
			return p;
		});
		const x = placed.length ? (placed[0].x + placed[placed.length - 1].x) / 2 : left + s.span / 2;
		const me: Placed = { id, label: t.label, note: t.note, x, y: 8 + depth * row + s.h / 2, w: s.w, h: s.h };
		nodes.push(me);
		for (const c of placed) {
			const [y0, y1] = [me.y + me.h / 2, c.y - c.h / 2];
			edges.push({ points: [{ x: me.x, y: y0 }, { x: me.x, y: (y0 + y1) / 2 }, { x: c.x, y: (y0 + y1) / 2 }, { x: c.x, y: y1 - 1 }], lw: 0, at: null });
		}
		return me;
	};
	put(root, 8, 0, "0");
	return { w: Math.ceil((sized.get(root)?.span ?? 0) + 16), h: Math.ceil(Math.max(...nodes.map((n) => n.y + n.h / 2)) + 8), nodes, groups: [], edges, legend: [], missing: [] };
}

/** 时序图：参与者一列一个，消息按先后一行一条；自己发给自己的画成一个回环 */
export function SequenceView({ spec }: { spec: Spec<"Sequence"> }) {
	const id = useSvgId();
	const s = useMemo(() => {
		const names = [...spec.actors];
		// 消息里提到、actors 里没写的，补在后面
		for (const m of spec.messages) for (const a of [m.from, m.to]) if (!names.includes(a)) names.push(a);
		const head = Math.max(...names.map((a) => measure(a, LABEL, 500) + 24), 72);
		const label = Math.max(0, ...spec.messages.map((m) => measure(m.label, LABEL) / Math.max(1, Math.abs(names.indexOf(m.to) - names.indexOf(m.from)))));
		const gap = Math.min(Math.max(label + 40, head + 24, 120), 320);
		const x = (a: string) => head / 2 + 8 + names.indexOf(a) * gap;
		let y = 30 + 16 + 24;
		const rows = spec.messages.map((m) => {
			const self = m.from === m.to;
			const row = { ...m, y, x1: x(m.from), x2: x(m.to), self };
			y += (self ? 52 : 40) + (m.note ? 14 : 0);
			return row;
		});
		const noteW = Math.max(0, ...rows.filter((r) => r.self).map((r) => measure(r.label, LABEL) + 40));
		return { names, x, head, rows, w: Math.ceil(head + 16 + (names.length - 1) * gap + noteW), h: y };
	}, [spec]);
	return (
		<figure className="min-w-0 rounded-lg border bg-card p-3">
			<Canvas w={s.w} h={s.h}>
				<defs><Arrow id={id} /></defs>
				{s.names.map((a) => (
					<g key={a}>
						<line x1={s.x(a)} x2={s.x(a)} y1={30} y2={s.h - 4} strokeDasharray="3 3" className="stroke-border" />
						<rect x={s.x(a) - s.head / 2} y={0} width={s.head} height={30} rx={6} className="fill-card stroke-border" />
						<text x={s.x(a)} y={19.5} fontSize={LABEL} fontWeight={500} textAnchor="middle" className="fill-foreground">{a}</text>
					</g>
				))}
				{s.rows.map((r, i) => {
					const dash = r.reply ? "4 3" : undefined;
					const mid = r.self ? r.x1 + 34 : (r.x1 + r.x2) / 2;
					return (
						<g key={i}>
							{r.self ? (
								<path d={`M${r.x1},${r.y}h28v18h-26`} fill="none" strokeWidth={1.25} strokeDasharray={dash} markerEnd={`url(#${id})`} className="stroke-muted-foreground" />
							) : (
								<line x1={r.x1} x2={r.x2 + (r.x2 > r.x1 ? -1 : 1)} y1={r.y} y2={r.y} strokeWidth={1.25} strokeDasharray={dash} markerEnd={`url(#${id})`} className="stroke-muted-foreground" />
							)}
							<text x={mid} y={r.self ? r.y + 13 : r.y - 6} fontSize={LABEL} textAnchor={r.self ? "start" : "middle"} className="fill-foreground">{r.label}</text>
							{r.note && <text x={mid} y={r.y + (r.self ? 32 : 15)} fontSize={NOTE} textAnchor={r.self ? "start" : "middle"} className="fill-muted-foreground">{r.note}</text>}
						</g>
					);
				})}
			</Canvas>
		</figure>
	);
}
