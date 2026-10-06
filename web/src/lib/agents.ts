// 子代理：会话里 Agent / Task 工具调用开出来的那几个，现在在做什么、还在不在跑。
// 打开会话（有 Agent 调用的）时拿一次列表（/agents），之后跟着 agent 事件更新；重连了再拿一次。
// 按 toolUseId 对上开它的那个工具调用：一行画在工具调用下面，点了打开它的对话（开着时跟着它的记录增量更新）。
import { useCallback, useEffect, useRef, useState } from "react";
import { api, enc, type Node, type Sub, type ToolNode } from "./api";
import { useEvent } from "./events";

export const spawner = (n: Node): n is ToolNode => n.k === "tool" && (n.name === "Agent" || n.name === "Task");

/** 90 秒内写过记录：主会话那边没动静（终端里开着、后台的子代理），也算还活着 */
const FRESH = 90_000;
const NONE = new Map<string, Sub>();

/** 放进去：同一个的留 mtime 新的 */
const put = (m: Map<string, Sub>, a: Sub) => {
	const old = a.toolUseId ? m.get(a.toolUseId) : undefined;
	if (a.toolUseId && (!old || old.mtime <= a.mtime)) m.set(a.toolUseId, a);
};

/** 这个会话的子代理，按 toolUseId（老版本的 meta 里没有 toolUseId 的不算）。on：会话里有 Agent 调用才去拿 */
export function useSubs(project: string, session: string, on: boolean): Map<string, Sub> {
	const [subs, setSubs] = useState(NONE);
	const key = `${project}/${session}`;
	const at = useRef(key);
	at.current = key;
	const load = useCallback(() => {
		if (!on) return;
		api<Sub[]>(`/api/sessions/${enc(project)}/${enc(session)}/agents`).then((list) => {
			if (at.current !== `${project}/${session}`) return;
			// 拿列表的时候来过的事件可能比列表新：按 mtime 留新的
			setSubs((cur) => {
				const m = new Map(cur);
				for (const a of list) put(m, a);
				return m;
			});
		}, () => {});
	}, [project, session, on]);
	useEffect(() => {
		setSubs(NONE);
		load();
	}, [load]);
	useEvent("reconnect", load);
	useEvent("agent", useCallback((e: Sub & { project: string; session: string }) => {
		if (!on || e.project !== project || e.session !== session) return;
		const { project: _p, session: _s, ...a } = e;
		setSubs((cur) => {
			const m = new Map(cur);
			put(m, a);
			return m;
		});
	}, [project, session, on]));
	// 只靠「刚写过」算在跑的，过了 90 秒要重新算：还有刚写过的就隔一会儿换个新的 Map
	useEffect(() => {
		const latest = Math.max(0, ...[...subs.values()].map((a) => a.mtime));
		const left = latest + FRESH - Date.now();
		if (left <= 0) return;
		const t = setTimeout(() => setSubs((cur) => new Map(cur)), left + 1000);
		return () => clearTimeout(t);
	}, [subs]);
	return subs;
}

/** 画在 Agent 工具调用上的：agentId（有才能点开看）、在做什么、还在不在跑、从什么时候开始 */
export type Spawn = { agentId: string | null; latest: string | null; running: boolean; since: number };

/**
 * 路上每个 Agent 工具调用开出来的子代理怎么样了。busy：会话在跑（mixer 里、待确认、终端里开着）。
 *   前台的（工具还没结果）：会话在跑、而且是这一轮的，就是在跑
 *   后台的（结果是「Async agent launched」，马上就回来了）：会话在跑或者它 90 秒内写过，而且最后写的时间晚于它的结束通知（后台任务通知、子代理回报），就是在跑。
 *   结束了又被 SendMessage 叫起来接着干的，也是这样算
 */
export function spawns(path: Node[], subs: Map<string, Sub>, busy: boolean): Map<string, Spawn> {
	const out = new Map<string, Spawn>();
	if (!path.some(spawner)) return out;
	const now = Date.now();
	const byAgent = new Map([...subs.values()].map((a) => [a.agentId, a]));
	const ends = new Map<string, number>();
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
			: /^Async agent launched/.test(t.result.text) && (busy || (!!a && now - a.mtime < FRESH)) && (a ? a.mtime > (end ?? 0) + 2000 : end === undefined);
		out.set(t.id, { agentId, latest: a?.latest ?? null, running, since: Date.parse(t.ts) });
	});
	return out;
}
