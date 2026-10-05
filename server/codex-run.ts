// 在 mixer 里跑 Codex：一个常驻的 `codex app-server`（stdio 上一行一个 JSON-RPC 消息），第一次要用时起，挂了下次再起。
//   新会话 thread/start；续接 thread/resume（这个进程里还没载入过的）再 turn/start；分叉 thread/fork（lastTurnId：带到哪一轮为止）
//   停：turn/interrupt。一轮结束（turn/completed）就是这次运行结束
// 流里的 item 通知翻成和 Claude 一样的 stream_event（message_start / content_block_*），每个 item 当一条「消息」，key 是「item id:0」，
// 和 codex.ts 读记录时给节点的 key 一样：tail.ts、网页「正在写的接在末尾、写进记录就换掉」原样能用。
// 确认：item/commandExecution/requestApproval、item/fileChange/requestApproval、item/permissions/requestApproval 转成 mixer 的确认请求。
// 命令行没在 PATH 上时用 Codex.app 带的那个。模型不给就用 model/list 的默认（config.toml 里写的可能是这个账号用不了的）
import { type ChildProcess, spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { shellInner, toolOf } from "./codex.ts";

type Raw = Record<string, any>; // biome-ignore lint: app-server 的消息
const say = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

/** codex 命令：MIXER_CODEX、PATH 里的、Codex.app 带的 */
function bin(): string | null {
	for (const c of [process.env.MIXER_CODEX, "codex", "/Applications/Codex.app/Contents/Resources/codex"]) {
		if (!c) continue;
		if (c.startsWith("/") ? existsSync(c) : spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0) return c;
	}
	return null;
}

/** ms：等回复最多多久（0 是一直等）。控制类的调用都是马上回的，30 秒没回就是卡住了 */
type Server = { p: ChildProcess; call: (method: string, params?: unknown, ms?: number) => Promise<Raw>; loaded: Set<string> };
let server: Promise<Server> | null = null;
/** 载入线程（读整个记录）可能慢一些 */
const SLOW = 120_000;
/** mixer 退出时带走 app-server */
let proc: ChildProcess | null = null;
process.once("exit", () => proc?.kill());
/** 各个线程在跑的那次运行：通知、确认请求按 threadId 分给它 */
const threads = new Map<string, Handler>();
type Handler = { note: (m: Raw) => void; request: (m: Raw) => Promise<unknown> };

function connect(): Promise<Server> {
	if (server) return server;
	const me = new Promise<Server>((ok, fail) => {
		const b = bin();
		if (!b) return fail(new Error("没找到 codex：装 Codex.app，或者设 MIXER_CODEX 指到 codex 命令"));
		const p = spawn(b, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
		proc = p;
		let n = 0;
		let buf = "";
		const waiting = new Map<number, { ok: (r: Raw) => void; fail: (e: Error) => void }>();
		const send = (m: unknown) => p.stdin?.write(`${JSON.stringify(m)}\n`);
		const call = (method: string, params?: unknown, ms = 30_000) => new Promise<Raw>((ok2, fail2) => {
			const id = ++n;
			const t = ms ? setTimeout(() => { waiting.delete(id); fail2(new Error(`codex app-server ${ms / 1000} 秒没回 ${method}`)); }, ms) : null;
			const done = () => { if (t) clearTimeout(t); };
			waiting.set(id, { ok: (r) => { done(); ok2(r); }, fail: (e) => { done(); fail2(e); } });
			send({ id, method, params });
		});
		p.stdin?.on("error", () => {});
		p.stdout?.setEncoding("utf8");
		p.stdout?.on("data", (d: string) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (!line.trim()) continue;
				let m: Raw;
				try { m = JSON.parse(line); } catch { continue; }
				// 回我们的请求
				if (m.id !== undefined && !m.method) {
					const w = waiting.get(m.id);
					waiting.delete(m.id);
					if (m.error) w?.fail(new Error(String(m.error.message ?? JSON.stringify(m.error))));
					else w?.ok(m.result ?? {});
					continue;
				}
				const h = threads.get(String(m.params?.threadId ?? m.params?.conversationId ?? ""));
				// 它来问我们（确认、提问）：交给那个线程的运行；没人认领的一律拒绝
				if (m.method && m.id !== undefined) {
					(h ? h.request(m) : Promise.resolve(deny(m))).then((result) => send({ id: m.id, result }), (e: Error) => send({ id: m.id, error: { code: -32000, message: e.message } }));
					continue;
				}
				if (m.method) h?.note(m);
			}
		});
		let err = "";
		p.stderr?.setEncoding("utf8");
		p.stderr?.on("data", (d: string) => { err = (err + d).slice(-2000); });
		p.on("error", (e) => fail(e));
		p.on("exit", (code) => {
			say(`codex app-server 退出了（${code}）${err.trim() ? `：${err.trim().split("\n").pop()}` : ""}`);
			if (server === me) server = null;
			if (proc === p) proc = null;
			for (const w of waiting.values()) w.fail(new Error("codex app-server 退出了"));
			// 正在跑的都算出错结束
			for (const h of threads.values()) h.note({ method: "turn/completed", params: { turn: { status: "failed", error: { message: "codex app-server 退出了" } } } });
			threads.clear();
		});
		// 起来了却不回 initialize：杀掉，下次要用时重起
		call("initialize", { clientInfo: { name: "mixer", title: "mixer", version: "0.1.0" }, capabilities: null }).then(() => {
			send({ method: "initialized" });
			ok({ p, call, loaded: new Set() });
		}, (e: Error) => {
			p.kill();
			fail(e);
		});
	});
	server = me;
	me.catch(() => { if (server === me) server = null; });
	return me;
}

/** 没人认领的请求（运行已经结束了）：拒绝 */
function deny(m: Raw): unknown {
	if (m.method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
	if (m.method === "item/tool/requestUserInput") return { answers: {} };
	if (m.method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
	if (m.method === "execCommandApproval" || m.method === "applyPatchApproval") return { decision: "denied" };
	return { decision: "decline" };
}

/** 能用的模型（model/list，5 分钟一次）：给输入框选，没选时用 isDefault 那个 */
let models: { at: number; list: { id: string; label: string; isDefault: boolean }[] } | null = null;
export async function listModels() {
	if (models && Date.now() - models.at < 300_000) return models.list;
	const s = await connect();
	const r = await s.call("model/list", {});
	const list = ((r.data ?? []) as Raw[]).filter((x) => !x.hidden).map((x) => ({ id: String(x.id ?? x.model), label: String(x.displayName ?? x.id ?? x.model), isDefault: !!x.isDefault }));
	models = { at: Date.now(), list };
	return list;
}

/** mixer 的权限 → Codex：自动 = Codex 自己的「Auto」（工作区里随便写，越界才问）；每次询问 = untrusted；计划模式 = 只读 */
function policy(permission: string) {
	if (permission === "plan") return { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
	if (permission === "default") return { approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: null };
	return { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: null };
}

/** turn/completed 里的错误：常常是一段 JSON（{"error":{"message":…}}），取里面那句 */
function errorText(e: Raw | null | undefined): string {
	const msg = String(e?.message ?? "");
	try { return String(JSON.parse(msg)?.error?.message ?? msg); } catch { return msg || "出错了"; }
}

export type Hooks = {
	/** 一个 stream_event（tail.ts 认的格式） */
	event: (ev: Raw) => void;
	/** 会话（线程）id 知道了 */
	session: (id: string) => void;
	/** 要人确认：tool / input 照 Claude 的样子（Bash 的 command、Edit 的 file_path），网页上的确认卡片原样能用 */
	ask: (tool: string, input: unknown) => Promise<{ allow: boolean; message?: string }>;
	end: (status: "done" | "error" | "stopped", error?: string) => void;
};

/**
 * 跑一轮。返回「停」：turn/interrupt。
 * at：分叉时带到哪一轮为止（null 是整个会话）
 */
export async function launch(o: { cwd: string; mode: "new" | "resume" | "fork"; session: string | null; at: string | null; prompt: string; images: { media: string; data: string }[]; permission: string; model: string | null }, h: Hooks) {
	const s = await connect();
	const model = o.model || (await listModels()).find((m) => m.isDefault)?.id || null;
	const pol = policy(o.permission);
	const base = { model, cwd: o.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox };
	let tid: string;
	if (o.mode === "new") tid = String((await s.call("thread/start", base, SLOW)).thread.id);
	else if (o.mode === "fork") tid = String((await s.call("thread/fork", { ...base, threadId: o.session, lastTurnId: o.at, excludeTurns: true }, SLOW)).thread.id);
	else {
		tid = String(o.session);
		if (!s.loaded.has(tid)) await s.call("thread/resume", { ...base, threadId: tid, excludeTurns: true }, SLOW);
	}
	s.loaded.add(tid);
	h.session(tid);

	let turnId: string | null = null;
	let error = "";
	let msg: string | null = null;
	const items = new Map<string, Raw>();
	const stream = (event: Raw) => h.event({ type: "stream_event", event });
	/** 一个 item 开始：当成一条新消息，第 0 段 */
	const begin = (item: Raw) => {
		const id = String(item.id);
		items.set(id, item);
		const block =
			item.type === "agentMessage" ? { type: "text" }
			: item.type === "reasoning" ? { type: "thinking" }
			: (() => { const t = toolOf(item); return t ? { type: "tool_use", id, name: t.name, input: t.input } : null; })();
		if (!block) return;
		msg = id;
		stream({ type: "message_start", message: { id } });
		const { input, ...b } = block as Raw;
		stream({ type: "content_block_start", index: 0, content_block: b });
		if (input) stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
	};
	const delta = (itemId: string, d: Raw) => { if (itemId === msg) stream({ type: "content_block_delta", index: 0, delta: d }); };

	threads.set(tid, {
		note: (m) => {
			const p = (m.params ?? {}) as Raw;
			if (m.method === "item/started" && p.item) begin(p.item);
			else if (m.method === "item/agentMessage/delta") delta(String(p.itemId), { type: "text_delta", text: String(p.delta ?? "") });
			else if (m.method === "item/reasoning/summaryTextDelta") delta(String(p.itemId), { type: "thinking_delta", thinking: String(p.delta ?? "") });
			else if (m.method === "item/reasoning/summaryPartAdded" && (p.summaryIndex ?? 0) > 0) delta(String(p.itemId), { type: "thinking_delta", thinking: "\n\n" });
			else if (m.method === "error") error = errorText(p.error);
			else if (m.method === "turn/completed") {
				const t = (p.turn ?? {}) as Raw;
				if (turnId && t.id && t.id !== turnId) return;
				threads.delete(tid);
				h.end(t.status === "completed" ? "done" : t.status === "interrupted" ? "stopped" : "error", t.status === "failed" ? errorText(t.error) || error : undefined);
			}
		},
		request: async (m) => {
			const p = (m.params ?? {}) as Raw;
			if (m.method === "item/commandExecution/requestApproval" || m.method === "execCommandApproval") {
				const command = shellInner(p.command ?? items.get(String(p.itemId))?.command ?? "");
				const a = await h.ask("Bash", { command, description: p.reason ?? undefined });
				return m.method === "execCommandApproval" ? { decision: a.allow ? "approved" : { denied: { rejection: a.message ?? "在 mixer 里被拒绝了" } } } : { decision: a.allow ? "accept" : "decline" };
			}
			if (m.method === "item/fileChange/requestApproval" || m.method === "applyPatchApproval") {
				const t = toolOf(items.get(String(p.itemId)) ?? { type: "fileChange", changes: p.fileChanges ?? {} });
				const a = await h.ask("Edit", { file_path: t?.input.file_path ?? p.grantRoot ?? "", description: p.reason ?? undefined });
				return m.method === "applyPatchApproval" ? { decision: a.allow ? "approved" : { denied: { rejection: a.message ?? "在 mixer 里被拒绝了" } } } : { decision: a.allow ? "accept" : "decline" };
			}
			if (m.method === "item/permissions/requestApproval") {
				const a = await h.ask("权限", { description: p.reason ?? "要更多权限", ...p.permissions });
				return { permissions: a.allow ? (p.permissions ?? {}) : {}, scope: "turn" };
			}
			// Codex 提问（request_user_input）、MCP 要输入：mixer 里还答不了，告诉它没人答
			return deny(m);
		},
	});

	const input = [
		...(o.prompt.trim() ? [{ type: "text", text: o.prompt, text_elements: [] }] : []),
		...o.images.map((i) => ({ type: "image", url: `data:${i.media};base64,${i.data}` })),
	];
	try {
		// turn/start 马上回（这一轮的进展全在通知里），带图片时请求大一点，给 SLOW
		const r = await s.call("turn/start", { threadId: tid, input, model, approvalPolicy: pol.approvalPolicy, ...(pol.sandboxPolicy ? { sandboxPolicy: pol.sandboxPolicy } : {}), summary: "detailed" }, SLOW);
		turnId = String(r.turn?.id ?? "") || null;
	} catch (e) {
		threads.delete(tid);
		throw e;
	}
	return { stop: () => { if (turnId) s.call("turn/interrupt", { threadId: tid, turnId }).catch(() => {}); } };
}
