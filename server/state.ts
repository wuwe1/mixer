// mixer 自己记的状态（data/state.json，不进 git；MIXER_DATA 可改目录）：每个会话一份（sessions）：在 mixer 里最后一次跑完的时间、人最后一次打开它的时间、
// 选的模型和权限、从哪分叉的。跑完的时间晚于打开的时间，就是「跑完了，还没看」。还有工作区：侧栏里放了哪些文件夹（按人拖的顺序）、哪些会话。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Account } from "../shared/usage.ts";
import { DATA } from "./env.ts";

const FILE = join(DATA, "state.json");

/**
 * 一个会话 mixer 记的：finished 在 mixer 里最后一次跑完（出没出错）、seen 人最后一次打开它；
 * model / effort / permission 在 mixer 里给它选的（没有是默认、自动）；fork 在 mixer 里从哪分叉出来的。删会话时整份一起忘掉
 */
type Session = { finished?: { at: string; error: boolean }; seen?: string; model?: string; effort?: string; permission?: string; fork?: Fork };
type State = { sessions: Record<string, Session>; windows: Record<string, number>; caps: Record<string, Caps>; usage: Record<string, Account>; workspace: Workspace | null; modelList: ModelList | null; modelsSeen: Record<string, Record<string, string>> };
let state: State = { sessions: {}, windows: {}, caps: {}, usage: {}, workspace: null, modelList: null, modelsSeen: {} };
try {
	state = { ...state, ...migrate(JSON.parse(readFileSync(FILE, "utf8"))) };
	// Codex 的用量不要了
	delete state.usage.codex;
} catch {}

type Old = Record<string, any>; // biome-ignore lint: 读进来的，可能是老样子
/**
 * 老的 state.json：每个会话的东西分在几张表里（finished、seen、models、efforts、permissions、forks），并进 sessions；claudeModels 改叫 modelList。
 * 以前按 mixer 放手时的文件大小猜「终端中打开」的 sizes 不要了。老的键下次存的时候就没了
 */
function migrate(o: Old): Partial<State> {
	const { sizes: _s, finished, seen, models, efforts, permissions, forks, claudeModels, ...rest } = o;
	const sessions: Record<string, Session> = { ...rest.sessions };
	const put = (table: Old | undefined, f: (x: Session, v: Old[string]) => void) => {
		for (const [id, v] of Object.entries(table ?? {})) f((sessions[id] ??= {}), v);
	};
	put(finished, (x, v) => { x.finished = { at: v.at, error: !!v.error }; });
	put(seen, (x, v) => { x.seen = v; });
	put(models, (x, v) => { x.model = v; });
	put(efforts, (x, v) => { x.effort = v; });
	put(permissions, (x, v) => { x.permission = v; });
	put(forks, (x, v) => { x.fork = v; });
	return { ...rest, sessions, modelList: rest.modelList ?? claudeModels ?? null };
}

function save() {
	mkdirSync(dirname(FILE), { recursive: true });
	writeFileSync(`${FILE}.tmp`, JSON.stringify(state));
	renameSync(`${FILE}.tmp`, FILE);
}

/** 这个会话的那一份，没有就建一份（要往里写的时候用） */
const of = (session: string) => (state.sessions[session] ??= {});

export function finished(session: string, error: boolean) {
	of(session).finished = { at: new Date().toISOString(), error };
	save();
}

export function seen(session: string) {
	of(session).seen = new Date().toISOString();
	save();
}

/** 在 mixer 里分叉出来的会话从哪来：原会话、分叉点（null 是从最新处）。分叉时 mixer 自己定的新会话 id，当场记下 */
export type Fork = { session: string; at: string | null };
export function fork(child: string, from: Fork) {
	const old = forkOf(child);
	if (old?.session === from.session && old.at === from.at) return;
	of(child).fork = { session: from.session, at: from.at };
	save();
}
/** 不是在 mixer 里分叉出来的：null */
export const forkOf = (id: string): Fork | null => state.sessions[id]?.fork ?? null;

/** 跑完了还没看：done / error；看过了或没在 mixer 里跑过：null */
export function unread(session: string): "done" | "error" | null {
	const { finished: f, seen: s } = state.sessions[session] ?? {};
	if (!f) return null;
	if (s && s >= f.at) return null;
	return f.error ? "error" : "done";
}

/** 各模型的上下文窗口多大：会话记录里只有模型名，mixer 里每跑完一次从结果里记下来 */
export function learnWindow(model: string, size: number) {
	if (state.windows[model] === size) return;
	state.windows[model] = size;
	save();
}
export const windows = () => state.windows;

/** 在 mixer 里给会话选过的模型（别名）、思考强度、权限：之后续接都用它，直到再换。选回默认（null、自动）就忘掉 */
export function chooseModel(session: string, model: string | null, effort: string | null, permission: string) {
	const p = permission === "auto" ? null : permission;
	if (chosenModel(session) === model && chosenEffort(session) === effort && (state.sessions[session]?.permission ?? null) === p) return;
	const x = of(session);
	for (const [k, v] of [["model", model], ["effort", effort], ["permission", p]] as const) {
		if (v) x[k] = v;
		else delete x[k];
	}
	save();
}
/** 只换权限：批准了计划，命令行自己切出了计划模式（runs.ts 看 status 事件的 permissionMode） */
export function choosePermission(session: string, permission: string) {
	chooseModel(session, chosenModel(session), chosenEffort(session), permission);
}
export const chosenModel = (session: string) => state.sessions[session]?.model ?? null;
export const chosenEffort = (session: string) => state.sessions[session]?.effort ?? null;
export const chosenPermission = (session: string) => state.sessions[session]?.permission ?? "auto";

/** Claude 能选的模型（models.ts 问命令行的原样存着），重启后马上有；version 是读的时候命令行的版本 */
type ModelList = { at: string; version: string | null; models: unknown[] };
export const modelList = () => state.modelList;
export function setModelList(c: ModelList) {
	state.modelList = c;
	save();
}
/** 每个型号第一次见到的时间（按 agent 分开）：头一回读的那批记成很早以前，不算新 */
export function sawModels(agent: string, ids: string[]) {
	const seen = (state.modelsSeen[agent] ??= {});
	const first = !Object.keys(seen).length;
	const now = first ? new Date(0).toISOString() : new Date().toISOString();
	let changed = false;
	for (const id of ids) if (!seen[id]) { seen[id] = now; changed = true; }
	if (changed) save();
}
export const modelsSeen = (agent: string) => state.modelsSeen[agent] ?? {};

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

/** 用量（usage.ts）：每个账号最后一次的样子，按 id */
export const usage = () => state.usage;
export function setUsage(a: Account) {
	state.usage[a.id] = a;
	save();
}

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
/** 放进工作区（会话不给就只放文件夹；给一串是撤销「移出整个文件夹」时放回去）；本来就在返回 false */
export function addToWorkspace(project: string, path: string | null, session?: string | string[] | null) {
	const w = state.workspace ?? { groups: [], sessions: {} };
	let changed = !state.workspace;
	const g = w.groups.find((x) => x.id === project);
	if (!g) { w.groups.unshift({ id: project, path }); changed = true; }
	else if (!g.path && path) { g.path = path; changed = true; }
	for (const s of [session ?? []].flat()) if (w.sessions[s] !== project) { w.sessions[s] = project; changed = true; }
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
/** 会话删掉了：移出工作区，mixer 给它记的（跑完没看、看过、选过的模型、从哪分叉的）整份忘掉。返回工作区变了没有 */
export function forget(session: string) {
	const w = state.workspace;
	const inside = !!w && session in w.sessions;
	if (w && inside) delete w.sessions[session];
	delete state.sessions[session];
	save();
	return inside;
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
/** 在 mixer 里跑完过、还没看的会话（主屏幕图标的角标） */
export const unreadSessions = () => Object.keys(state.sessions).filter((id) => unread(id));
