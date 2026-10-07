// 子代理还在不在跑：纯函数，不碰 React（agents.ts 的 useSpawns 用它，测试也用）
import type { Node, Sub, ToolNode } from "@shared/api.ts";

/** 开子代理的工具调用：Agent（老版本叫 Task），还有以 forked 在后台跑的 Skill（结果里有 async） */
export const spawner = (n: Node): n is ToolNode => n.k === "tool" && (n.name === "Agent" || n.name === "Task" || !!n.async);

/** 90 秒内写过记录：主会话那边没动静（终端里开着、后台的子代理），也算还活着 */
export const FRESH = 90_000;

/** 画在 Agent 工具调用上的：agentId（有才能点开看）、在做什么、还在不在跑、从什么时候开始 */
export type Spawn = { agentId: string | null; latest: string | null; running: boolean; since: number };

/** mixer 开着的 claude 进程报的后台任务（只要这两样）：id 是任务 id（后台子代理的就是 agentId），tool 是开它的工具调用 */
export type Job = { id: string; tool: string | null };

/**
 * 路上每个 Agent 工具调用开出来的子代理怎么样了。busy：会话在跑（mixer 里、待确认、后台任务、终端里开着）。
 *   前台的（工具还没结果）：会话在跑、而且是这一轮的，就是在跑
 *   后台的（结果马上就回来了，服务端照结构化的结果标了 async）：
 *     jobs 不是 null（这个会话在 mixer 里开着 claude 进程）：进程报的后台任务里有它（tool 是这个调用，或者任务 id 是它的 agentId），就是在跑。准的，不猜
 *     jobs 是 null（终端里开的、进程退了）：会话在跑或者它 90 秒内写过，而且最后写的时间晚于它的结束通知（后台任务通知、子代理回报），就是在跑。
 *     结束了又被 SendMessage 叫起来接着干的，也是这样算
 */
export function spawns(path: Node[], subs: Map<string, Sub>, busy: boolean, jobs: Job[] | null, now = Date.now()): Map<string, Spawn> {
	const out = new Map<string, Spawn>();
	if (!path.some(spawner)) return out;
	const byAgent = new Map([...subs.values()].map((a) => [a.agentId, a]));
	const ends = new Map<string, number>();
	const tools = new Set(jobs?.map((j) => j.tool));
	const ids = new Set(jobs?.map((j) => j.id));
	let turn = 0;
	path.forEach((n, i) => {
		if (n.k === "event" && (n.kind === "task" || n.kind === "agent") && n.agent) ends.set(n.agent, Math.max(ends.get(n.agent) ?? 0, Date.parse(n.ts)));
		if (n.k === "user" && !n.queued) turn = i;
	});
	path.forEach((t, i) => {
		if (!spawner(t)) return;
		const a = subs.get(t.id) ?? (t.agent ? byAgent.get(t.agent) : undefined);
		const agentId = a?.agentId ?? t.agent;
		const end = agentId ? ends.get(agentId) : undefined;
		const running = !t.result
			? busy && i > turn
			: !t.async
				? false
				: jobs
					? tools.has(t.id) || (!!agentId && ids.has(agentId))
					: (busy || (!!a && now - a.mtime < FRESH)) && (a ? a.mtime > (end ?? 0) + 2000 : end === undefined);
		out.set(t.id, { agentId, latest: a?.latest ?? null, running, since: Date.parse(t.ts) });
	});
	return out;
}
