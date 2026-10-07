// 运行会话：在本机启动 claude 命令行（用它自己登录的订阅），非交互模式，按行输出 JSON。
//   新会话：在一个文件夹里 claude -p
//   续接：claude -p --resume <id>
//   分叉：再加 --fork-session（新会话 id，原来的不动）；从中间某条 Claude 的消息分叉，再加 --resume-session-at <那条记录的 uuid>（只带到它为止的上下文）
// 一个 claude 进程（host）跑完一轮不退：stdin 一直开着（--input-format stream-json），接着说直接写进去。
// Claude 开了后台任务（后台命令、Monitor、后台子代理）就一直开着，任务的通知会叫醒 Claude 在同一个进程里再跑一轮；
// 没有后台任务、也没在跑了才关 stdin 让它退出（关了 stdin，后台任务会被它杀掉）。一轮是一次运行（Run），网页上和以前一样。
// 要确认的工具调用经 MCP 工具 mcp__mixer__approve 转到网页上（approvals）。
// 同一个会话如果还在别处跑着（记录 90 秒内有写入，而且不是 mixer 自己跑完的），不许直接续接，只能分叉：免得两边同时往一个文件里写。
// 正在 mixer 里跑的会话再「接着说」就排队：这次运行一结束（跑完、出错、被停），排着的话合成一条续接发出去。
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as codex from "./codex.ts";
import * as codexRun from "./codex-run.ts";
import * as models from "./models.ts";
import { sessionFile } from "./sessions.ts";
import * as state from "./state.ts";
import * as usage from "./usage.ts";
import { coalesce, emptyTail, project, step, type Tail } from "../web/src/lib/tail.ts";
import { prompt as visual } from "../web/src/lib/visual.ts";

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
	/** 思考强度（low…max）；null 是用 Claude Code / Codex 的默认 */
	effort: string | null;
	status: RunStatus;
	started: string;
	ended: string | null;
	error: string | null;
	/** 输出了几个事件（事件本身不留：流事件攒进 tail，其余的没人看） */
	events: number;
};

/** Claude 开着的一个后台任务：输出流里的 background_tasks_changed / task_started。tool：开它的工具调用；output：有没有输出文件能看 */
export type Task = { id: string; type: string; description: string; started: string; tool: string | null; output: boolean };
/** 一个 claude 进程（网页上要的）：turn 是正在跑的那一轮（运行 id），null 是 Claude 闲着、等后台任务 */
export type Host = { id: string; project: string; session: string | null; turn: string | null; tasks: Task[] };

/** 消息里带的图片（base64） */
export type Image = { media: string; data: string };

/** 排着队的「接着说」 */
export type Queued = { id: string; project: string; cwd: string; session: string; prompt: string; images: Image[]; permission: string; model: string | null; effort: string | null; at: string };

type Approval = { id: string; run: string; tool: string; input: unknown; at: string; resolve: (d: { allow: boolean; message?: string }) => void };

/**
 * 服务端自己用的：子进程，和输出流攒成的「正在写的那几段」（网页刷新时从这里拿快照）。
 * stopping：点了停止、进程还没退：状态还是 running（这时发的话照样排队，进程真退了才算结束、才发出去）
 * out：推给网页的短事件先过这里（同一段连着来的增量攒着合成一个）
 */
type Live = Run & { host?: Proc; halt?: () => void; tail: Tail; stopping?: boolean; out: ReturnType<typeof coalesce> };
const runs = new Map<string, Live>();
const VISUAL = visual();
/**
 * 服务端自己用的 claude 进程：permission / model 是现在用的（下一轮不一样就先发 control_request 换掉）；
 * files：后台任务开它的工具调用 → 输出文件（工具结果里写的）；result：这一轮的 result 事件（idle 时才结束这一轮）；
 * begun：这一轮真开始了（来过 running）。停掉后台任务之后还会补一个 idle，刚写进去的这一轮还没开始，不能被它结束
 */
type Proc = Host & { child: ChildProcessWithoutNullStreams; cwd: string; cfg: string; permission: string; model: string | null; effort: string | null; files: Map<string, string>; result?: { error: boolean; message: string }; begun: boolean; gone?: boolean };
const hosts = new Map<string, Proc>();
const approvals = new Map<string, Approval>();
const queue: Queued[] = [];
export const TOKEN = randomUUID();
const MCP = join(dirname(new URL(import.meta.url).pathname), "..", "mcp", "approve.ts");

type Emit = (type: string, data: unknown) => void;
let emit: Emit = () => {};
export const onEvent = (f: Emit) => { emit = f; };

const view = (r: Live) => {
	const { host: _p, halt: _h, tail: _t, out: _o, ...rest } = r;
	return rest;
};
const hostView = (h: Proc): Host => ({ id: h.id, project: h.project, session: h.session, turn: h.turn, tasks: h.tasks });
export const hostList = () => [...hosts.values()].map(hostView);
/** 这个会话开着的 claude 进程 */
const hostOf = (session: string) => [...hosts.values()].find((h) => h.session === session && !h.gone);
export const list = () => [...runs.values()].map(view).sort((a, b) => b.started.localeCompare(a.started));
export const get = (id: string) => {
	const r = runs.get(id);
	return r ? view(r) : null;
};

/** 结束了一小时的运行忘掉（tail 留一会儿：刚跑完时页面可能还要拿快照） */
setInterval(() => {
	for (const [id, r] of runs) if (r.ended && Date.now() - Date.parse(r.ended) > 3600_000) runs.delete(id);
}, 600_000).unref();
/** 正在写的那几段的快照；seq 之后的事件网页从推送里接。攒着的增量先推出去，快照里才有 */
export const tail = (id: string) => {
	const r = runs.get(id);
	if (!r) return null;
	r.out.flush();
	return r.tail;
};

export async function start(o: { project: string; cwd: string; session: string | null; mode: Run["mode"]; at?: string | null; prompt: string; images?: Image[]; permission: string; model?: string | null; effort?: string | null; agent?: string | null }) {
	const images = o.images ?? [];
	if (!o.prompt.trim() && !images.length) throw new Error("说点什么");
	if (images.length > 10 || images.some((i) => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(i.media) || typeof i.data !== "string")) throw new Error("图片不对：最多 10 张，png / jpeg / gif / webp");
	if (!["auto", "default", "acceptEdits", "plan", "manual"].includes(o.permission)) throw new Error("不支持的权限模式");
	if (!["new", "resume", "fork"].includes(o.mode)) throw new Error("不认识的方式");
	const model = o.model || null;
	if (model && !/^[a-z][\w.[\]-]*$/i.test(model)) throw new Error("模型名不对");
	const effort = o.effort || null;
	if (effort && !/^[a-z]+$/.test(effort)) throw new Error("思考强度不对");
	const p = { ...o, effort };
	const resume = o.mode === "new" ? null : o.session;
	if (o.mode !== "new" && !resume) throw new Error("要接哪个会话？");
	// 会话 id 要放进命令行参数：只认 UUID（Claude、Codex 都是），免得被当成别的参数
	if (resume && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(resume)) throw new Error("会话 id 不对");
	// 新会话按选的；续接、分叉跟着原会话是谁的
	const cx = resume ? codex.find(resume) : null;
	const agent: Run["agent"] = o.mode === "new" ? (o.agent === "codex" ? "codex" : "claude") : cx ? "codex" : "claude";
	if (o.at && !(agent === "codex" ? /^[\w-]+$/ : /^[0-9a-f-]{36}$/).test(o.at)) throw new Error("分叉点不对");
	if (o.mode === "resume" && resume) {
		// 最近的写入是 mixer 自己的运行（已经跑完）就放行；否则 90 秒内有写入，说明可能在终端里开着
		const ours = [...runs.values()].filter((r) => r.session === resume);
		if (ours.some((r) => r.status === "running")) {
			const q: Queued = { id: randomUUID().slice(0, 8), project: o.project, cwd: o.cwd, session: resume, prompt: o.prompt, images, permission: o.permission, model, effort, at: new Date().toISOString() };
			queue.push(q);
			emit("queue", queued());
			return { queued: queueView(q) };
		}
		// 进程还开着（Claude 闲着、在等后台任务）：直接写进去，接着跑一轮
		const h = agent === "claude" ? hostOf(resume) : undefined;
		if (h) return turn(h, p, images, model);
		const mtime = statSync(cx ? cx.file : sessionFile(o.project, resume)).mtimeMs;
		if (!ours.length && Date.now() - mtime < 90_000 && !state.ourLastWrite(resume, mtime)) {
			throw new Error("这个会话还在别处跑着（90 秒内有写入）：现在只能分叉");
		}
	}
	if (agent === "codex") return startCodex(fresh(randomUUID().slice(0, 8), p, agent, model, resume), o, images, cx);
	return turn(launch(p, model, resume), p, images, model);
}

/** 起一个 claude 进程：stdin 留着写每一轮的消息、control_request。输出一行一个 JSON，按进程处理，事件归到正在跑的那一轮 */
function launch(o: { project: string; cwd: string; mode: Run["mode"]; at?: string | null; permission: string; effort: string | null }, model: string | null, resume: string | null): Proc {
	const id = randomUUID().slice(0, 8);
	const dir = join(tmpdir(), "mixer");
	mkdirSync(dir, { recursive: true });
	const cfg = join(dir, `mcp-${id}.json`);
	// MIXER_RUN 是进程的 id：确认请求来了归到它正在跑的那一轮（ask）
	writeFileSync(cfg, JSON.stringify({ mcpServers: { mixer: { command: process.execPath, args: [MCP], env: { MIXER_URL: `http://127.0.0.1:${process.env.MIXER_PORT ?? 4848}`, MIXER_TOKEN: TOKEN, MIXER_RUN: id } } } }));
	// --thinking-display summarized：思考给摘要（流里有、也写进记录）。不加的话 -p 下大多只有签名、没有文字。帮助里没写，试过可用
	const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--thinking-display", "summarized", "--permission-mode", o.permission, "--permission-prompt-tool", "mcp__mixer__approve", "--mcp-config", cfg];
	// 告诉 Claude 网页能画 ```ui 图解（visual.ts）。只在 mixer 起的进程里带：终端里画不出来
	args.push("--append-system-prompt", VISUAL);
	if (model) args.push("--model", model);
	if (resume) args.push("--resume", resume);
	if (o.effort) args.push("--effort", o.effort);
	if (o.mode === "fork") args.push("--fork-session", ...(o.at ? ["--resume-session-at", o.at] : []));
	// CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS：每一轮开始、结束有 session_state_changed（running / idle），通知叫醒的那一轮也有
	const child = spawn("claude", args, { cwd: o.cwd, env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
	const h: Proc = { id, project: o.project, session: resume && o.mode === "resume" ? resume : null, turn: null, tasks: [], child, cwd: o.cwd, cfg, permission: o.permission, model, effort: o.effort, files: new Map(), begun: false };
	hosts.set(id, h);
	// claude 一开始就退出了（参数不对、没登录）：stdin 写不进去是 EPIPE，结果看 close
	child.stdin.on("error", () => {});
	let buf = "";
	// 按 utf8 解码再拼：一个汉字可能被切在两块之间
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buf += chunk;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			line(h, buf.slice(0, i));
			buf = buf.slice(i + 1);
		}
	});
	let err = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (c: string) => { err = (err + c).slice(-4000); });
	// 起不来（找不到 claude）：原因在 error 里
	child.on("error", (e) => gone(h, `起不来 claude：${e.message}`));
	// close：输出都读完了才算结束（exit 时 stdout 里可能还有没读的）；最后一行没有换行也算
	child.on("close", (code, signal) => {
		line(h, buf);
		buf = "";
		gone(h, code === 0 ? null : err.trim() || `退出码 ${code ?? signal}`);
	});
	// 进程退了，输出却一直没关（被它起的后台进程拿着）：等 5 秒按退出算
	child.on("exit", (code, signal) => {
		setTimeout(() => gone(h, code === 0 ? null : err.trim() || `退出码 ${code ?? signal}`), 5000).unref();
	});
	return h;
}

const write = (h: Proc, msg: unknown) => { h.child.stdin.write(`${JSON.stringify(msg)}\n`); };
const control = (h: Proc, request: Record<string, unknown>) => write(h, { type: "control_request", request_id: randomUUID(), request });

/** 在这个进程里跑一轮：权限、模型、思考强度和上一轮不一样先换掉，再写进这一轮的消息 */
function turn(h: Proc, o: { project: string; cwd: string; session: string | null; mode: Run["mode"]; at?: string | null; prompt: string; permission: string; effort: string | null }, images: Image[], model: string | null) {
	const run = fresh(randomUUID().slice(0, 8), o, "claude", model, h.session);
	run.host = h;
	runs.set(run.id, run);
	h.turn = run.id;
	h.begun = false;
	if (h.permission !== o.permission) {
		control(h, { subtype: "set_permission_mode", mode: o.permission });
		h.permission = o.permission;
	}
	if (h.model !== model) {
		control(h, { subtype: "set_model", model: model ?? "default" });
		h.model = model;
	}
	// 带图片：文字块 + 图片块；不带就是一段文字
	// 思考强度没有 set_xxx：apply_flag_settings 的 effortLevel（null 是回到设置里的）。帮助里没写，试过可用
	if (h.effort !== o.effort) {
		control(h, { subtype: "apply_flag_settings", settings: { effortLevel: o.effort } });
		h.effort = o.effort;
	}
	const content = images.length ? [...(o.prompt.trim() ? [{ type: "text", text: o.prompt }] : []), ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media, data: i.data } }))] : o.prompt;
	write(h, { type: "user", message: { role: "user", content } });
	emit("run", view(run));
	emit("host", hostView(h));
	return view(run);
}

/** 进程输出的一行 */
function line(h: Proc, raw: string) {
	if (!raw.trim()) return;
	let ev: Record<string, unknown>;
	try { ev = JSON.parse(raw); } catch { return; }
	if (ev.type === "system" && ev.subtype === "session_state_changed") {
		// 没写消息它自己跑起来了：后台任务的通知叫醒了 Claude，另起一轮
		if (ev.state === "running") h.turn ? (h.begun = true) : wake(h);
		if (ev.state === "idle") settle(h);
		return;
	}
	const run = h.turn ? runs.get(h.turn) : undefined;
	// 新会话、分叉的 id 到这时才知道：马上告诉网页，不然它对不上这次运行，会把正在写的会话当成终端里开着
	if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
		if (h.session !== ev.session_id) {
			h.session = ev.session_id;
			emit("host", hostView(h));
		}
		if (run) known(run, ev.session_id);
		if (Array.isArray(ev.skills)) state.learnCaps(h.project, { skills: ev.skills.map(String), plugins: Array.isArray(ev.plugins) ? (ev.plugins as { name: string; path: string }[]).map((p) => ({ name: String(p.name), path: String(p.path) })) : [] });
		models.sawVersion(ev.claude_code_version);
	}
	if (ev.type === "system" && (ev.subtype === "background_tasks_changed" || ev.subtype === "task_started")) tasks(h, ev);
	// 后台任务的输出文件在开它的那个工具调用的结果里
	if (ev.type === "user") for (const b of ((ev.message as { content?: unknown })?.content ?? []) as { type?: string; tool_use_id?: string; content?: unknown }[]) {
		const m = b?.type === "tool_result" && typeof b.content === "string" ? /Output is being written to: (\S+\.output)/.exec(b.content) : null;
		if (m && b.tool_use_id) {
			h.files.set(b.tool_use_id, m[1]);
			const t = h.tasks.find((x) => x.tool === b.tool_use_id);
			if (t) {
				t.output = true;
				emit("host", hostView(h));
			}
		}
	}
	if (ev.type === "result") {
		if (ev.modelUsage && typeof ev.modelUsage === "object")
			for (const [model, u] of Object.entries(ev.modelUsage as Record<string, { contextWindow?: number }>)) if (u?.contextWindow) state.learnWindow(model, u.contextWindow);
		h.result = { error: ev.is_error === true, message: Array.isArray(ev.errors) && ev.errors.length ? ev.errors.map(String).join("\n") : typeof ev.result === "string" ? ev.result : "" };
	}
	if (ev.type === "rate_limit_event") {
		const w = (ev.rate_limit_info as { unifiedWindows?: unknown } | undefined)?.unifiedWindows;
		if (w && typeof w === "object") usage.claude(w as Record<string, unknown>);
	}
	if (run) push(run, ev);
}

/** 后台任务变了：background_tasks_changed 是整张表（开始时间按第一次看到的算），task_started 补上开它的工具调用 */
function tasks(h: Proc, ev: Record<string, unknown>) {
	if (ev.subtype === "task_started") {
		const t = h.tasks.find((x) => x.id === ev.task_id);
		if (t && typeof ev.tool_use_id === "string") t.tool = ev.tool_use_id;
	} else {
		const now = new Date().toISOString();
		h.tasks = ((ev.tasks ?? []) as { task_id: string; task_type?: string; description?: string }[]).map((x) => {
			const old = h.tasks.find((t) => t.id === x.task_id);
			return { id: x.task_id, type: String(x.task_type ?? ""), description: String(x.description ?? ""), started: old?.started ?? now, tool: old?.tool ?? null, output: false };
		});
		// 都结束了、Claude 也闲着：通知会叫醒它（接着就是 running）；15 秒还没动静就关
		if (!h.tasks.length && !h.turn) setTimeout(() => close(h), 15_000).unref();
	}
	for (const t of h.tasks) t.output = !!t.tool && h.files.has(t.tool);
	emit("host", hostView(h));
}

/** 通知叫醒的一轮：没有人说的话，权限、模型接着用进程现在的 */
function wake(h: Proc) {
	if (!h.session) return;
	const run = fresh(randomUUID().slice(0, 8), { project: h.project, cwd: h.cwd, session: h.session, mode: "resume", prompt: "", permission: h.permission, effort: h.effort }, "claude", h.model, h.session);
	run.host = h;
	runs.set(run.id, run);
	h.turn = run.id;
	h.begun = true;
	emit("run", view(run));
	emit("host", hostView(h));
}

/** 一轮结束了（idle）：结束这次运行（会接着发排队的），然后看要不要关进程 */
function settle(h: Proc) {
	if (h.turn && !h.begun) return;
	const run = h.turn ? runs.get(h.turn) : undefined;
	const r = h.result;
	h.result = undefined;
	if (run) {
		h.turn = null;
		finish(run, r?.error ? "error" : "done", r?.message || "出错了");
	}
	close(h);
	if (!h.gone) emit("host", hostView(h));
}

/** 没在跑、也没有后台任务了：关 stdin，进程自己退 */
function close(h: Proc) {
	if (h.gone || h.turn || h.tasks.length) return;
	h.gone = true;
	h.child.stdin.end();
}

/** 进程退了：从表里拿掉（排队的接着发要另起一个），正在跑的那一轮按退出码结束 */
function gone(h: Proc, error: string | null) {
	if (!hosts.has(h.id)) return;
	hosts.delete(h.id);
	h.gone = true;
	rmSync(h.cfg, { force: true });
	emit("host", { id: h.id, gone: true });
	const run = h.turn ? runs.get(h.turn) : undefined;
	h.turn = null;
	if (run) finish(run, error ? "error" : "done", error ?? "");
}

/** 停一个后台任务（Claude 不会被叫醒） */
export function stopTask(host: string, task: string) {
	const h = hosts.get(host);
	if (!h || h.gone || !h.tasks.some((t) => t.id === task)) return false;
	control(h, { subtype: "stop_task", task_id: task });
	return true;
}

/** 后台任务输出的最后一段（最多 16KB）：只给 claude 自己说的那个文件 */
export function taskOutput(host: string, task: string) {
	const h = hosts.get(host);
	const t = h?.tasks.find((x) => x.id === task);
	const file = t?.tool ? h?.files.get(t.tool) : undefined;
	if (!file) return null;
	try {
		const size = statSync(file).size;
		const fd = openSync(file, "r");
		try {
			const n = Math.min(size, 16_384);
			const b = Buffer.alloc(n);
			readSync(fd, b, 0, n, size - n);
			const text = b.toString("utf8");
			return { text: n < size ? text.slice(text.indexOf("\n") + 1) : text, cut: n < size };
		} finally {
			closeSync(fd);
		}
	} catch {
		return { text: "", cut: false };
	}
}

/** 一次运行的样子（两种 agent 一样） */
function fresh(id: string, o: { project: string; cwd: string; session: string | null; mode: Run["mode"]; at?: string | null; prompt: string; permission: string; effort: string | null }, agent: Run["agent"], model: string | null, resume: string | null): Live {
	const run: Live = {
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
		effort: o.effort,
		started: new Date().toISOString(),
		ended: null,
		error: null,
		events: 0,
		tail: emptyTail(),
		out: coalesce((e) => {
			run.tail = step(run.tail, e, Date.now());
			emit("run-event", { id, seq: run.tail.seq, event: e });
		}, HOLD),
	};
	return run;
}

/** 会话 id 知道了（续接的一开始就知道；新会话、分叉的这时才有）：马上告诉网页，不然它对不上这次运行，会把正在写的会话当成终端里开着 */
function known(run: Live, session: string) {
	if (run.session !== session) {
		run.session = session;
		emit("run", view(run));
	}
	state.chooseModel(session, run.model, run.effort);
	// 在 mixer 里跑过的会话放进工作区（新会话、分叉的文件夹放到最上面）
	if (state.addToWorkspace(run.project, run.cwd, session)) emit("workspace", null);
}

/** 增量最多攒这么久再推：一个字一个事件的话，包在外面的比字本身还长 */
const HOLD = 60;

/**
 * 一个输出事件：缩成短事件（用不着的扔掉），同一段连着的增量攒一下（HOLD），再攒进「正在写的那几段」、带上序号推给网页，
 * 网页按序号接在快照后面，接不上就重新拿快照。序号只数推出去的，是连着的
 */
function push(run: Live, ev: Record<string, unknown>) {
	run.events++;
	const e = project(ev);
	if (e) run.out.add(e);
}

/** 运行结束（跑完、出错、被停）：记下来、作废它的确认请求、接着发排队的。点过停止的一律算停止 */
function finish(run: Live, status: "done" | "error" | "stopped", error: string | null) {
	if (run.ended) return;
	run.out.flush();
	run.status = run.stopping ? "stopped" : status;
	delete run.stopping;
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
			const h = await codexRun.launch({ cwd: o.cwd, mode: o.mode, session: o.session, at, prompt: o.prompt, images, permission: o.permission, model: run.model, effort: run.effort }, {
				event: (ev) => push(run, ev),
				session: (sid) => known(run, sid),
				ask: (tool, input) => ask(run.id, tool, input),
				end: (status, error) => finish(run, status, error ?? null),
			});
			// 起的时候点了停止：现在才有 turn 能停
			if (!run.ended) run.halt = h.stop;
			if (run.stopping) h.stop();
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
	start({ project: last.project, cwd: last.cwd, session, mode: "resume", prompt: items.map((q) => q.prompt).filter((p) => p.trim()).join("\n\n"), images: items.flatMap((q) => q.images), permission: last.permission, model: last.model, effort: last.effort })
		.catch((e: Error) => emit("queue-error", { session, error: e.message }));
}

/**
 * 停：claude 发 interrupt（只停这一轮，后台任务接着跑；10 秒没停下来就 SIGINT 整个进程，再 5 秒 SIGKILL），Codex 发 turn/interrupt。
 * 这一轮真结束了（idle、进程退出；Codex 是 turn/completed）才算，免得同一个会话又开一次运行、两边一起写；这期间发的话排队。Codex 10 秒没回音也按停止结束
 */
export function stop(id: string) {
	const r = runs.get(id);
	if (!r || r.status !== "running") return false;
	if (r.stopping) return true;
	r.stopping = true;
	emit("run", view(r));
	const h = r.host;
	if (h) {
		control(h, { subtype: "interrupt" });
		setTimeout(() => {
			if (r.ended) return;
			h.child.kill("SIGINT");
			setTimeout(() => h.child.kill("SIGKILL"), 5000).unref();
		}, 10_000).unref();
	} else {
		r.halt?.();
		setTimeout(() => finish(r, "stopped", null), 10_000).unref();
	}
	return true;
}

/**
 * MCP 工具发来的确认请求：挂起，等网页上的人点。10 分钟没人点就拒绝。
 * gone：问的那边不等了（MCP 工具的连接断了，claude 已经退出）：卡片收掉，也不再挡着重启
 */
export function ask(from: string, tool: string, input: unknown, gone?: AbortSignal): Promise<{ allow: boolean; message?: string }> {
	// claude 那边来的是进程的 id：归到它正在跑的那一轮
	const run = hosts.get(from)?.turn ?? from;
	return new Promise((resolve) => {
		const id = randomUUID().slice(0, 8);
		const a: Approval = { id, run, tool, input, at: new Date().toISOString(), resolve };
		approvals.set(id, a);
		emit("approval", { id, run, tool, input, at: a.at });
		const drop = (message: string) => {
			if (!approvals.has(id)) return;
			approvals.delete(id);
			resolve({ allow: false, message });
			emit("approval-done", { id });
		};
		setTimeout(() => drop("10 分钟没人确认，拒绝了"), 10 * 60_000).unref();
		gone?.addEventListener("abort", () => drop("问的那边断开了"), { once: true });
		if (gone?.aborted) drop("问的那边断开了");
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

/** mixer 里没在干活：没有运行、排队的消息、待确认、开着的 claude 进程（等后台任务的：重启会把后台任务一起杀掉） */
export const idle = () => ![...runs.values()].some((r) => r.status === "running") && !queue.length && !approvals.size && !hosts.size;

/** 这个会话在 mixer 里还有事（等确认、在跑、正从它分叉、排着队）：这时不许删，返回原因 */
export function busy(session: string): string | null {
	const mine = [...runs.values()].filter((r) => r.status === "running" && (r.session === session || r.from === session));
	if ([...approvals.values()].some((a) => mine.some((r) => r.id === a.run))) return "这个会话有待确认的请求：先处理了再删";
	if (mine.length) return "这个会话正在 mixer 里运行：停止后再删";
	if (hostOf(session)?.tasks.length) return "这个会话有后台任务在跑：停掉后再删";
	if (queue.some((q) => q.session === session)) return "这个会话还有排队的消息：取消后再删";
	return null;
}

export const pending = () => [...approvals.values()].map(({ resolve: _r, ...a }) => a);
/** 页面连上时的 hello（sse.ts）里这边的：运行、开着的 claude 进程、确认请求、排队，在跑的那几次正在写的那几段（攒着的增量先推出去） */
export const snapshot = () => ({
	runs: list(),
	hosts: hostList(),
	approvals: pending(),
	queue: queued(),
	tails: Object.fromEntries([...runs.values()].flatMap((r) => (r.status === "running" ? [[r.id, tail(r.id)]] : []))),
});
