// 和 mixer 服务之间：类型（server/ 也用这里的）、取数据、发请求。
// 服务端（nodenext）也 import 这个文件，相对路径要带 .ts
import type { Tail } from "./tail.ts";
import type { Account } from "./usage.ts";

export type Project = { id: string; path: string | null; sessions: number; mtime: string };
export type SessionMeta = {
	id: string;
	/** /rename、/branch 起的名字（custom-title）优先，没有用 ai-title */
	title: string | null; first: string | null; last: string | null;
	/** title 是人起的名字（Claude 的 custom-title）：分叉的也用它，不用 fresh */
	custom: boolean;
	/** 分叉后自己问的第一句（前面的记录是从原会话原样复制来的）；不是分叉、或者认不出来是 null */
	fresh: string | null; prompts: number; size: number; mtime: string;
	/**
	 * 在 mixer 外面开着（终端、IDE、桌面版：server/terminals.ts 照 Claude Code 自己记的算）：只能分叉。
	 * busy 是 Claude 登记的在跑；idle 是闲着；null 是没开着
	 */
	terminal: "busy" | "idle" | null;
	/**
	 * 直接从哪个会话分叉出来的（原会话的文件可能已经删了）。Claude：mixer 里分叉的照 state 记的，终端里 /branch 的照记录里的 forkedFrom，
	 * 终端里 --fork-session 的没有标记、按第一句的 uuid 猜（server/sessions.ts 的 guess）
	 */
	parent: string | null; unread: "done" | "error" | null;
	/** Claude Code 什么时候会删掉它（最后修改 + cleanupPeriodDays） */
	expires: string | null;
};
export type ProjectTree = Omit<Project, "sessions"> & { sessions: SessionMeta[] };
/** 工作区里的一个文件夹（侧栏的一组）：放进来的会话；顺序是人拖的 */
export type Group = { id: string; path: string | null; sessions: SessionMeta[] };
type Base = { uuid: string; parent: string | null; ts: string };
/** 这条回复发出时上下文里有多少 token，和用的模型 */
export type Ctx = { used: number; model: string };
/**
 * key：「消息 id : 第几段」，和运行输出流里的同一段对得上。input、result 只是预览，完整的点开再拿；
 * resultUuid：结果所在那条 user 记录（从这一步分叉要用它，用工具调用那条结果就丢了）。
 * 下面几样都照记录里结构化的那份（参数、toolUseResult），不从文字里认：
 *   agent：它开的子代理（Agent、forked 的 Skill）；async：开了就回来、子代理在后台跑（async_launched，或 Skill 的 forked + background）；
 *   task：它开的后台任务的 id（后台命令的 backgroundTaskId、Monitor 的 taskId）；
 *   file：这一步读写的那个文件（参数里的 file_path / notebook_path）；files：它真改了的文件（成功了才有；绝对路径）
 */
export type ToolNode = Base & {
	k: "tool"; id: string; name: string; summary: string; input: string; result: { text: string; error: boolean; cut: boolean; images: number } | null; resultUuid: string | null;
	agent: string | null; async?: { agentId: string }; task?: string; file?: string; files?: string[]; ctx?: Ctx; key?: string;
};
export type Node =
	/**
	 * 你的消息。queued：运行中插进来的（queued_command），source 是它发的时候带的 uuid（记录里的 uuid 是另给的）；
	 * live：网页自己先画上的、记录里还没有的那条（uuid 是发的时候的）
	 */
	| (Base & { k: "user"; text: string; images: number; queued?: boolean; source?: string; live?: boolean })
	| (Base & { k: "assistant"; text: string; ctx?: Ctx; key?: string })
	/** 记录里的思考只给开头（cut 时全文点开再拿 /thinking/<uuid>）；正在写的（流里的）是全文 */
	| (Base & { k: "thinking"; text: string; cut?: boolean; ctx?: Ctx; key?: string })
	| ToolNode
	/** summary 离开时的小结；compact 上下文压缩（detail 是压缩前的摘要）；info 系统提示；task 后台任务的通知（status、detail 是结果）；agent 子代理的回报。agent：对应的子代理（有它的记录才给） */
	| (Base & { k: "event"; kind: "summary" | "compact" | "info" | "task" | "agent"; text: string; detail?: string; status?: string; agent?: string });
/**
 * windows：各模型的上下文窗口大小（mixer 跑过才知道）。
 * version：下次带着它来拉（?since=），只给之后新建、改过的节点（delta）。
 * leaf：命令行续接时接着的那个显示节点（记录里最后的 last-prompt 的 leafUuid；终端里回退过也照它），没有是 null（走最新的叶子）；
 * touched：这个会话（连子代理）改过的文件，绝对路径。这两样每次都整个给
 */
export type Session = { meta: SessionMeta; nodes: Node[]; windows: Record<string, number>; model: string | null; effort: string | null; version: string; delta: boolean; leaf: string | null; touched: string[] };
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
/**
 * 一次运行。uuid：这条消息在记录里的 uuid（就是写进 stdin 时带的；叫醒的那一轮没有消息，null）；
 * merged：它带着网页发的哪几条（各自发的时候的 uuid：一条就是它自己，排队的几条合成一条时是几个）；images：带了几张图；
 * version：结束时会话记录写到哪了（和 /api/sessions 的 ?since 一样的「epoch:rev」，网页的数据到了这里，这次运行写的就都拿到了）。
 * 还在跑、刚结束还没算出来时没有这一项；null 是没有记录（一开始就出错了）
 */
export type Run = {
	id: string; project: string; cwd: string; from: string | null; session: string | null; mode: "new" | "resume" | "fork"; at: string | null;
	prompt: string; permission: string; model: string | null; effort: string | null; status: "running" | "done" | "error" | "stopped"; started: string; ended: string | null; error: string | null;
	uuid: string | null; merged: string[]; images: number; version?: string | null;
};
export type Dirs = { path: string; home: string; parent: string | null; git: boolean; entries: { name: string; path: string; git: boolean; project: boolean }[] };
/**
 * Claude 开着的一个后台任务（后台命令、Monitor、后台子代理）：type 是 Claude Code 的（local_bash、local_agent…）；tool：开它的工具调用；
 * output：能看输出（后台命令、Monitor）。命令行说不算在干活的（ambient）不列
 */
export type Task = { id: string; type: string; description: string; started: string; tool: string | null; output: boolean };
/** mixer 开着的一个 claude 进程：turn 是正在跑的那一轮（运行 id），null 是 Claude 闲着、在等后台任务 */
export type Host = { id: string; project: string; session: string; turn: string | null; tasks: Task[] };
/** 会话在跑时发的「接着说」：排着，这次跑完一起发。uuid：网页发的时候给的 */
export type Queued = { id: string; uuid: string; project: string; session: string; prompt: string; images: number; permission: string; model: string | null; effort: string | null; at: string };
/**
 * 确认请求归会话，不归哪一轮（后台子代理在 Claude 闲着时也会问）。cwd：路径写成相对的用。
 * toolUse：是哪个工具调用；agent：子代理在问时是哪个（description 是开它时的说明，可能是空的）
 */
export type Approval = { id: string; project: string; cwd: string; session: string; tool: string; input: Record<string, unknown>; at: string; toolUse: string | null; agent: { id: string; description: string } | null };
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
