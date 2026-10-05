// 运行会话：在本机启动 claude 命令行（用它自己登录的订阅），非交互模式，按行输出 JSON。
//   新会话：在一个文件夹里 claude -p
//   续接：claude -p --resume <id>
//   分叉：再加 --fork-session（新会话 id，原来的不动）；从中间某条 Claude 的消息分叉，再加 --resume-session-at <那条记录的 uuid>（只带到它为止的上下文）
// 要确认的工具调用经 MCP 工具 mcp__mixer__approve 转到网页上（approvals）。
// 同一个会话如果还在别处跑着（记录 90 秒内有写入，而且不是 mixer 自己跑完的），不许直接续接，只能分叉：免得两边同时往一个文件里写。
// 正在 mixer 里跑的会话再「接着说」就排队：这次运行一结束（跑完、出错、被停），排着的话合成一条续接发出去。
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as codex from "./codex.ts";
import * as codexRun from "./codex-run.ts";
import { sessionFile } from "./sessions.ts";
import * as state from "./state.ts";
import { counts, emptyTail, step, type Tail } from "../web/src/lib/tail.ts";

export type RunStatus = "running" | "done" | "error" | "stopped";
export type Run = {
	id: string;
	project: string;
	cwd: string;
	from: string | null;
	session: string | null;
	mode: "new" | "resume" | "fork";
	/** 哪个 agent 跑的：Claude Code（claude -p）或 Codex（codex app-server） */
	agent: "claude" | "codex";
	/** 分叉点：从这条 Claude 的消息之后分出去；null 是从最新处 */
	at: string | null;
	prompt: string;
	permission: string;
	/** --model：别名（opus、sonnet…）或完整型号；null 是用 Claude Code 的默认 */
	model: string | null;
	status: RunStatus;
	started: string;
	ended: string | null;
	error: string | null;
	events: unknown[];
};

/** 消息里带的图片（base64） */
export type Image = { media: string; data: string };

/** 排着队的「接着说」 */
export type Queued = { id: string; project: string; cwd: string; session: string; prompt: string; images: Image[]; permission: string; model: string | null; at: string };

type Approval = { id: string; run: string; tool: string; input: unknown; at: string; resolve: (d: { allow: boolean; message?: string }) => void };

/** 服务端自己用的：子进程，和输出流攒成的「正在写的那几段」（网页刷新时从这里拿快照） */
type Live = Run & { child?: ChildProcess; halt?: () => void; tail: Tail };
const runs = new Map<string, Live>();
const approvals = new Map<string, Approval>();
const queue: Queued[] = [];
export const TOKEN = randomUUID();
const MCP = join(dirname(new URL(import.meta.url).pathname), "..", "mcp", "approve.ts");

type Emit = (type: string, data: unknown) => void;
let emit: Emit = () => {};
export const onEvent = (f: Emit) => { emit = f; };

const view = (r: Live) => {
	const { child: _c, halt: _h, tail: _t, events, ...rest } = r;
	return { ...rest, events: events.length };
};
export const list = () => [...runs.values()].map(view).sort((a, b) => b.started.localeCompare(a.started));
export const get = (id: string) => {
	const r = runs.get(id);
	return r ? { ...view(r), events: r.events } : null;
};
/** 正在写的那几段的快照；seq 之后的事件网页从推送里接 */
export const tail = (id: string) => runs.get(id)?.tail ?? null;

export async function start(o: { project: string; cwd: string; session: string | null; mode: Run["mode"]; at?: string | null; prompt: string; images?: Image[]; permission: string; model?: string | null; agent?: string | null }) {
	const images = o.images ?? [];
	if (!o.prompt.trim() && !images.length) throw new Error("说点什么");
	if (images.length > 10 || images.some((i) => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(i.media) || typeof i.data !== "string")) throw new Error("图片不对：最多 10 张，png / jpeg / gif / webp");
	if (!["auto", "default", "acceptEdits", "plan", "manual"].includes(o.permission)) throw new Error("不支持的权限模式");
	if (!["new", "resume", "fork"].includes(o.mode)) throw new Error("不认识的方式");
	const model = o.model || null;
	if (model && !/^[a-z][\w.[\]-]*$/i.test(model)) throw new Error("模型名不对");
	const resume = o.mode === "new" ? null : o.session;
	if (o.mode !== "new" && !resume) throw new Error("要接哪个会话？");
	// 新会话按选的；续接、分叉跟着原会话是谁的
	const cx = resume ? codex.find(resume) : null;
	const agent: Run["agent"] = o.mode === "new" ? (o.agent === "codex" ? "codex" : "claude") : cx ? "codex" : "claude";
	if (o.at && !(agent === "codex" ? /^[\w-]+$/ : /^[0-9a-f-]{36}$/).test(o.at)) throw new Error("分叉点不对");
	if (o.mode === "resume" && resume) {
		// 最近的写入是 mixer 自己的运行（已经跑完）就放行；否则 90 秒内有写入，说明可能在终端里开着
		const ours = [...runs.values()].filter((r) => r.session === resume);
		if (ours.some((r) => r.status === "running")) {
			const q: Queued = { id: randomUUID().slice(0, 8), project: o.project, cwd: o.cwd, session: resume, prompt: o.prompt, images, permission: o.permission, model, at: new Date().toISOString() };
			queue.push(q);
			emit("queue", queued());
			return { queued: queueView(q) };
		}
		const mtime = statSync(cx ? cx.file : sessionFile(o.project, resume)).mtimeMs;
		if (!ours.length && Date.now() - mtime < 90_000 && !state.ourLastWrite(resume, mtime)) {
			throw new Error("这个会话还在别处跑着（90 秒内有写入）：现在只能分叉");
		}
	}
	const id = randomUUID().slice(0, 8);
	if (agent === "codex") return startCodex(fresh(id, o, agent, model, resume), o, images, cx);
	const dir = join(tmpdir(), "mixer");
	mkdirSync(dir, { recursive: true });
	const cfg = join(dir, `mcp-${id}.json`);
	writeFileSync(cfg, JSON.stringify({ mcpServers: { mixer: { command: process.execPath, args: [MCP], env: { MIXER_URL: `http://127.0.0.1:${process.env.MIXER_PORT ?? 4848}`, MIXER_TOKEN: TOKEN, MIXER_RUN: id } } } }));
	// --thinking-display summarized：思考给摘要（流里有、也写进记录）。不加的话 -p 下大多只有签名、没有文字。帮助里没写，试过可用
	const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--thinking-display", "summarized", "--permission-mode", o.permission, "--permission-prompt-tool", "mcp__mixer__approve", "--mcp-config", cfg];
	if (model) args.push("--model", model);
	// 带图片：stdin 改成一条 stream-json 的 user 消息（文字 + 图片块）
	if (images.length) args.push("--input-format", "stream-json");
	if (resume) args.push("--resume", resume);
	if (o.mode === "fork") args.push("--fork-session", ...(o.at ? ["--resume-session-at", o.at] : []));
	const run = fresh(id, o, agent, model, resume);
	const child = spawn("claude", args, { cwd: o.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
	run.child = child;
	runs.set(id, run);
	if (!images.length) child.stdin.end(o.prompt);
	else {
		const content = [...(o.prompt.trim() ? [{ type: "text", text: o.prompt }] : []), ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media, data: i.data } }))];
		child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
	}
	let buf = "";
	child.stdout.on("data", (chunk: Buffer) => {
		buf += chunk.toString("utf8");
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (!line) continue;
			let ev: Record<string, unknown>;
			try { ev = JSON.parse(line); } catch { continue; }
			// 新会话、分叉的 id 到这时才知道：马上告诉网页，不然它对不上这次运行，会把正在写的会话当成终端里开着
			if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
				known(run, ev.session_id);
				if (Array.isArray(ev.skills)) state.learnCaps(run.project, { skills: ev.skills.map(String), plugins: Array.isArray(ev.plugins) ? (ev.plugins as { name: string; path: string }[]).map((p) => ({ name: String(p.name), path: String(p.path) })) : [] });
			}
			if (ev.type === "result" && ev.modelUsage && typeof ev.modelUsage === "object")
				for (const [model, u] of Object.entries(ev.modelUsage as Record<string, { contextWindow?: number }>)) if (u?.contextWindow) state.learnWindow(model, u.contextWindow);
			if (ev.type === "rate_limit_event") {
				const w = (ev.rate_limit_info as { unifiedWindows?: unknown } | undefined)?.unifiedWindows;
				if (w && typeof w === "object") {
					state.learnLimits(w as Record<string, unknown>);
					emit("limits", state.limits());
				}
			}
			push(run, ev);
		}
	});
	let err = "";
	child.stderr.on("data", (c: Buffer) => { err = (err + c.toString("utf8")).slice(-4000); });
	child.on("exit", (code, signal) => {
		delete run.child;
		finish(run, code === 0 ? "done" : "error", err.trim() || `退出码 ${code ?? signal}`);
	});
	emit("run", view(run));
	return view(run);
}

/** 一次运行的样子（两种 agent 一样） */
function fresh(id: string, o: { project: string; cwd: string; session: string | null; mode: Run["mode"]; at?: string | null; prompt: string; permission: string }, agent: Run["agent"], model: string | null, resume: string | null): Live {
	return {
		id,
		project: o.project,
		cwd: o.cwd,
		from: o.session,
		session: o.mode === "resume" ? resume : null,
		mode: o.mode,
		agent,
		at: o.mode === "fork" ? (o.at ?? null) : null,
		prompt: o.prompt,
		permission: o.permission,
		model,
		status: "running",
		started: new Date().toISOString(),
		ended: null,
		error: null,
		events: [],
		tail: emptyTail(),
	};
}

/** 会话 id 知道了（续接的一开始就知道；新会话、分叉的这时才有）：马上告诉网页，不然它对不上这次运行，会把正在写的会话当成终端里开着 */
function known(run: Live, session: string) {
	if (run.session !== session) {
		run.session = session;
		emit("run", view(run));
	}
	if (run.model) state.chooseModel(session, run.model);
	// 在 mixer 里跑过的会话放进工作区（新会话、分叉的文件夹放到最上面）
	if (state.addToWorkspace(run.project, run.cwd, session)) emit("workspace", null);
}

/** 一个输出事件：留着（/api/runs/:id 看得到）；流事件攒进「正在写的那几段」，带上序号推给网页，网页按序号接在快照后面，接不上就重新拿快照 */
function push(run: Live, ev: Record<string, unknown>) {
	run.events.push(ev);
	if (run.events.length > 5000) run.events.splice(0, run.events.length - 5000);
	if (counts(ev)) {
		run.tail = step(run.tail, ev, Date.now());
		emit("run-event", { id: run.id, seq: run.tail.seq, event: ev });
	}
}

/** 运行结束（跑完、出错、被停）：记下来、作废它的确认请求、接着发排队的 */
function finish(run: Live, status: "done" | "error" | "stopped", error: string | null) {
	if (run.status !== "running" && run.ended) return;
	run.status = run.status === "stopped" ? "stopped" : status;
	if (run.status === "error") run.error = error || "出错了";
	run.ended = new Date().toISOString();
	delete run.halt;
	if (run.session) state.finished(run.project, run.session, run.status === "error");
	for (const a of approvals.values()) if (a.run === run.id) { a.resolve({ allow: false, message: "运行已结束" }); approvals.delete(a.id); }
	emit("run", view(run));
	if (run.session) drain(run.session);
}

/** Codex：codex app-server 上跑一轮（codex-run.ts）。分叉点是节点，Codex 按轮分叉：换成它所在的那一轮 */
function startCodex(run: Live, o: { mode: Run["mode"]; at?: string | null; prompt: string; permission: string; cwd: string; session: string | null }, images: Image[], cx: ReturnType<typeof codex.find>) {
	runs.set(run.id, run);
	emit("run", view(run));
	(async () => {
		try {
			const at = o.mode === "fork" && o.at && cx ? await codex.turnOf(cx, o.at) : null;
			if (o.mode === "fork" && o.at && !at) throw new Error("找不到分叉点在哪一轮");
			const h = await codexRun.launch({ cwd: o.cwd, mode: o.mode, session: o.session, at, prompt: o.prompt, images, permission: o.permission, model: run.model }, {
				event: (ev) => push(run, ev),
				session: (sid) => known(run, sid),
				ask: (tool, input) => ask(run.id, tool, input),
				end: (status, error) => finish(run, status, error ?? null),
			});
			if (run.status === "running") run.halt = h.stop;
			else if (!run.ended) h.stop();
		} catch (e) {
			finish(run, "error", e instanceof Error ? e.message : String(e));
		}
	})();
	return view(run);
}

/** 给网页的：图片只给张数 */
const queueView = (q: Queued) => ({ ...q, images: q.images.length });
export const queued = () => queue.map(queueView);
/** 排着队的消息里的图片：网页上显示缩略图 */
export const queuedImage = (id: string, i: number) => queue.find((q) => q.id === id)?.images[i] ?? null;

export function unqueue(id: string) {
	const i = queue.findIndex((q) => q.id === id);
	if (i < 0) return false;
	queue.splice(i, 1);
	emit("queue", queued());
	return true;
}

/** 这个会话的运行结束了：排着的话按顺序合成一条，续接 */
function drain(session: string) {
	const items = queue.filter((q) => q.session === session);
	if (!items.length) return;
	for (const q of items) queue.splice(queue.indexOf(q), 1);
	emit("queue", queued());
	const last = items[items.length - 1];
	start({ project: last.project, cwd: last.cwd, session, mode: "resume", prompt: items.map((q) => q.prompt).filter((p) => p.trim()).join("\n\n"), images: items.flatMap((q) => q.images), permission: last.permission, model: last.model })
		.catch((e: Error) => emit("queue-error", { session, error: e.message }));
}

export function stop(id: string) {
	const r = runs.get(id);
	if (!r || r.status !== "running") return false;
	r.status = "stopped";
	if (r.child) {
		r.child.kill("SIGINT");
		setTimeout(() => r.child?.kill("SIGKILL"), 5000).unref();
	} else r.halt?.();
	return true;
}

/** MCP 工具发来的确认请求：挂起，等网页上的人点。10 分钟没人点就拒绝 */
export function ask(run: string, tool: string, input: unknown): Promise<{ allow: boolean; message?: string }> {
	return new Promise((resolve) => {
		const id = randomUUID().slice(0, 8);
		const a: Approval = { id, run, tool, input, at: new Date().toISOString(), resolve };
		approvals.set(id, a);
		emit("approval", { id, run, tool, input, at: a.at });
		setTimeout(() => {
			if (!approvals.has(id)) return;
			approvals.delete(id);
			resolve({ allow: false, message: "10 分钟没人确认，拒绝了" });
			emit("approval-done", { id });
		}, 10 * 60_000).unref();
	});
}

export function answer(id: string, allow: boolean, message?: string) {
	const a = approvals.get(id);
	if (!a) return false;
	approvals.delete(id);
	a.resolve({ allow, message });
	emit("approval-done", { id, allow });
	return true;
}

/** mixer 里没在干活：没有运行、排队的消息、待确认（这时重启不会打断谁、也不会丢东西） */
export const idle = () => ![...runs.values()].some((r) => r.status === "running") && !queue.length && !approvals.size;

export const pending = () => [...approvals.values()].map(({ resolve: _r, ...a }) => a);
