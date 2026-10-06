// 图：节点和箭头（Graph，dagre 自动排）、树（换成从上到下的 Graph）、时序图（Sequence，自己排：一列一个参与者、一行一条消息）。
// Claude 只给关系，不给坐标；字宽用 canvas 量，节点按字的大小定。颜色只用 token：线、框是 border / muted-foreground，要盯住的用 foreground 加粗。
import { Graph as Dagre, layout } from "@dagrejs/dagre";
import { useId, useMemo } from "react";
import type { Spec, TreeItem } from "@/lib/visual";
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

type Placed = Spec<"Graph">["nodes"][number] & { x: number; y: number; w: number; h: number };
/** 排好的图：Graph（dagre）、Tree（自己排）都出这个，同一个画法 */
type Laid = {
	w: number;
	h: number;
	nodes: Placed[];
	groups: { id: string; label: string; x: number; y: number; w: number; h: number }[];
	edges: { points: { x: number; y: number }[]; label?: string; lw: number; at: { x: number; y: number } | null; dashed?: boolean }[];
	missing: string[];
};

function Drawing({ g }: { g: Laid }) {
	const done = useDone();
	const id = useSvgId();
	return (
		<figure className="min-w-0 rounded-lg border bg-card p-3">
			<Canvas w={g.w} h={g.h}>
				<defs><Arrow id={id} /></defs>
				{g.groups.map((c) => (
					<g key={c.id}>
						<rect x={c.x} y={c.y} width={c.w} height={c.h} rx={8} className="fill-muted/40 stroke-border" strokeDasharray="4 3" />
						<text x={c.x + 8} y={c.y + 14} fontSize={NOTE} className="fill-muted-foreground">{c.label}</text>
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
				{g.nodes.map((n) => <Box key={n.id} n={n} />)}
			</Canvas>
			{done && !!g.missing.length && <figcaption className="mt-2 text-2xs text-muted-foreground">没画的箭头：{g.missing.join("；")}</figcaption>}
		</figure>
	);
}

/** 节点按字的大小定宽高 */
function sizeOf(n: { label: string; note?: string; emphasis?: boolean; shape?: string }) {
	const tw = Math.max(measure(n.label, LABEL, n.emphasis ? 600 : 500), n.note ? measure(n.note, NOTE) : 0);
	const [w, h] = [Math.max(tw + 24, 56), n.note ? 46 : 32];
	return n.shape === "diamond" ? { w: w * 1.5, h: h * 1.5 } : { w, h };
}

function Box({ n }: { n: Placed }) {
	const cls = n.emphasis ? "fill-card stroke-foreground" : "fill-card stroke-border";
	const sw = n.emphasis ? 1.5 : 1;
	const [l, t] = [n.x - n.w / 2, n.y - n.h / 2];
	const ly = n.note ? n.y - 2 : n.y + 4.5;
	return (
		<g>
			{n.shape === "diamond" ? (
				<polygon points={`${n.x},${t} ${l + n.w},${n.y} ${n.x},${t + n.h} ${l},${n.y}`} className={cls} strokeWidth={sw} />
			) : (
				<rect x={l} y={t} width={n.w} height={n.h} rx={n.shape === "round" ? n.h / 2 : 6} className={cls} strokeWidth={sw} />
			)}
			<text x={n.x} y={ly} fontSize={LABEL} fontWeight={n.emphasis ? 600 : 500} textAnchor="middle" className="fill-foreground">{n.label}</text>
			{n.note && <text x={n.x} y={ly + 15} fontSize={NOTE} textAnchor="middle" className="fill-muted-foreground">{n.note}</text>}
		</g>
	);
}

/** dagre 排位置。指向不存在的节点的箭头不画，写完了在图下面列出来 */
function place(spec: Spec<"Graph">): Laid {
	const g = new Dagre({ compound: true, multigraph: true });
	const lr = spec.direction !== "TB";
	g.setGraph({ rankdir: lr ? "LR" : "TB", nodesep: 24, ranksep: lr ? 56 : 44, edgesep: 12, marginx: 8, marginy: 8 });
	g.setDefaultEdgeLabel(() => ({}));
	const groups = new Map((spec.groups ?? []).map((c) => [c.id, c.label]));
	const nodes = new Map<string, Spec<"Graph">["nodes"][number]>();
	for (const n of spec.nodes) {
		if (nodes.has(n.id)) continue;
		nodes.set(n.id, n);
		const { w, h } = sizeOf(n);
		g.setNode(n.id, { width: w, height: h });
	}
	for (const [cid] of groups) g.setNode(`group:${cid}`, { paddingTop: 20 });
	for (const n of nodes.values()) if (n.group && groups.has(n.group)) g.setParent(n.id, `group:${n.group}`);
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
		return { ...n, x: p.x, y: p.y, w: p.width, h: p.height };
	});
	const boxes = [...groups].map(([cid, label]) => {
		const p = g.node(`group:${cid}`);
		// 空的组 dagre 不给位置
		return p && Number.isFinite(p.x) ? { id: cid, label, x: p.x - p.width / 2, y: p.y - p.height / 2 - 12, w: p.width, h: p.height + 12 } : null;
	}).filter((c) => c !== null);
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
		missing,
	};
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
	return { w: Math.ceil((sized.get(root)?.span ?? 0) + 16), h: Math.ceil(Math.max(...nodes.map((n) => n.y + n.h / 2)) + 8), nodes, groups: [], edges, missing: [] };
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
