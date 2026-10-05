// mixer 自己记的状态（data/state.json，不进 git）：每个会话在 mixer 里最后一次跑完的时间、人最后一次打开它的时间。
// 跑完的时间晚于打开的时间，就是「跑完了，还没看」。还有工作区：侧栏里放了哪些文件夹（按人拖的顺序）、哪些会话。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE = join(dirname(new URL(import.meta.url).pathname), "..", "data", "state.json");

type State = { finished: Record<string, { project: string; at: string; error: boolean }>; seen: Record<string, string>; windows: Record<string, number>; models: Record<string, string>; caps: Record<string, Caps>; limits: Limits | null; workspace: Workspace | null };
let state: State = { finished: {}, seen: {}, windows: {}, models: {}, caps: {}, limits: null, workspace: null };
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

/** 订阅的用量：5 小时、7 天两个窗口用了多少（0–1）、什么时候重置（秒）。每次运行的 rate_limit_event 里有，记下最新的；终端里用掉的要等下次 mixer 运行才知道 */
type Window = { utilization: number; resetsAt: number };
export type Limits = { five_hour: Window | null; seven_day: Window | null; at: string };
const win = (w: unknown): Window | null => {
	const x = w as Partial<Window> | undefined;
	return typeof x?.utilization === "number" && typeof x.resetsAt === "number" ? { utilization: x.utilization, resetsAt: x.resetsAt } : null;
};
export function learnLimits(windows: Record<string, unknown>) {
	state.limits = { five_hour: win(windows.five_hour), seven_day: win(windows.seven_day), at: new Date().toISOString() };
	save();
}
export const limits = () => state.limits;

/**
 * 工作区：groups 是文件夹，顺序就是侧栏里的顺序（人拖的，新加的放最上面）；sessions 是放进来的会话 → 它的文件夹。
 * 组里的会话不记顺序，侧栏按时间排。null 是还没建过（第一次打开时从「有状态的会话」建一个）
 */
export type Workspace = { groups: { id: string; path: string | null }[]; sessions: Record<string, string> };
export const workspace = () => state.workspace;
export function setWorkspace(w: Workspace) {
	state.workspace = w;
	save();
}
/** 放进工作区（session 不给就只放文件夹）；本来就在返回 false */
export function addToWorkspace(project: string, path: string | null, session?: string | null) {
	const w = state.workspace ?? { groups: [], sessions: {} };
	let changed = !state.workspace;
	const g = w.groups.find((x) => x.id === project);
	if (!g) { w.groups.unshift({ id: project, path }); changed = true; }
	else if (!g.path && path) { g.path = path; changed = true; }
	if (session && w.sessions[session] !== project) { w.sessions[session] = project; changed = true; }
	if (changed) setWorkspace(w);
	return changed;
}
/** 移出工作区：给了会话只移它；没给就连文件夹带里面的会话一起移掉。会话记录不动 */
export function removeFromWorkspace(project: string, session?: string | null) {
	const w = state.workspace;
	if (!w) return false;
	if (session) {
		if (!(session in w.sessions)) return false;
		delete w.sessions[session];
	} else {
		w.groups = w.groups.filter((g) => g.id !== project);
		for (const [s, p] of Object.entries(w.sessions)) if (p === project) delete w.sessions[s];
	}
	setWorkspace(w);
	return true;
}
/** 拖完的顺序：只认已有的文件夹，漏掉的接在后面 */
export function orderWorkspace(ids: string[]) {
	const w = state.workspace;
	if (!w) return false;
	const by = new Map(w.groups.map((g) => [g.id, g]));
	const next = [...new Set(ids)].flatMap((id) => by.get(id) ?? []);
	w.groups = [...next, ...w.groups.filter((g) => !next.includes(g))];
	setWorkspace(w);
	return true;
}
/** 在 mixer 里跑完过、还没看的会话（建工作区时放进去） */
export const unreadSessions = () => Object.entries(state.finished).filter(([id]) => unread(id)).sort((a, b) => b[1].at.localeCompare(a[1].at)).map(([id, f]) => ({ id, project: f.project }));
