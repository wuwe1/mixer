// 和 mixer 服务之间：类型（和 server/ 对应）、取数据、发请求。
import type { Tail } from "./tail";
import type { Account } from "./usage";

export type Project = { id: string; path: string | null; sessions: number; mtime: string };
export type SessionMeta = {
	id: string;
	/** Codex 的会话（现在只能看）；没有就是 Claude Code 的 */
	agent?: "codex"; title: string | null; first: string | null; last: string | null; fresh: string | null; prompts: number; size: number; mtime: string;
	active: boolean; root: string | null; born: number; parent: string | null; unread: "done" | "error" | null;
	/** Claude Code 什么时候会删掉它（最后修改 + cleanupPeriodDays）；Codex 的是 null */
	expires: string | null;
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
	/** 记录里的思考只给开头（cut 时全文点开再拿 /thinking/<uuid>）；正在写的（流里的）是全文 */
	| (Base & { k: "thinking"; text: string; cut?: boolean; ctx?: Ctx; key?: string })
	| ToolNode
	| (Base & { k: "event"; kind: "summary" | "compact" | "info" | "task" | "agent"; text: string; detail?: string; status?: string; agent?: string });
/**
 * windows：各模型的上下文窗口大小（mixer 跑过才知道）。
 * version：下次带着它来拉（?since=），只给之后新建、改过的节点（delta）
 */
export type Session = { meta: SessionMeta; nodes: Node[]; windows: Record<string, number>; model: string | null; effort: string | null; version: string; delta: boolean };
/** 子代理的对话；version / delta 和 Session 一样（开着看它跑的时候带 ?since= 拉增量） */
export type Agent = { id: string; info: { agentType?: string; description?: string }; nodes: Node[]; version: string; delta: boolean };
/**
 * 会话开过的一个子代理（/agents 列表、agent 事件）：toolUseId 是开它的那个 Agent 工具调用；
 * latest：它现在在做什么（最后一个工具调用，或者最后一段回复的第一行），10 分钟没动的是 null；mtime：最后写的时间（毫秒）
 */
export type Sub = { agentId: string; toolUseId: string | null; agentType: string | null; description: string | null; latest: string | null; mtime: number };
export type RepoFile = { kind: "text"; size: number; text: string } | { kind: "image" | "binary" | "large"; size: number };
export type Change = { code: string; path: string; add?: number; del?: number };
export type Commit = { hash: string; subject: string; when: string; author: string; local: boolean };
export type Status =
	| { git: false }
	| { git: true; branch: string; upstream: string | null; ahead: number; behind: number; changes: Change[]; log: Commit[] };
export type Run = {
	id: string; project: string; cwd: string; from: string | null; session: string | null; mode: "new" | "resume" | "fork"; at: string | null;
	prompt: string; permission: string; model: string | null; effort: string | null; status: "running" | "done" | "error" | "stopped"; started: string; ended: string | null; error: string | null; events: number;
};
export type Dirs = { path: string; home: string; parent: string | null; git: boolean; entries: { name: string; path: string; git: boolean; project: boolean }[] };
/** Claude 开着的一个后台任务（后台命令、Monitor、后台子代理）：type 是 Claude Code 的（local_bash、local_agent…）；tool：开它的工具调用；output：能看输出 */
export type Task = { id: string; type: string; description: string; started: string; tool: string | null; output: boolean };
/** mixer 开着的一个 claude 进程：turn 是正在跑的那一轮（运行 id），null 是 Claude 闲着、在等后台任务 */
export type Host = { id: string; project: string; session: string | null; turn: string | null; tasks: Task[] };
/** 会话在跑时发的「接着说」：排着，这次跑完一起发 */
export type Queued = { id: string; project: string; session: string; prompt: string; images: number; permission: string; model: string | null; effort: string | null; at: string };
export type Approval = { id: string; run: string; tool: string; input: Record<string, unknown>; at: string };
/** SSE 连上时先来的（server/sse.ts）：这时的全部状态（hosts：开着的 claude 进程和它们的后台任务；用量是各个账号的，lib/usage.ts）。workspace 是 null：服务端没算出来；tails：在跑的那几次正在写的那几段（按运行 id） */
export type Hello = { runs: Run[]; hosts: Host[]; approvals: Approval[]; queue: Queued[]; usage: Account[]; workspace: Group[] | null; tails: Record<string, Tail> };

/**
 * 接口出错。status 0 是根本没连上（断网、mixer 在重启：浏览器只给一句英文，Safari 是「Load failed」）；
 * temporary：等一下再试多半就好，没连上，或者隧道说后面没回应（502 / 503 / 504，回的是 cloudflared 的网页，不是 JSON）
 */
export class ApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
	get temporary() {
		return this.status === 0 || (this.status >= 502 && this.status <= 504);
	}
}
export const temporary = (e: unknown) => e instanceof ApiError && e.temporary;

/**
 * 最多等 30 秒：手机换网、隧道留着半开的连接时请求会一直挂着，挂住的那个又挡着后面的（会话页一次只拉一个），对话就停在旧的不动了。
 * 超时和连不上一样算「过一会儿再试」
 */
const TIMEOUT = 30_000;

export async function api<T>(path: string, body?: unknown): Promise<T> {
	let r: Response;
	try {
		const signal = AbortSignal.timeout(TIMEOUT);
		r = await fetch(path, body === undefined ? { signal } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
	} catch (e) {
		throw new ApiError(e instanceof DOMException && e.name === "TimeoutError" ? "mixer 没回应（等了 30 秒）" : "连不上 mixer", 0);
	}
	const d = await r.json().catch(() => null);
	// 没登录（或者登录过期了）：外框换成登录页
	if (r.status === 401 && d?.login) window.dispatchEvent(new Event("mixer:login"));
	if (!r.ok) throw new ApiError(d?.error ?? (r.status >= 502 && r.status <= 504 ? `mixer 没回应（${r.status}），可能在重启` : `出错了（${r.status}）`), r.status);
	return d as T;
}

export const enc = encodeURIComponent;
