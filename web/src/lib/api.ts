// 和 mixer 服务之间：类型（和 server/ 对应）、取数据、发请求。
export type Project = { id: string; path: string | null; sessions: number; mtime: string };
export type SessionMeta = {
	id: string; title: string | null; first: string | null; last: string | null; fresh: string | null; prompts: number; size: number; mtime: string;
	active: boolean; root: string | null; born: number; parent: string | null; unread: "done" | "error" | null;
};
export type ProjectTree = Omit<Project, "sessions"> & { sessions: SessionMeta[] };
type Base = { uuid: string; parent: string | null; ts: string };
/** 这条回复发出时上下文里有多少 token，和用的模型 */
export type Ctx = { used: number; model: string };
export type ToolNode = Base & { k: "tool"; id: string; name: string; summary: string; input: string; result: { text: string; error: boolean; cut: boolean; images: number } | null; resultUuid: string | null; agent: string | null; ctx?: Ctx };
export type Node =
	| (Base & { k: "user"; text: string; images: number; queued?: boolean })
	| (Base & { k: "assistant"; text: string; ctx?: Ctx })
	| (Base & { k: "thinking"; text: string; ctx?: Ctx })
	| ToolNode
	| (Base & { k: "event"; kind: "summary" | "compact" | "info" | "task" | "agent"; text: string; detail?: string; status?: string; agent?: string });
/** windows：各模型的上下文窗口大小（mixer 跑过才知道） */
export type Session = { meta: SessionMeta; nodes: Node[]; windows: Record<string, number>; model: string | null };
export type Agent = { id: string; info: { agentType?: string; description?: string }; nodes: Node[] };
export type RepoFile = { kind: "text"; size: number; text: string } | { kind: "image" | "binary" | "large"; size: number };
export type Status = { git: false } | { git: true; branch: string; changes: { code: string; path: string }[]; log: { hash: string; subject: string; when: string; author: string }[] };
export type Run = {
	id: string; project: string; cwd: string; from: string | null; session: string | null; mode: "new" | "resume" | "fork"; at: string | null;
	prompt: string; permission: string; model: string | null; status: "running" | "done" | "error" | "stopped"; started: string; ended: string | null; error: string | null; events: number;
};
export type Dirs = { path: string; home: string; parent: string | null; git: boolean; entries: { name: string; path: string; git: boolean; project: boolean }[] };
/** 会话在跑时发的「接着说」：排着，这次跑完一起发 */
export type Queued = { id: string; project: string; session: string; prompt: string; images: number; permission: string; model: string | null; at: string };
export type Approval = { id: string; run: string; tool: string; input: Record<string, unknown>; at: string };

export async function api<T>(path: string, body?: unknown): Promise<T> {
	const r = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const d = await r.json().catch(() => null);
	if (!r.ok) throw new Error(d?.error ?? `${r.status}`);
	return d as T;
}

export const enc = encodeURIComponent;
