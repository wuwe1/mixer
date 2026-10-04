// 和 mixer 服务之间：类型（和 server/ 对应）、取数据、发请求。
export type Project = { id: string; path: string | null; sessions: number; mtime: string };
export type SessionMeta = { id: string; title: string | null; first: string | null; last: string | null; prompts: number; size: number; mtime: string; active: boolean; branch: string | null };
type Base = { uuid: string; parent: string | null; ts: string };
export type ToolNode = Base & { k: "tool"; id: string; name: string; summary: string; input: string; result: { text: string; error: boolean; cut: boolean } | null; agent: string | null };
export type Node =
	| (Base & { k: "user"; text: string; images: number; queued?: boolean })
	| (Base & { k: "assistant"; text: string })
	| (Base & { k: "thinking"; text: string })
	| ToolNode
	| (Base & { k: "event"; kind: "summary" | "compact" | "notice"; text: string });
export type Session = { meta: SessionMeta; nodes: Node[] };
export type Agent = { id: string; info: { agentType?: string; description?: string }; nodes: Node[] };
export type RepoFile = { kind: "text"; size: number; text: string } | { kind: "image" | "binary" | "large"; size: number };
export type Status = { git: false } | { git: true; branch: string; changes: { code: string; path: string }[]; log: { hash: string; subject: string; when: string; author: string }[] };
export type Run = {
	id: string; project: string; cwd: string; from: string | null; session: string | null; mode: "new" | "resume" | "fork" | "fork-at";
	prompt: string; permission: string; status: "running" | "done" | "error" | "stopped"; started: string; ended: string | null; error: string | null; events: number;
};
export type Approval = { id: string; run: string; tool: string; input: Record<string, unknown>; at: string };

export async function api<T>(path: string, body?: unknown): Promise<T> {
	const r = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const d = await r.json().catch(() => null);
	if (!r.ok) throw new Error(d?.error ?? `${r.status}`);
	return d as T;
}

export const enc = encodeURIComponent;
