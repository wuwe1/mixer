// 会话记录 → 对话：节点树、从根走到一片叶子的那条路、路上连着的工具调用收成一组、分叉点；
// 还有正在跑的那次运行里还没写进记录的那几段，变成和记录里一样的节点接在末尾。都是纯函数，不碰 React。
import type { Node } from "@shared/api";
import { summarize } from "@shared/tail";
import type { Stream } from "./use-stream";

/** ids：记录里有的消息的 uuid，连运行中插进来的那几条发的时候的 uuid（source）：网页发的那条到没到按它认 */
export type Tree = { kids: Map<string | null, Node[]>; best: Map<string, Node>; byId: Map<string, Node>; ids: Set<string> };
export type Walk = ReturnType<typeof walk>;
export type User = Extract<Node, { k: "user" }>;

/** 子节点表；每个节点往下最新的那片叶子 */
export function tree(nodes: Node[]): Tree {
	const kids = new Map<string | null, Node[]>();
	const byId = new Map(nodes.map((n) => [n.uuid, n]));
	for (const n of nodes) {
		const p = n.parent && byId.has(n.parent) ? n.parent : null;
		kids.set(p, [...(kids.get(p) ?? []), n]);
	}
	const best = new Map<string, Node>();
	// 节点是按文件顺序来的，子节点总在父节点后面：倒着走一遍就能算出每个节点的最新叶子
	for (let i = nodes.length - 1; i >= 0; i--) {
		const n = nodes[i];
		const cs = kids.get(n.uuid) ?? [];
		let b: Node = n;
		for (const c of cs) {
			const cb = best.get(c.uuid) ?? c;
			if (cb.ts > b.ts || b === n) b = cb;
		}
		best.set(n.uuid, b);
	}
	return { kids, best, byId, ids: idsOf(nodes) };
}

/** 记录里有的 uuid（连 source） */
export const idsOf = (nodes: Node[]) => new Set(nodes.flatMap((n) => (n.k === "user" && n.source ? [n.uuid, n.source] : [n.uuid])));


/**
 * 从根走到 leaf（地址里的）的那条路；路上每个改写过的地方的各个版本（to：切到第几版时地址里的 leaf，回到默认那条路上的是 null）。
 * latest 是默认走到的：home（服务端给的，命令行续接时接着的那条），没有就是整棵树最新的叶子
 */
export function walk(t: Tree, leaf: string | null, home: string | null = null) {
	const roots = t.kids.get(null) ?? [];
	const newest = roots.map((r) => t.best.get(r.uuid) ?? r).sort((a, b) => b.ts.localeCompare(a.ts))[0];
	const latest = (home ? t.byId.get(home) : undefined) ?? newest;
	const up = (from: Node | undefined) => {
		const out: Node[] = [];
		for (let n = from; n; n = n.parent ? t.byId.get(n.parent) : undefined) out.push(n);
		return out.reverse();
	};
	const end = (leaf ? t.byId.get(leaf) : undefined) ?? latest;
	const path = up(end);
	const main = end === latest ? new Set(path) : new Set(up(latest));
	const versions = new Map<string, { options: Node[]; index: number; to: (string | null)[] }>();
	for (const n of path) {
		const siblings = t.kids.get(n.parent && t.byId.has(n.parent) ? n.parent : null) ?? [];
		if (siblings.length > 1) versions.set(n.uuid, { options: siblings, index: siblings.indexOf(n), to: siblings.map((s) => (main.has(s) ? null : (t.best.get(s.uuid) ?? s).uuid)) });
	}
	return { path, versions, end, latest, atLatest: !end || end === latest };
}

/** 拉回来的是增量（delta）：改过的节点按 uuid 换掉，新的接在后面；没变的原样留着（消息组件按对象认，不用重画）。会话、子代理的对话都用它 */
export function merge<T extends { nodes: Node[]; delta: boolean }>(old: T | null, d: T): T {
	if (!d.delta || !old) return d;
	if (!d.nodes.length) return { ...d, nodes: old.nodes };
	const at = new Map(old.nodes.map((n, i) => [n.uuid, i]));
	const nodes = old.nodes.slice();
	for (const n of d.nodes) {
		const i = at.get(n.uuid);
		if (i === undefined) nodes.push(n);
		else nodes[i] = n;
	}
	return { ...d, nodes };
}

/** 记录里有的段：「消息 id : 第几段」 */
export const keysOf = (nodes: Node[]) => new Set(nodes.flatMap((n) => ("key" in n && n.key ? [n.key] : [])));

export type Block = { kind: "one"; n: Node } | { kind: "steps"; nodes: Node[] };
/**
 * 连着的工具调用、思考收成一组，别的一条一块。接在 base 后面（正在写的那几段接在记录后面）：base 不改，
 * 只换最后一块，前面的块原样留着（消息组件是 memo 的，每来一个字不用全部重画）
 */
export function blocks(nodes: Node[], base: Block[] = []): Block[] {
	if (!nodes.length) return base;
	const out = base.slice();
	/** 这次新建的那一组：直接往里加 */
	let open: Node[] | null = null;
	for (const n of nodes) {
		if (n.k !== "tool" && n.k !== "thinking") {
			out.push({ kind: "one", n });
			open = null;
		} else if (open) open.push(n);
		else {
			const last = out[out.length - 1];
			open = last?.kind === "steps" ? [...last.nodes, n] : [n];
			if (last?.kind === "steps") out[out.length - 1] = { kind: "steps", nodes: open };
			else out.push({ kind: "steps", nodes: open });
		}
	}
	return out;
}

export const headOf = (b: Block) => (b.kind === "one" ? b.n : b.nodes[0]);

/**
 * 分叉点要的是一条记录的 uuid，新会话只带到它为止的上下文。
 * 工具调用要用它结果那条记录：用调用本身，命令行带过去的上下文里就没有结果
 */
export const pointOf = (n: Node) => (n.k === "tool" ? (n.resultUuid ?? n.uuid) : n.uuid);
/** 路上 before 之前（不含）最后一条 Claude 的回复、思考或工具结果。没有（在第一条消息上分叉）就是 null */
export function forkPoint(path: Node[], before?: Node): string | null {
	const upto = before ? path.slice(0, path.indexOf(before)) : path;
	const last = [...upto].reverse().find((n) => n.k === "assistant" || n.k === "thinking" || n.k === "tool");
	return last ? pointOf(last) : null;
}

/** 工具参数还在写的时候的概览：能解析了就挑一个最能说明它在干什么的字段，还没写完就显示写了多少 */
function liveSummary(json: string) {
	try {
		return summarize(JSON.parse(json));
	} catch {
		return json.length > 2048 ? `正在写… ${Math.round(json.length / 1024)} KB` : "";
	}
}

/**
 * 流里还没写进记录的那几段，变成和记录里一样的节点，接在对话末尾。
 * 你发的那条也一样：记录里出现之前先按原文顶上（不然流比文件快，会先看到思考、后看到你的消息），uuid 就是记录里那条的，写进去之后 React 的 key 不变。
 * Codex 的 item id 开始跑了才知道，之前先用网页发的时候给的。ids：记录里有的（tree 的 ids）
 */
export function liveNodes(stream: Stream, ids: Set<string>, keys: Set<string>): Node[] {
	const ts = new Date().toISOString();
	const r = stream.of;
	const uuid = r && (r.uuid ?? r.merged[0]);
	const mine: Node[] = !r || !uuid || (!r.prompt.trim() && !r.images) || ids.has(uuid) ? [] : [{ k: "user", uuid, parent: null, ts: r.started, text: r.prompt, images: r.images, live: true }];
	const blocks = stream.blocks.filter((b) => !keys.has(b.key));
	return [
		...mine,
		...blocks.flatMap((b, i): Node[] => {
			const base = { uuid: `live:${b.key}`, parent: null, ts, key: b.key };
			if (b.k === "tool") return [{ k: "tool", ...base, id: b.id, name: b.name, summary: liveSummary(b.json), input: b.json, result: null, resultUuid: null, agent: null }];
			// 思考有时是不给看的（空的）：记录里不会有能显示的节点，后面有了别的段就不再显示
			if (b.k === "thinking") return !b.text.trim() && i < blocks.length - 1 ? [] : [{ k: "thinking", ...base, text: b.text }];
			return b.text.trim() ? [{ k: "assistant", ...base, text: b.text }] : [];
		}),
	];
}
/** 还没写进记录的（流里的那几段、你刚发的那条） */
export const isLive = (n: Node) => n.uuid.startsWith("live:") || (n.k === "user" && !!n.live);
