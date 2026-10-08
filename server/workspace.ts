// 工作区（侧栏）：放进来的文件夹（人拖的顺序）和会话，带上侧栏要的会话信息（标题、时间、状态）。
// 一开始是空的，从「浏览会话」里挑；在 mixer 里跑过的会话（新会话、分叉、续接）自动放进来（runs.ts）
import * as runs from "./runs.ts";
import { listSessions, projectOf } from "./sessions.ts";
import * as sse from "./sse.ts";
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

/**
 * 工作区变了（放进来、移出去、拖了顺序、删了会话、mixer 里开了新会话）：算好整个工作区推 workspace，页面拿它整个换掉，不用再拉。
 * 算要等（读会话）：同时只算一份，算的时候又变了就算完再算一遍，推出去的先后和变的先后一样，旧的不会盖掉新的
 */
let pushing = false;
let again = false;
export async function push() {
	if (pushing) return void (again = true);
	pushing = true;
	try {
		do {
			again = false;
			const v = await view().catch(() => null);
			if (v) sse.emit("workspace", v);
		} while (again);
	} finally {
		pushing = false;
	}
}

/** SSE 连上先发的 hello（sse.ts）：工作区先算（要读会话），运行、确认请求、排队、用量在它之后同步拿，是发出去那一刻的 */
export const hello = async () => ({ workspace: await view().catch(() => null), ...runs.snapshot(), usage: usage.list() });
