// 工作区（侧栏）：放进来的文件夹（人拖的顺序）和会话，带上侧栏要的会话信息（标题、时间、状态）。
// 一开始是空的，从「浏览会话」里挑；在 mixer 里跑过的会话（新会话、分叉、续接）自动放进来（runs.ts）
import * as runs from "./runs.ts";
import { listSessions, projectOf } from "./sessions.ts";
import * as state from "./state.ts";
import * as usage from "./usage.ts";

export async function view() {
	const w = state.workspace() ?? { groups: [], sessions: {} };
	// 不知道路径的文件夹（老版本建的）：从会话记录里找，找到了才记下
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
