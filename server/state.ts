// mixer 自己记的状态（data/state.json，不进 git）：每个会话在 mixer 里最后一次跑完的时间、人最后一次打开它的时间。
// 跑完的时间晚于打开的时间，就是「跑完了，还没看」。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE = join(dirname(new URL(import.meta.url).pathname), "..", "data", "state.json");

type State = { finished: Record<string, { project: string; at: string; error: boolean }>; seen: Record<string, string>; windows: Record<string, number>; models: Record<string, string>; caps: Record<string, Caps> };
let state: State = { finished: {}, seen: {}, windows: {}, models: {}, caps: {} };
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

/** 各模型的上下文窗口多大：会话记录里只有模型名，mixer 里每跑完一次从结果里记下来 */
export function learnWindow(model: string, size: number) {
	if (state.windows[model] === size) return;
	state.windows[model] = size;
	save();
}
export const windows = () => state.windows;

/** 在 mixer 里给会话选过的模型（别名）：之后续接都用它，直到再换 */
export function chooseModel(session: string, model: string) {
	if (state.models[session] === model) return;
	state.models[session] = model;
	save();
}
export const chosenModel = (session: string) => state.models[session] ?? null;

/** 每个项目能用的 skill 名字和装着的插件：每次运行开头的 init 事件里有，记下来给输入框的 skill 列表用 */
type Caps = { skills: string[]; plugins: { name: string; path: string }[]; at: string };
export function learnCaps(project: string, caps: Omit<Caps, "at">) {
	state.caps[project] = { ...caps, at: new Date().toISOString() };
	save();
}
/** 这个项目还没在 mixer 里跑过：用最近跑过的那个项目的（内置的、装的插件大家都一样） */
const capsOf = (project: string): Caps | undefined => state.caps[project] ?? Object.values(state.caps).sort((a, b) => b.at.localeCompare(a.at))[0];
export const skills = (project: string) => capsOf(project)?.skills ?? [];
export const plugins = (project: string) => (capsOf(project)?.plugins ?? []).filter((p) => p.path !== "builtin");
