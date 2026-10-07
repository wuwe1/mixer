// 工具组收着时露出什么：纯函数，不碰 React（message.tsx 的 Steps 照着画）。
// 在跑的那一步露出来（蓝点、耗时）；还在跑的子代理每个都露出来（最多 3 个，再多「还有 N 个」）；不然是最后一步（成功绿点、失败红点）。
// 跑完了、没有在跑的子代理：最后那一步直接当标题（后面「N 次」），展开了标题换回「N 次工具调用」。
// 只有思考的一组正在想：标题上直接带 ping 点、最新一句和耗时
import type { Node, ToolNode } from "@shared/api.ts";
import type { Spawn } from "./spawns.ts";

/** 一组里正在进行的那一步（执行中的工具、正在写的思考）和它开始的时间 */
export type Now = { node: Node; since: number };

/** 一行：标记、名字、摘要（mono：工具的等宽小字）、在跑的带耗时；agent：点了看这个子代理的对话 */
export type Line = { mark: "running" | "ok" | "failed"; name: string; summary: string; mono: boolean; since?: number; agent: string | null };

/**
 * 标题下面露出来的：sub 是还在跑的子代理（下面一行灰字 latest 是它在做什么），last 是最后一步（在跑的那一步）；
 * more：子代理多于 3 个，「还有 N 个」
 */
export type Row = (Line & { k: "sub"; key: string; latest: string | null }) | (Line & { k: "last"; key: string }) | { k: "more"; key: string; n: number };

export type Exposed = {
	/** label：「N 次工具调用 名字…」；thinking：只有思考的一组正在想；step：最后那一步当标题（展开了换回 label） */
	head: { k: "label" } | { k: "thinking"; text: string; since: number } | { k: "step"; line: Line };
	/** 工具调用几次、用了哪些工具（去重，按先后） */
	count: number;
	names: string[];
	/** 标题上的出错数，0 不显示（一步的组出错了，红点已经说了） */
	errors: number;
	rows: Row[];
};

export const toolName = (name: string) => name.replace(/^mcp__[^_]+__/, "");

/** 思考写到哪了：最后一句（摘要是一段一段来的）。只用在正在写的上（流里的，是全文） */
export const latest = (n: Node) => (n.k === "thinking" ? (n.text.trim().split("\n").filter((l) => l.trim()).pop() ?? "") : "");

/** spawns：组里有 Agent 调用时才给 */
export function exposed(nodes: Node[], now?: Now | null, spawns?: Map<string, Spawn>): Exposed {
	const tools = nodes.filter((n): n is ToolNode => n.k === "tool");
	const failed = tools.filter((t) => t.result?.error).length;
	const names = [...new Set(tools.map((t) => toolName(t.name)))];
	const base = { count: tools.length, names };
	if (!tools.length && now?.node.k === "thinking") return { ...base, head: { k: "thinking", text: latest(now.node), since: now.since }, errors: 0, rows: [] };
	const running = now ?? null;
	const lastTool = tools[tools.length - 1];
	const shown = running?.node ?? (lastTool?.result ? lastTool : null);
	const subs = spawns ? tools.filter((t) => spawns.get(t.id)?.running) : [];
	const agent = shown?.k === "tool" && spawns ? (shown.agent ?? spawns.get(shown.id)?.agentId ?? null) : null;
	const mark = (n: Node) => (n.k === "tool" && n.result?.error ? "failed" : "ok");
	// 跑完了、没有在跑的子代理：只一行，就是最后那一步
	if (!running && !subs.length && shown?.k === "tool") {
		const line: Line = { mark: mark(shown), name: toolName(shown.name), summary: shown.summary, mono: true, agent };
		return { ...base, head: { k: "step", line }, errors: failed > (shown.result?.error && tools.length === 1 ? 1 : 0) ? failed : 0, rows: [] };
	}
	const rows: Row[] = subs.slice(0, 3).map((t) => {
		const s = spawns?.get(t.id) as Spawn;
		return { k: "sub", key: t.id, mark: "running", name: toolName(t.name), summary: t.summary, mono: true, since: s.since, agent: s.agentId, latest: s.latest };
	});
	if (subs.length > 3) rows.push({ k: "more", key: "more", n: subs.length - 3 });
	// 露出来的最后一步要是在跑的子代理之一，上面已经有了
	if (shown && !(shown.k === "tool" && subs.includes(shown)))
		rows.push({
			k: "last",
			key: "last",
			mark: running ? "running" : mark(shown),
			name: shown.k === "tool" ? toolName(shown.name) : "思考",
			summary: shown.k === "tool" ? shown.summary : latest(shown),
			mono: shown.k === "tool",
			...(running && { since: running.since }),
			agent,
		});
	return { ...base, head: { k: "label" }, errors: failed, rows };
}
