// 和 mixer 服务之间：类型（和 server/ 对应）、取数据、发请求。
export type Project = { id: string; path: string | null; sessions: number; mtime: string };
export type SessionMeta = {
	id: string;
	/** Codex 的会话（现在只能看）；没有就是 Claude Code 的 */
	agent?: "codex"; title: string | null; first: string | null; last: string | null; fresh: string | null; prompts: number; size: number; mtime: string;
	active: boolean; root: string | null; born: number; parent: string | null; unread: "done" | "error" | null;
};
export type ProjectTree = Omit<Project, "sessions"> & { sessions: SessionMeta[] };
/** 工作区里的一个文件夹（侧栏的一组）：放进来的会话；顺序是人拖的 */
export type Group = { id: string; path: string | null; sessions: SessionMeta[] };
type Base = { uuid: string; parent: string | null; ts: string };
/** 这条回复发出时上下文里有多少 token，和用的模型 */
export type Ctx = { used: number; model: string };
/** key：「消息 id : 第几段」，和运行输出流里的同一段对得上 */
export type ToolNode = Base & { k: "tool"; id: string; name: string; summary: string; input: string; result: { text: string; error: boolean; cut: boolean; images: number } | null; resultUuid: string | null; agent: string | null; ctx?: Ctx; key?: string };
export type Node =
	| (Base & { k: "user"; text: string; images: number; queued?: boolean })
	| (Base & { k: "assistant"; text: string; ctx?: Ctx; key?: string })
	| (Base & { k: "thinking"; text: string; ctx?: Ctx; key?: string })
	| ToolNode
	| (Base & { k: "event"; kind: "summary" | "compact" | "info" | "task" | "agent"; text: string; detail?: string; status?: string; agent?: string });
/**
 * windows：各模型的上下文窗口大小（mixer 跑过才知道）。
 * version：下次带着它来拉（?since=），只给之后新建、改过的节点（delta）
 */
export type Session = { meta: SessionMeta; nodes: Node[]; windows: Record<string, number>; model: string | null; version: string; delta: boolean };
export type Agent = { id: string; info: { agentType?: string; description?: string }; nodes: Node[] };
export type RepoFile = { kind: "text"; size: number; text: string } | { kind: "image" | "binary" | "large"; size: number };
export type Change = { code: string; path: string; add?: number; del?: number };
export type Commit = { hash: string; subject: string; when: string; author: string; local: boolean };
export type Status =
	| { git: false }
	| { git: true; branch: string; upstream: string | null; ahead: number; behind: number; changes: Change[]; log: Commit[] };
export type Run = {
	id: string; project: string; cwd: string; from: string | null; session: string | null; mode: "new" | "resume" | "fork"; at: string | null;
	prompt: string; permission: string; model: string | null; status: "running" | "done" | "error" | "stopped"; started: string; ended: string | null; error: string | null; events: number;
};
export type Dirs = { path: string; home: string; parent: string | null; git: boolean; entries: { name: string; path: string; git: boolean; project: boolean }[] };
/** 会话在跑时发的「接着说」：排着，这次跑完一起发 */
export type Queued = { id: string; project: string; session: string; prompt: string; images: number; permission: string; model: string | null; at: string };
/** 订阅用量：两个窗口用了多少（0–1）、什么时候重置（秒）；at 是 mixer 最近一次记下的时间 */
type LimitWindow = { utilization: number; resetsAt: number };
export type Limits = { five_hour: LimitWindow | null; seven_day: LimitWindow | null; at: string };
export type Approval = { id: string; run: string; tool: string; input: Record<string, unknown>; at: string };

export async function api<T>(path: string, body?: unknown): Promise<T> {
	const r = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const d = await r.json().catch(() => null);
	// 没登录（或者登录过期了）：外框换成登录页
	if (r.status === 401 && d?.login) window.dispatchEvent(new Event("mixer:login"));
	if (!r.ok) throw new Error(d?.error ?? `${r.status}`);
	return d as T;
}

export const enc = encodeURIComponent;
