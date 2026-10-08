// 子代理：会话里 Agent / Task 工具调用开出来的那几个，现在在做什么、还在不在跑。
// 打开会话（有 Agent 调用的）时拿一次列表（/agents），之后跟着 agent 事件更新；连上了（hello）再拿一次。
// 按 toolUseId 对上开它的那个工具调用：一行画在工具调用下面，点了打开它的对话（开着时跟着它的记录增量更新）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, enc, type Node, type Sub } from "@shared/api";
import { useEvent } from "./events";
import { FRESH, type Job, spawns } from "./spawns";
import { nextOf, useDeadline } from "./use-deadline";

export { type Spawn, spawner } from "./spawns";

const NONE = new Map<string, Sub>();

/** 放进去：同一个的留 mtime 新的 */
const put = (m: Map<string, Sub>, a: Sub) => {
	const old = a.toolUseId ? m.get(a.toolUseId) : undefined;
	if (a.toolUseId && (!old || old.mtime <= a.mtime)) m.set(a.toolUseId, a);
};

/** 这个会话的子代理，按 toolUseId（老版本的 meta 里没有 toolUseId 的不算）。on：会话里有 Agent 调用才去拿。会话页按会话换着挂，project、session 不会变 */
export function useSubs(project: string, session: string, on: boolean): Map<string, Sub> {
	const [subs, setSubs] = useState(NONE);
	const load = useCallback(() => {
		if (!on) return;
		api<Sub[]>(`/api/sessions/${enc(project)}/${enc(session)}/agents`).then((list) => {
			// 拿列表的时候来过的事件可能比列表新：按 mtime 留新的
			setSubs((cur) => {
				const m = new Map(cur);
				for (const a of list) put(m, a);
				return m;
			});
		}, () => {});
	}, [project, session, on]);
	useEffect(() => load(), [load]);
	useEvent("hello", load);
	useEvent("agent", useCallback((e: Sub & { project: string; session: string }) => {
		if (!on || e.project !== project || e.session !== session) return;
		const { project: _p, session: _s, ...a } = e;
		setSubs((cur) => {
			const m = new Map(cur);
			put(m, a);
			return m;
		});
	}, [project, session, on]));
	return subs;
}

/**
 * 用 spawns.ts 算，path 是 null（还没拿到会话）就不算。active：会话有事在发生（lib/live.tsx 的 SessionLive）；
 * jobs：这个会话在 mixer 里开着的 claude 进程报的后台任务，没有进程是 null（没变时 live.tsx 留着原来的数组，Steps 的 memo 不破）。
 * 没有进程时只靠「90 秒内写过」算在跑的，过了时候要变：到点了重算
 */
export function useSpawns(path: Node[] | null, subs: Map<string, Sub>, active: boolean, jobs: Job[] | null) {
	const tick = useDeadline(jobs ? null : nextOf([...subs.values()].map((a) => a.mtime + FRESH)));
	// tick：到点了，重算
	return useMemo(() => (path ? spawns(path, subs, active, jobs) : null), [path, subs, active, jobs, tick]);
}
