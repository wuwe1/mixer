// 工作区（侧栏）：放进来的文件夹（人拖的顺序）和会话，带上侧栏要的会话信息（标题、时间、状态）。
// 第一次打开时还没有工作区：把有状态的会话（运行中、待确认、跑完没看）放进去，其余的从「浏览会话」里找。
// 在 mixer 里跑过的会话（新会话、分叉、续接）自动放进来（runs.ts）
import * as runs from "./runs.ts";
import { listSessions, projectOf } from "./sessions.ts";
import * as state from "./state.ts";
import * as usage from "./usage.ts";

export async function view() {
	let w = state.workspace();
	if (!w) {
		const busy = [...runs.list().flatMap((r) => (r.status === "running" && r.session ? [{ id: r.session, project: r.project }] : [])), ...state.unreadSessions()];
		w = { groups: [], sessions: {} };
		for (const s of busy) {
			if (!w.groups.some((g) => g.id === s.project)) w.groups.push({ id: s.project, path: null });
			w.sessions[s.id] ??= s.project;
		}
		state.setWorkspace(w);
	}
	// 不知道路径的文件夹（建工作区时、从会话记录里来的）：从会话记录里找，找到了才记下
	let found = false;
	for (const g of w.groups) {
		if (g.path) continue;
		g.path = projectOf(g.id)?.path ?? null;
		found ||= !!g.path;
	}
	if (found) state.setWorkspace(w);
	const sessions = w.sessions;
	return Promise.all(w.groups.map(async (g) => ({ ...g, sessions: (await listSessions(g.id)).filter((s) => sessions[s.id] === g.id) })));
}

/** SSE 连上先发的 hello（sse.ts）：工作区先算（要读会话），运行、确认请求、排队、用量在它之后同步拿，是发出去那一刻的 */
export const hello = async () => ({ workspace: await view().catch(() => null), ...runs.snapshot(), usage: usage.list() });
