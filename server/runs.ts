// 运行会话：在本机启动 claude 命令行（用它自己登录的订阅），非交互模式，按行输出 JSON。
//   新会话：在一个文件夹里 claude -p --session-id <mixer 定的 id>
//   续接：claude -p --resume <id>
//   分叉：再加 --fork-session --session-id <mixer 定的新 id>（原来的不动）；从中间某条 Claude 的消息分叉，再加 --resume-session-at <那条记录的 uuid>（只带到它为止的上下文）
// 会话 id 起进程之前就定了：运行、进程、确认请求、工作区、分叉的来处（state.fork）一开始就有，不等 init。
// 一个 claude 进程（host）跑完一轮不退：stdin 一直开着（--input-format stream-json），接着说直接写进去。
// Claude 开了后台任务（后台命令、Monitor、后台子代理）就一直开着，任务的通知会叫醒 Claude 在同一个进程里再跑一轮；
// 没有后台任务、也没在跑了才关 stdin 让它退出（关了 stdin，后台任务会被它杀掉）。
// 写进去的每条消息带一个 uuid，命令行按它报这条的下落（command_lifecycle：started、completed、cancelled…）：一条消息就是一次运行（Run），
// started 到 completed / cancelled 是它在跑；通知叫醒的一轮（没有消息）从它的输出开始、到它的 result 结束。
// session_state_changed 的 idle 要等后台子代理全跑完才来（可能半小时），只拿来决定关不关进程，不拿来结束运行。
// 要确认的工具调用（--permission-prompt-tool stdio）：命令行在 stdout 发 can_use_tool 的 control_request，转到网页上（approvals），人点了在 stdin 回 control_response。
// 确认请求归会话、不归哪一轮：后台子代理在 Claude 闲着时也会来问（带 agent_id）。
// 同一个会话在 mixer 外面开着（终端、IDE、桌面版：terminals.ts，照 Claude Code、Codex 自己记的算，在跑闲着都算），不许直接续接，只能分叉：免得两边同时往一个文件里写。
// 正在 mixer 里跑的会话再「接着说」就排队：这次运行一结束（跑完、出错、被停），排着的话合成一条续接发出去。
// Claude 闲着、只是后台任务开着进程：不排队，直接写进去马上跑。
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as codex from "./codex.ts";
import * as codexRun from "./codex-run.ts";
import { say } from "./log.ts";
import * as models from "./models.ts";
import { locate, version } from "./sessions.ts";
import * as state from "./state.ts";
import * as terminals from "./terminals.ts";
import * as usage from "./usage.ts";
import { coalesce, emptyTail, project, step, type Tail } from "../shared/tail.ts";
import { prompt as visual } from "../shared/visual.ts";

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
	/** 这条消息在记录里的 uuid：claude 的是写进 stdin 时带的（记录里那条就是它）；Codex 的是它给的 item id（开始跑了才知道）；叫醒的那一轮没有消息，null */
	uuid: string | null;
	/** 带着网页发的哪几条（发的时候网页给的 uuid）：一条就是它自己，排着队的几条合成一条时是几个。网页的发件箱按它认自己发的那条到哪了 */
	merged: string[];
	/** 带了几张图（图本身在 Live 的 pics：记录里还没有时，网页先从这里拿） */
	images: number;
	/** 结束时会话记录写到哪了（「epoch:rev」）：网页的数据到了这里，这次运行写的就都拿到了。还没算出来没有这一项，没有记录是 null */
	version?: string | null;
};

/**
 * Claude 开着的一个后台任务：background_tasks_changed（整张表）里的。
 * ambient：不算在干活的（只给后台的杂事、看着更新的监听）：命令行说别算进「在忙」，网页上不列、不留着进程、不挡重启
 */
type Job = { id: string; type: string; description: string; started: string; ambient: boolean };
/** task_started 里的：开它的工具调用、说明（子代理来问时卡片上写是哪个）。和 background_tasks_changed 谁先来都行，按任务 id 另记一份 */
type Spawn = { tool: string | null; ambient: boolean; description: string };
/** 给网页的：tool 是开它的工具调用；output 是能看输出（后台命令、Monitor：get_task_output 只认 local_bash） */
export type Task = { id: string; type: string; description: string; started: string; tool: string | null; output: boolean };
/** 一个 claude 进程（网页上要的）：turn 是正在跑的那一轮（运行 id），null 是 Claude 闲着、等后台任务 */
export type Host = { id: string; project: string; session: string; turn: string | null; tasks: Task[] };

/** 消息里带的图片（base64） */
export type Image = { media: string; data: string };

/** 排着队的「接着说」。uuid：网页发的时候给的 */
export type Queued = { id: string; uuid: string; project: string; cwd: string; session: string; prompt: string; images: Image[]; permission: string; model: string | null; effort: string | null; at: string };

/**
 * 一次运行要的（start 里理好的）：模型、思考强度、图片都在里面。sid：新会话、分叉的 claude 由 mixer 定的会话 id（续接、Codex 是 null）。
 * uuid：写进 stdin 时带的（claude 的记录里那条就是它）；merged：带着网页发的哪几条
 */
type Params = { project: string; cwd: string; session: string | null; sid: string | null; mode: Run["mode"]; at?: string | null; prompt: string; images: Image[]; permission: string; model: string | null; effort: string | null; uuid: string; merged: string[] };

/** cancelled：问的那边不等了（claude 发了 control_cancel_request、进程退了），不用回 */
type Decision = { allow: boolean; message?: string; cancelled?: boolean };
/**
 * 给网页的确认请求：归哪个会话；cwd：路径写成相对的用。tool_use：是哪个工具调用（Codex 的没有）；
 * agent：子代理在问时是哪个（id 是子代理记录 agent-<id>.jsonl 的，description 是开它时的说明）
 */
export type Approval = { id: string; project: string; cwd: string; session: string; tool: string; input: unknown; at: string; toolUse: string | null; agent: { id: string; description: string } | null };
/**
 * by：谁问的、跟着谁作废：claude 的是进程 id（进程退了才作废：这一轮完了，后台子代理还可能在等），Codex 的是运行 id（这一轮完了就作废）。
 * req：claude 的 control_request 的 request_id（control_cancel_request 按它认）。timer：10 分钟没人点就拒绝
 */
type Asking = Approval & { by: string; req: string | null; resolve: (d: Decision) => void; timer: NodeJS.Timeout };

/**
 * 服务端自己用的：子进程，和输出流攒成的「正在写的那几段」（网页刷新时从这里拿快照）。
 * stopping：点了停止、还没停下来：状态还是 running（这时发的话照样排队，真停下来了才算结束、才发出去）
 * out：推给网页的短事件先过这里（同一段连着来的增量攒着合成一个）
 * halt：停这一轮（claude 发 interrupt，Codex 发 turn/interrupt）
 */
type Live = Run & { halt?: () => void; tail: Tail; stopping?: boolean; out: ReturnType<typeof coalesce>; pics: Image[] };
const runs = new Map<string, Live>();
const VISUAL = visual();
/** result 事件里要的：出没出错、错误信息 */
type Result = { error: boolean; message: string };
/** 写进去、还没有下落的一条消息：uuid 是写的时候给的（记录里的 uuid 也是它）；started：命令行开始跑它了；result：它那一轮的 result */
type Cmd = { uuid: string; run: Live; started: boolean; result?: Result };
/**
 * 服务端自己用的 claude 进程：permission / model 是现在用的（下一轮不一样就先发 control_request 换掉）；
 * spawns：task_started 记的（任务 id → 开它的工具调用、说明）；replies：发出去等回音的 control_request（request_id → 回调）；
 * cmds：写进去还没结束的消息（按写的顺序）；wake：通知叫醒的那一轮（没有消息），没有是 null
 */
type Proc = Omit<Host, "tasks" | "turn"> & { tasks: Job[]; spawns: Map<string, Spawn>; replies: Map<string, Reply>; child: ChildProcessWithoutNullStreams; cwd: string; permission: string; model: string | null; effort: string | null; cmds: Cmd[]; wake: Live | null; gone?: boolean };
type Reply = { ok: (r: Record<string, unknown>) => void; fail: (e: Error) => void };
const hosts = new Map<string, Proc>();
const approvals = new Map<string, Asking>();
const queue: Queued[] = [];

type Emit = (type: string, data: unknown) => void;
let emit: Emit = () => {};
export const onEvent = (f: Emit) => { emit = f; };

const view = (r: Live): Run => {
	const { halt: _h, tail: _t, out: _o, pics: _p, ...rest } = r;
	return rest;
};
/** 正在跑的那次运行（输出事件归它）：开始了的消息（后开始的优先）、叫醒的那一轮、写进去还没开始的 */
const current = (h: Proc) => h.cmds.findLast((c) => c.started)?.run ?? h.wake ?? h.cmds[0]?.run;
/** 算在干活的后台任务（ambient 的不算：两边哪个说了都算） */
const active = (h: Proc) => h.tasks.filter((t) => !t.ambient && !h.spawns.get(t.id)?.ambient);
const hostView = (h: Proc): Host => ({
	id: h.id,
	project: h.project,
	session: h.session,
	turn: current(h)?.id ?? null,
	tasks: active(h).map((t) => ({ id: t.id, type: t.type, description: t.description, started: t.started, tool: h.spawns.get(t.id)?.tool ?? null, output: t.type === "local_bash" })),
});
const hostList = () => [...hosts.values()].map(hostView);
/** 这个会话开着的 claude 进程 */
const hostOf = (session: string) => [...hosts.values()].find((h) => h.session === session && !h.gone);
export const list = () => [...runs.values()].map(view).sort((a, b) => b.started.localeCompare(a.started));

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 发一条（新会话、续接、分叉）。uuid：网页给这条的（不给就现给一个），claude 的记录里那条就用它；merged：排队的几条合成的这一条带着哪几条（drain 用）
 */
export async function start(o: { project: string; cwd: string; session: string | null; mode: Run["mode"]; at?: string | null; prompt: string; images?: Image[]; permission: string; model?: string | null; effort?: string | null; agent?: string | null; uuid?: string | null; merged?: string[] }) {
	const images = o.images ?? [];
	const uuid = o.uuid || randomUUID();
	// 要写进命令行的 stdin、记录里：只认 UUID。同一条发两遍（页面重试）不认
	if (!UUID.test(uuid)) throw new Error("消息的 uuid 不对");
	if ([...runs.values()].some((r) => r.merged.includes(uuid) || r.uuid === uuid) || queue.some((q) => q.uuid === uuid)) throw Object.assign(new Error("这条已经发过了"), { status: 409 });
	if (!o.prompt.trim() && !images.length) throw new Error("说点什么");
	if (images.length > 10 || images.some((i) => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(i.media) || typeof i.data !== "string")) throw new Error("图片不对：最多 10 张，png / jpeg / gif / webp");
	if (!["auto", "default", "acceptEdits", "plan", "manual"].includes(o.permission)) throw new Error("不支持的权限模式");
	if (!["new", "resume", "fork"].includes(o.mode)) throw new Error("不认识的方式");
	const model = o.model || null;
	if (model && !/^[a-z][\w.[\]-]*$/i.test(model)) throw new Error("模型名不对");
	const effort = o.effort || null;
	if (effort && !/^[a-z]+$/.test(effort)) throw new Error("思考强度不对");
	const resume = o.mode === "new" ? null : o.session;
	if (o.mode !== "new" && !resume) throw new Error("要接哪个会话？");
	// 会话 id 要放进命令行参数：只认 UUID（Claude、Codex 都是），免得被当成别的参数
	if (resume && !UUID.test(resume)) throw new Error("会话 id 不对");
	// 新会话按选的；续接、分叉跟着原会话是谁的
	const cx = resume ? (locate(o.project, resume)?.cx ?? null) : null;
	const agent: Run["agent"] = o.mode === "new" ? (o.agent === "codex" ? "codex" : "claude") : cx ? "codex" : "claude";
	if (o.at && !(agent === "codex" ? /^[\w-]+$/ : /^[0-9a-f-]{36}$/).test(o.at)) throw new Error("分叉点不对");
	// 新会话、分叉的 claude：会话 id 由 mixer 定（--session-id）。Codex 的线程 id 是 app-server 给的
	const p: Params = { ...o, model, effort, images, sid: agent === "claude" && o.mode !== "resume" ? randomUUID() : null, uuid, merged: o.merged ?? [uuid] };
	if (o.mode === "resume" && resume) {
		// 在 mixer 外面开着（当场查）就挡，不看 mixer 里有没有它的运行、进程：mixer 里跑完之后在终端里接着聊的、两边都开着的一样。
		// 查完到起进程之间不能再 await：不然同时来的两条续接会都起一个进程
		if (await terminals.held(resume)) throw Object.assign(new Error("这个会话在终端里开着：现在只能分叉"), { status: 409 });
		const ours = [...runs.values()].filter((r) => r.session === resume);
		if (ours.some((r) => r.status === "running")) {
			const q: Queued = { id: randomUUID().slice(0, 8), uuid, project: o.project, cwd: o.cwd, session: resume, prompt: o.prompt, images, permission: o.permission, model, effort, at: new Date().toISOString() };
			queue.push(q);
			emit("queue", queued());
			return { queued: queueView(q) };
		}
		// 进程还开着（Claude 闲着、只是后台任务开着它）：直接写进去，马上跑
		const h = agent === "claude" ? hostOf(resume) : undefined;
		if (h) return turn(h, p);
	}
	if (agent === "codex") return startCodex(fresh(p, agent), p, cx);
	return turn(launch(p), p);
}

/** 起一个 claude 进程：stdin 留着写每一轮的消息、control_request。输出一行一个 JSON，按进程处理，事件归到正在跑的那一轮 */
function launch(o: Params): Proc {
	const id = randomUUID().slice(0, 8);
	const resume = o.mode === "new" ? null : o.session;
	const session = o.mode === "resume" ? o.session : o.sid;
	if (!session) throw new Error("没有会话 id");
	// --thinking-display summarized：思考给摘要（流里有、也写进记录）。不加的话 -p 下大多只有签名、没有文字。帮助里没写，试过可用
	// --permission-prompt-tool stdio：要确认的在 stdout 发 can_use_tool，答案写回 stdin（Agent SDK 走的就是这条）
	const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--thinking-display", "summarized", "--permission-mode", o.permission, "--permission-prompt-tool", "stdio"];
	// 告诉 Claude 网页能画 ```ui 图解（visual.ts）。只在 mixer 起的进程里带：终端里画不出来
	args.push("--append-system-prompt", VISUAL);
	if (o.model) args.push("--model", o.model);
	if (o.effort) args.push("--effort", o.effort);
	if (resume) args.push("--resume", resume);
	// 新会话、分叉的 id 由 mixer 定：--session-id 和 --resume 一起用时要带 --fork-session（命令行只拦不带它的）
	if (o.mode === "fork") args.push("--fork-session", ...(o.at ? ["--resume-session-at", o.at] : []));
	if (o.mode !== "resume") args.push("--session-id", session);
	// CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS：会话忙起来、整个停下来（连后台子代理）有 session_state_changed（running / idle）
	const child = spawn("claude", args, { cwd: o.cwd, env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
	// mixer 自己的 claude：它在 ~/.claude/sessions 的登记不算「在 mixer 外面开着」
	if (child.pid) terminals.mine.add(child.pid);
	const h: Proc = { id, project: o.project, session, tasks: [], spawns: new Map(), replies: new Map(), child, cwd: o.cwd, permission: o.permission, model: o.model, effort: o.effort, cmds: [], wake: null };
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

/** 写进这个进程一条消息（一次运行）：权限、模型、思考强度和上一轮不一样先换掉，再写消息，带上 uuid 认它的下落 */
function turn(h: Proc, o: Params) {
	const run = fresh(o, "claude");
	run.halt = () => interrupt(h, run);
	runs.set(run.id, run);
	const uuid = o.uuid;
	h.cmds.push({ uuid, run, started: false });
	if (h.permission !== o.permission) {
		control(h, { subtype: "set_permission_mode", mode: o.permission });
		h.permission = o.permission;
	}
	if (h.model !== o.model) {
		control(h, { subtype: "set_model", model: o.model ?? "default" });
		h.model = o.model;
	}
	// 思考强度没有 set_xxx：apply_flag_settings 的 effortLevel（null 是回到设置里的）。帮助里没写，试过可用
	if (h.effort !== o.effort) {
		control(h, { subtype: "apply_flag_settings", settings: { effortLevel: o.effort } });
		h.effort = o.effort;
	}
	// 带图片：文字块 + 图片块；不带就是一段文字
	const content = o.images.length ? [...(o.prompt.trim() ? [{ type: "text", text: o.prompt }] : []), ...o.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media, data: i.data } }))] : o.prompt;
	write(h, { type: "user", uuid, message: { role: "user", content } });
	emit("run", view(run));
	emit("host", hostView(h));
	known(run, h.session);
	return view(run);
}

/** 进程输出的一行 */
function line(h: Proc, raw: string) {
	if (!raw.trim()) return;
	let ev: Record<string, unknown>;
	try { ev = JSON.parse(raw); } catch { return; }
	// idle：整个会话（连后台子代理）都停了，看要不要关进程。running 不看：后台子代理开着时会话一直不 idle，叫醒的那一轮前面也就没有 running
	if (ev.type === "system" && ev.subtype === "session_state_changed") {
		if (ev.state === "idle") settle(h);
		return;
	}
	if (ev.type === "command_lifecycle") return lifecycle(h, ev);
	if (ev.type === "control_response") return reply(h, ev);
	if (ev.type === "control_request") return asked(h, ev);
	if (ev.type === "control_cancel_request") return withdrawn(h, ev);
	// 没有消息在跑却有了主线的输出（子代理的带 parent_tool_use_id）：后台任务的通知叫醒了 Claude，另起一轮
	if ((ev.type === "stream_event" || ev.type === "assistant") && ev.parent_tool_use_id == null && !h.cmds.length && !h.wake) wake(h);
	const run = current(h);
	if (ev.type === "system" && ev.subtype === "init") {
		// 会话 id 是起进程时给的（--session-id / --resume），init 里的应该一样：不一样是命令行改了规矩，记一笔
		if (ev.session_id !== h.session) say(`claude 报的会话 ${String(ev.session_id)} 不是起它时给的 ${h.session}`);
		models.sawVersion(ev.claude_code_version);
		if (Array.isArray(ev.skills)) state.learnCaps(h.project, { skills: ev.skills.map(String), plugins: Array.isArray(ev.plugins) ? (ev.plugins as { name: string; path: string }[]).map((p) => ({ name: String(p.name), path: String(p.path) })) : [] });
	}
	if (ev.type === "system" && (ev.subtype === "background_tasks_changed" || ev.subtype === "task_started")) tasks(h, ev);
	if (ev.type === "result") {
		if (ev.modelUsage && typeof ev.modelUsage === "object")
			for (const [model, u] of Object.entries(ev.modelUsage as Record<string, { contextWindow?: number }>)) if (u?.contextWindow) state.learnWindow(model, u.contextWindow);
		result(h, ev);
	}
	if (ev.type === "rate_limit_event") {
		const w = (ev.rate_limit_info as { unifiedWindows?: unknown } | undefined)?.unifiedWindows;
		if (w && typeof w === "object") usage.claude(w as Record<string, unknown>);
	}
	if (run && !run.ended) push(run, ev);
}

/**
 * 一轮的 result：记到它带的那几条消息上（几条排着的被并成一轮时是几个 uuid），等它们各自的 completed 再结束；
 * 叫醒的那一轮（origin 是 task-notification，没有 uuid）这时就结束了。在跑的是叫醒的那一轮时，result 就是它的结尾
 */
function result(h: Proc, ev: Record<string, unknown>) {
	const r: Result = { error: ev.is_error === true, message: Array.isArray(ev.errors) && ev.errors.length ? ev.errors.map(String).join("\n") : typeof ev.result === "string" ? ev.result : "" };
	const ids = Array.isArray(ev.user_message_uuids) ? ev.user_message_uuids.map(String) : typeof ev.user_message_uuid === "string" ? [ev.user_message_uuid] : [];
	for (const c of h.cmds) if (ids.includes(c.uuid)) c.result = r;
	const w = h.wake;
	if (w) {
		h.wake = null;
		finish(w, r.error ? "error" : "done", r.message);
		emit("host", hostView(h));
	}
}

/** 一条消息的下落：started 开始跑；completed（按它那一轮的 result 算跑完还是出错）、cancelled（被停）、discarded / refused（命令行不接）结束 */
function lifecycle(h: Proc, ev: Record<string, unknown>) {
	const c = h.cmds.find((x) => x.uuid === ev.command_uuid);
	if (!c) return;
	if (ev.state === "started") {
		c.started = true;
		emit("host", hostView(h));
		return;
	}
	if (!["completed", "cancelled", "discarded", "refused"].includes(String(ev.state))) return;
	// 先拿掉再结束：结束时会接着发排队的，那条要能直接写进来
	h.cmds.splice(h.cmds.indexOf(c), 1);
	if (ev.state === "completed") finish(c.run, c.result?.error ? "error" : "done", c.result?.message || "出错了");
	else if (ev.state === "cancelled") finish(c.run, "stopped", null);
	else finish(c.run, "error", `claude 没有接这条消息（${ev.state}）`);
	if (!h.gone) emit("host", hostView(h));
}

/**
 * 后台任务变了：background_tasks_changed 是整张表（开始时间按第一次看到的算）；task_started 带开它的工具调用，另记一份（spawns），
 * 两个谁先来都对得上。表里没了的任务，spawns 里的也忘掉（还没进表的留着）
 */
function tasks(h: Proc, ev: Record<string, unknown>) {
	if (ev.subtype === "task_started") {
		if (typeof ev.task_id === "string") h.spawns.set(ev.task_id, { tool: typeof ev.tool_use_id === "string" ? ev.tool_use_id : null, ambient: ev.ambient === true, description: String(ev.description ?? "") });
	} else {
		const now = new Date().toISOString();
		const next = ((ev.tasks ?? []) as { task_id: string; task_type?: string; description?: string; ambient?: boolean }[]).map((x) => {
			const old = h.tasks.find((t) => t.id === x.task_id);
			return { id: x.task_id, type: String(x.task_type ?? ""), description: String(x.description ?? ""), started: old?.started ?? now, ambient: x.ambient === true };
		});
		for (const t of h.tasks) if (!next.some((x) => x.id === t.id)) h.spawns.delete(t.id);
		h.tasks = next;
	}
	emit("host", hostView(h));
}

/** 通知叫醒的一轮：没有人说的话，权限、模型接着用进程现在的 */
function wake(h: Proc) {
	const run = fresh({ project: h.project, cwd: h.cwd, session: h.session, sid: null, mode: "resume", prompt: "", images: [], permission: h.permission, model: h.model, effort: h.effort, uuid: "", merged: [] }, "claude");
	run.halt = () => interrupt(h, run);
	runs.set(run.id, run);
	h.wake = run;
	emit("run", view(run));
	emit("host", hostView(h));
}

/**
 * idle：整个会话都停了（后台子代理也跑完了）。照理这时已经没有在跑的了；有了 result 却漏了 completed 的消息、叫醒的那一轮在这里结束兜底。
 * 别的不动：停掉后台任务之后命令行会补一个 idle，刚写进去的那条可能还没轮上、或者刚开始跑。然后看要不要关进程
 */
function settle(h: Proc) {
	for (const c of h.cmds.filter((x) => x.result)) {
		h.cmds.splice(h.cmds.indexOf(c), 1);
		finish(c.run, c.result?.error ? "error" : "done", c.result?.message || "出错了");
	}
	const w = h.wake;
	h.wake = null;
	if (w) finish(w, "done", null);
	close(h);
	if (!h.gone) emit("host", hostView(h));
}

/** 没有在跑的、写进去没结束的、后台任务（ambient 的不算）、排着队等它的、等人确认的：关 stdin，进程自己退 */
function close(h: Proc) {
	if (h.gone || h.cmds.length || h.wake || active(h).length || queue.some((q) => q.session === h.session) || [...approvals.values()].some((a) => a.by === h.id)) return;
	h.gone = true;
	h.child.stdin.end();
}

/** 进程退了：从表里拿掉（排队的接着发要另起一个），正在跑的那一轮按退出码结束 */
function gone(h: Proc, error: string | null) {
	if (!hosts.has(h.id)) return;
	hosts.delete(h.id);
	h.gone = true;
	if (h.child.pid) terminals.mine.delete(h.child.pid);
	emit("host", { id: h.id, gone: true });
	// 它的确认请求作废（没人收了，不回）；等回音的 control_request 也不等了
	for (const a of [...approvals.values()]) if (a.by === h.id) decide(a.id, { allow: false, message: "claude 退出了", cancelled: true });
	for (const r of h.replies.values()) r.fail(new Error("claude 退出了"));
	h.replies.clear();
	const left = [...h.cmds.map((c) => c.run), ...(h.wake ? [h.wake] : [])];
	h.cmds = [];
	h.wake = null;
	for (const run of left) finish(run, error ? "error" : "done", error ?? "");
}

/** 停一个后台任务（Claude 不会被叫醒） */
export function stopTask(host: string, task: string) {
	const h = hosts.get(host);
	if (!h || h.gone || !h.tasks.some((t) => t.id === task)) return false;
	control(h, { subtype: "stop_task", task_id: task });
	return true;
}

/**
 * 后台命令、Monitor 输出的最后一段（最多 8KB）：问命令行（control_request 的 get_task_output，和终端里 /tasks 看的是同一段）。
 * 截过的去掉开头不完整的那行。别的任务（子代理）、进程不在了、问不到：null
 */
export async function taskOutput(host: string, task: string) {
	const h = hosts.get(host);
	if (!h || h.gone || !(h.tasks.some((t) => t.id === task) || h.spawns.has(task))) return null;
	try {
		const r = await request(h, { subtype: "get_task_output", task_id: task });
		const text = String(r.output ?? "");
		const cut = r.truncated === true;
		return { text: cut ? text.slice(text.indexOf("\n") + 1) : text, cut };
	} catch {
		return null;
	}
}

/** 发一个要回音的 control_request，等它的 control_response（10 秒没回、进程退了算失败） */
function request(h: Proc, req: Record<string, unknown>) {
	return new Promise<Record<string, unknown>>((ok, fail) => {
		const id = randomUUID();
		const timer = setTimeout(() => {
			h.replies.delete(id);
			fail(new Error("claude 10 秒没回"));
		}, 10_000).unref();
		h.replies.set(id, { ok: (r) => { clearTimeout(timer); ok(r); }, fail: (e) => { clearTimeout(timer); fail(e); } });
		write(h, { type: "control_request", request_id: id, request: req });
	});
}

/**
 * 命令行发来的 control_request：can_use_tool 是要确认的工具调用（tool_use_id、子代理里的带 agent_id），挂到网页上，人点了回
 * {behavior: allow, updatedInput: 原样的参数} / {behavior: deny, message}（不带 updatedInput 也行，试过）。
 * 别的（MCP 的 elicitation 这些）mixer 答不了：回 error，命令行不会一直等
 */
function asked(h: Proc, ev: Record<string, unknown>) {
	const id = String(ev.request_id ?? "");
	const r = (ev.request ?? {}) as Record<string, unknown>;
	const respond = (response: Record<string, unknown>) => write(h, { type: "control_response", response: { request_id: id, ...response } });
	if (r.subtype !== "can_use_tool") return respond({ subtype: "error", error: `mixer 不支持 ${String(r.subtype)}` });
	const input = (r.input && typeof r.input === "object" ? r.input : {}) as Record<string, unknown>;
	const agent = typeof r.agent_id === "string" ? r.agent_id : null;
	const description = agent ? (h.spawns.get(agent)?.description || h.tasks.find((t) => t.id === agent)?.description || "") : "";
	open({ by: h.id, req: id, project: h.project, cwd: h.cwd, session: h.session, toolUse: typeof r.tool_use_id === "string" ? r.tool_use_id : null, agent: agent ? { id: agent, description } : null }, String(r.tool_name ?? ""), input).then((d) => {
		if (d.cancelled || h.gone) return;
		respond({ subtype: "success", response: d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.message || "在 mixer 里被拒绝了" } });
	});
}

/** control_cancel_request：命令行不等这个确认了（这一轮被停了、工具调用取消了）：卡片收掉，不回 */
function withdrawn(h: Proc, ev: Record<string, unknown>) {
	for (const a of [...approvals.values()]) if (a.by === h.id && a.req === ev.request_id) decide(a.id, { allow: false, message: "claude 不等了", cancelled: true });
}

/** control_response：{response: {subtype: success / error, request_id, response / error}}。没人等的（set_model 这些发了不等的）不管 */
function reply(h: Proc, ev: Record<string, unknown>) {
	const r = (ev.response ?? {}) as { subtype?: string; request_id?: string; response?: Record<string, unknown>; error?: unknown };
	const w = r.request_id ? h.replies.get(r.request_id) : undefined;
	if (!w || !r.request_id) return;
	h.replies.delete(r.request_id);
	if (r.subtype === "success") w.ok(r.response ?? {});
	else w.fail(new Error(String(r.error ?? "出错了")));
}

/** 一次运行的样子（两种 agent 一样） */
function fresh(o: Params, agent: Run["agent"]): Live {
	const id = randomUUID().slice(0, 8);
	const run: Live = {
		id,
		project: o.project,
		cwd: o.cwd,
		from: o.session,
		session: o.mode === "resume" ? o.session : o.sid,
		mode: o.mode,
		agent,
		at: o.mode === "fork" ? (o.at ?? null) : null,
		prompt: o.prompt,
		permission: o.permission,
		model: o.model,
		effort: o.effort,
		status: "running",
		started: new Date().toISOString(),
		ended: null,
		error: null,
		// Codex 的 item id 开始跑了才有（codex-run 的 user）；叫醒的那一轮没有
		uuid: agent === "claude" && o.uuid ? o.uuid : null,
		merged: o.merged,
		images: o.images.length,
		pics: o.images,
		tail: emptyTail(),
		out: coalesce((e) => {
			run.tail = step(run.tail, e, Date.now());
			emit("run-event", { id, seq: run.tail.seq, event: e });
		}, HOLD),
	};
	return run;
}

/**
 * 会话 id 有了（claude 的起进程前就定了；Codex 新会话、分叉的等 app-server 回来）：网页对上这次运行，
 * 记下选的模型、分叉的来处（state.fork），放进工作区
 */
function known(run: Live, session: string) {
	if (run.session !== session) {
		run.session = session;
		emit("run", view(run));
	}
	state.chooseModel(session, run.model, run.effort);
	if (run.mode === "fork" && run.from) state.fork(session, { session: run.from, at: run.at });
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
	const e = project(ev);
	if (e) run.out.add(e);
}

/**
 * 运行结束（跑完、出错、被停）：记下来、作废它的确认请求、接着发排队的。点过停止的一律算停止。
 * 作废的只有 Codex 的（by 是运行 id：app-server 的确认按轮）；claude 的归进程，这一轮完了后台子代理可能还在等
 */
function finish(run: Live, status: "done" | "error" | "stopped", error: string | null, turn: string | null = null) {
	if (run.ended) return;
	run.out.flush();
	run.status = run.stopping ? "stopped" : status;
	delete run.stopping;
	if (run.status === "error") run.error = error || "出错了";
	run.ended = new Date().toISOString();
	delete run.halt;
	// 新会话、分叉一开始就出错（claude 起不来、参数不对），记录都没写出来：工作区里、state 里的这个 id 都拿掉，免得留个看不见的
	const none = !run.session || !locate(run.project, run.session);
	if (run.session && run.status === "error" && run.mode !== "resume" && none) {
		if (state.forget(run.session)) emit("workspace", null);
	} else if (run.session) state.finished(run.project, run.session, run.status === "error");
	for (const a of [...approvals.values()]) if (a.by === run.id) decide(a.id, { allow: false, message: "运行已结束" });
	// 没有记录：没什么可等的，当场给 null
	if (none) run.version = null;
	emit("run", view(run));
	if (!none) seal(run, turn);
	if (run.session) drain(run.session);
}

/**
 * 这次运行写的都在记录里了，记下会话写到哪了（version），再推一次 run：网页的数据到了这里就收掉流里的那几段、发件箱看那条到没到。
 * claude 在报 result、这条消息的下落之前先把记录写完了（试过）：结束时读就是全的。
 * Codex 的记录在 turn/completed 之后才写完（task_complete 那几行晚一点）：等到记录里这一轮收尾了再算，最多等 5 秒。
 * 图这时也不用留了：记录里有了
 */
async function seal(run: Live, turn: string | null) {
	let v: string | null = null;
	try {
		if (run.session) v = await version(run.project, run.session, run.agent === "codex" ? turn : null);
	} catch {}
	run.version = v;
	run.pics = [];
	emit("run", view(run));
}

/** Codex：codex app-server 上跑一轮（codex-run.ts）。分叉点是节点，Codex 按轮分叉：换成它所在的那一轮 */
function startCodex(run: Live, o: Params, cx: ReturnType<typeof codex.find>) {
	runs.set(run.id, run);
	emit("run", view(run));
	(async () => {
		try {
			const at = o.mode === "fork" && o.at && cx ? await codex.turnOf(cx, o.at) : null;
			if (o.mode === "fork" && o.at && !at) throw new Error("找不到分叉点在哪一轮");
			const h = await codexRun.launch({ ...o, at }, {
				event: (ev) => push(run, ev),
				session: (sid) => known(run, sid),
				// 这一轮的第一条你的消息（mixer 不在一轮中间插话，只有这一条）
				user: (id) => {
					if (run.uuid) return;
					run.uuid = id;
					emit("run", view(run));
				},
				// 线程 id 在 turn/start 之前就有了（上面的 session），来问时一定有
				ask: (tool, input) => open({ by: run.id, req: null, project: run.project, cwd: run.cwd, session: run.session ?? "", toolUse: null, agent: null }, tool, input),
				end: (status, error, turn) => finish(run, status, error ?? null, turn),
			});
			// 起的时候点了停止：现在才有 turn 能停。起得慢、停止的 10 秒兜底已经把这次运行结束了（stopping 也清掉了）：照样停，
			// 不然界面上写着已停止，Codex 却开跑了
			if (run.ended || run.stopping) h.stop();
			else run.halt = h.stop;
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
/** 运行带的图（按这条消息的 uuid，或者它带着的网页那几条的）：记录里还没有时，网页先画的那条从这里拿 */
export const runImage = (uuid: string, i: number) => [...runs.values()].find((r) => r.uuid === uuid || r.merged.includes(uuid))?.pics[i] ?? null;

export function unqueue(id: string) {
	const i = queue.findIndex((q) => q.id === id);
	if (i < 0) return false;
	queue.splice(i, 1);
	emit("queue", queued());
	return true;
}

/**
 * 这个会话的运行结束了：排着的话按顺序合成一条，续接。只有一条就用它自己的 uuid；几条合成的另给一个，merged 记着是哪几条。
 * 新的运行推出去了（或者没发出去）才推队列：网页上那几条一直在队列或者运行里，发件箱不会以为它们丢了
 */
function drain(session: string) {
	const items = queue.filter((q) => q.session === session);
	if (!items.length) return;
	for (const q of items) queue.splice(queue.indexOf(q), 1);
	const last = items[items.length - 1];
	const one = items.length === 1;
	start({ project: last.project, cwd: last.cwd, session, mode: "resume", prompt: items.map((q) => q.prompt).filter((p) => p.trim()).join("\n\n"), images: items.flatMap((q) => q.images), permission: last.permission, model: last.model, effort: last.effort, uuid: one ? last.uuid : randomUUID(), merged: items.map((q) => q.uuid) })
		.catch((e: Error) => emit("queue-error", { session, error: e.message }))
		.finally(() => emit("queue", queued()));
}

/**
 * 停：claude 发 interrupt（只停这一轮，后台任务接着跑；10 秒没停下来就 SIGINT 整个进程，再 5 秒 SIGKILL），Codex 发 turn/interrupt。
 * 这一轮真结束了（claude 是这条消息的 cancelled / completed、叫醒那一轮的 result、进程退出；Codex 是 turn/completed）才算，免得同一个会话又开一次运行、两边一起写；这期间发的话排队。Codex 10 秒没回音也按停止结束
 */
export function stop(id: string) {
	const r = runs.get(id);
	if (!r || r.status !== "running") return false;
	if (r.stopping) return true;
	r.stopping = true;
	emit("run", view(r));
	r.halt?.();
	if (r.agent === "codex") setTimeout(() => finish(r, "stopped", null), 10_000).unref();
	return true;
}

/** claude 停这一轮：interrupt；10 秒没停下来就 SIGINT 整个进程（后台任务一起没了），再 5 秒 SIGKILL */
function interrupt(h: Proc, run: Live) {
	control(h, { subtype: "interrupt" });
	setTimeout(() => {
		if (run.ended) return;
		h.child.kill("SIGINT");
		setTimeout(() => h.child.kill("SIGKILL"), 5000).unref();
	}, 10_000).unref();
}

/**
 * 挂起一个确认请求，等网页上的人点。10 分钟没人点就拒绝。
 * claude 的（asked）归进程的会话，不管它这会儿有没有在跑的一轮（后台子代理在 Claude 闲着时也会问）
 */
function open(w: Pick<Asking, "by" | "req" | "project" | "cwd" | "session" | "toolUse" | "agent">, tool: string, input: unknown): Promise<Decision> {
	return new Promise((resolve) => {
		const id = randomUUID().slice(0, 8);
		const timer = setTimeout(() => decide(id, { allow: false, message: "10 分钟没人确认，拒绝了" }), 10 * 60_000).unref();
		const a: Asking = { id, ...w, tool, input, at: new Date().toISOString(), resolve, timer };
		approvals.set(id, a);
		emit("approval", approvalView(a));
	});
}

const approvalView = ({ by: _b, req: _q, resolve: _r, timer: _t, ...a }: Asking): Approval => a;

export const answer = (id: string, allow: boolean, message?: string) => decide(id, { allow, message });

/** 确认请求有了结果（人点了、10 分钟没人点、claude 不等了、claude 退出了、Codex 这一轮结束了）：收掉卡片，回给问的那边（不等了的不回） */
function decide(id: string, d: Decision) {
	const a = approvals.get(id);
	if (!a) return false;
	approvals.delete(id);
	clearTimeout(a.timer);
	a.resolve(d);
	emit("approval-done", { id, allow: d.allow });
	return true;
}

/** mixer 里没在干活：没有运行、排队的消息、待确认、开着的 claude 进程（等后台任务的：重启会把后台任务一起杀掉） */
export const idle = () => ![...runs.values()].some((r) => r.status === "running") && !queue.length && !approvals.size && !hosts.size;

/** 这个会话在 mixer 里还有事（等确认、在跑、正从它分叉、排着队）：这时不许删，返回原因 */
export function busy(session: string): string | null {
	if ([...approvals.values()].some((a) => a.session === session)) return "这个会话有待确认的请求：先处理了再删";
	const mine = [...runs.values()].filter((r) => r.status === "running" && (r.session === session || r.from === session));
	if (mine.length) return "这个会话正在 mixer 里运行：停止后再删";
	const h = hostOf(session);
	if (h && active(h).length) return "这个会话有后台任务在跑：停掉后再删";
	if (queue.some((q) => q.session === session)) return "这个会话还有排队的消息：取消后再删";
	return null;
}

export const pending = () => [...approvals.values()].map(approvalView);
/** 页面连上时的 hello（sse.ts）里这边的：运行、开着的 claude 进程、确认请求、排队，在跑的那几次正在写的那几段（攒着的增量先推出去） */
export const snapshot = () => ({
	runs: list(),
	hosts: hostList(),
	approvals: pending(),
	queue: queued(),
	tails: Object.fromEntries([...runs.values()].flatMap((r) => (r.status === "running" ? [[r.id, tail(r.id)]] : []))),
});
