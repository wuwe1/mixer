// mixer 自己记的状态（data/state.json，不进 git）：每个会话在 mixer 里最后一次跑完的时间、人最后一次打开它的时间。
// 跑完的时间晚于打开的时间，就是「跑完了，还没看」。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE = join(dirname(new URL(import.meta.url).pathname), "..", "data", "state.json");

type State = { finished: Record<string, { project: string; at: string; error: boolean }>; seen: Record<string, string> };
let state: State = { finished: {}, seen: {} };
try { state = { ...state, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch {}

function save() {
	mkdirSync(dirname(FILE), { recursive: true });
	writeFileSync(`${FILE}.tmp`, JSON.stringify(state));
	renameSync(`${FILE}.tmp`, FILE);
}

export function finished(project: string, session: string, error: boolean) {
	state.finished[session] = { project, at: new Date().toISOString(), error };
	save();
}

export function seen(session: string) {
	state.seen[session] = new Date().toISOString();
	save();
}

/** 跑完了还没看：done / error；看过了或没在 mixer 里跑过：null */
export function unread(session: string): "done" | "error" | null {
	const f = state.finished[session];
	if (!f) return null;
	const s = state.seen[session];
	if (s && s >= f.at) return null;
	return f.error ? "error" : "done";
}

/** 会话最近那次写入是不是 mixer 自己的运行（跑完的时间不早于文件修改时间几秒）：是的话就不算「终端里开着」，重启之后也认得 */
export const ourLastWrite = (session: string, mtimeMs: number) => {
	const f = state.finished[session];
	return !!f && Date.parse(f.at) >= mtimeMs - 5000;
};
