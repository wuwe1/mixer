// 运行会话：在本机启动 claude 命令行（用它自己登录的订阅），非交互模式，按行输出 JSON。
//   新会话：在一个文件夹里 claude -p
//   续接：claude -p --resume <id>
//   分叉：再加 --fork-session（新会话 id，原来的不动）；从中间某条 Claude 的消息分叉，再加 --resume-session-at <那条记录的 uuid>（只带到它为止的上下文）
// 要确认的工具调用经 MCP 工具 mcp__mixer__approve 转到网页上（approvals）。
// 同一个会话如果还在别处跑着（记录 90 秒内有写入，而且不是 mixer 自己跑完的），不许直接续接，只能分叉：免得两边同时往一个文件里写。
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionFile } from "./sessions.ts";
import * as state from "./state.ts";

export type RunStatus = "running" | "done" | "error" | "stopped";
export type Run = {
	id: string;
	project: string;
	cwd: string;
	from: string | null;
	session: string | null;
	mode: "new" | "resume" | "fork";
	/** 分叉点：从这条 Claude 的消息之后分出去；null 是从最新处 */
	at: string | null;
	prompt: string;
	permission: string;
	status: RunStatus;
	started: string;
	ended: string | null;
	error: string | null;
	events: unknown[];
};

type Approval = { id: string; run: string; tool: string; input: unknown; at: string; resolve: (d: { allow: boolean; message?: string }) => void };

const runs = new Map<string, Run & { child?: ChildProcess }>();
const approvals = new Map<string, Approval>();
export const TOKEN = randomUUID();
const MCP = join(dirname(new URL(import.meta.url).pathname), "..", "mcp", "approve.ts");

type Emit = (type: string, data: unknown) => void;
let emit: Emit = () => {};
export const onEvent = (f: Emit) => { emit = f; };

const view = (r: Run & { child?: ChildProcess }) => {
	const { child: _c, events, ...rest } = r;
	return { ...rest, events: events.length };
};
export const list = () => [...runs.values()].map(view).sort((a, b) => b.started.localeCompare(a.started));
export const get = (id: string) => {
	const r = runs.get(id);
	return r ? { ...view(r), events: r.events } : null;
};

export async function start(o: { project: string; cwd: string; session: string | null; mode: Run["mode"]; at?: string | null; prompt: string; permission: string }) {
	if (!o.prompt.trim()) throw new Error("说点什么");
	if (!["default", "acceptEdits", "plan", "manual"].includes(o.permission)) throw new Error("不支持的权限模式");
	if (!["new", "resume", "fork"].includes(o.mode)) throw new Error("不认识的方式");
	const resume = o.mode === "new" ? null : o.session;
	if (o.mode !== "new" && !resume) throw new Error("要接哪个会话？");
	if (o.at && !/^[0-9a-f-]{36}$/.test(o.at)) throw new Error("分叉点不对");
	if (o.mode === "resume" && resume) {
		// 最近的写入是 mixer 自己的运行（已经跑完）就放行；否则 90 秒内有写入，说明可能在终端里开着
		const ours = [...runs.values()].filter((r) => r.session === resume);
		if (ours.some((r) => r.status === "running")) throw new Error("这个会话正在 mixer 里跑，等它跑完再续接");
		const mtime = statSync(sessionFile(o.project, resume)).mtimeMs;
		if (!ours.length && Date.now() - mtime < 90_000 && !state.ourLastWrite(resume, mtime)) {
			throw new Error("这个会话还在别处跑着（90 秒内有写入）：现在只能分叉");
		}
	}
	const id = randomUUID().slice(0, 8);
	const dir = join(tmpdir(), "mixer");
	mkdirSync(dir, { recursive: true });
	const cfg = join(dir, `mcp-${id}.json`);
	writeFileSync(cfg, JSON.stringify({ mcpServers: { mixer: { command: process.execPath, args: [MCP], env: { MIXER_URL: `http://127.0.0.1:${process.env.MIXER_PORT ?? 4848}`, MIXER_TOKEN: TOKEN, MIXER_RUN: id } } } }));
	const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", o.permission, "--permission-prompt-tool", "mcp__mixer__approve", "--mcp-config", cfg];
	if (resume) args.push("--resume", resume);
	if (o.mode === "fork") args.push("--fork-session", ...(o.at ? ["--resume-session-at", o.at] : []));
	const run: Run & { child?: ChildProcess } = {
		id,
		project: o.project,
		cwd: o.cwd,
		from: o.session,
		session: o.mode === "resume" ? resume : null,
		mode: o.mode,
		at: o.mode === "fork" ? (o.at ?? null) : null,
		prompt: o.prompt,
		permission: o.permission,
		status: "running",
		started: new Date().toISOString(),
		ended: null,
		error: null,
		events: [],
	};
	const child = spawn("claude", args, { cwd: o.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
	run.child = child;
	runs.set(id, run);
	child.stdin.end(o.prompt);
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
			if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") run.session = ev.session_id;
			run.events.push(ev);
			if (run.events.length > 5000) run.events.splice(0, run.events.length - 5000);
			emit("run-event", { id, event: ev });
		}
	});
	let err = "";
	child.stderr.on("data", (c: Buffer) => { err = (err + c.toString("utf8")).slice(-4000); });
	child.on("exit", (code, signal) => {
		run.status = run.status === "stopped" ? "stopped" : code === 0 ? "done" : "error";
		if (run.status === "error") run.error = err.trim() || `退出码 ${code ?? signal}`;
		run.ended = new Date().toISOString();
		delete run.child;
		if (run.session) state.finished(run.project, run.session, run.status === "error");
		// 这次运行的确认请求一律作废
		for (const a of approvals.values()) if (a.run === id) { a.resolve({ allow: false, message: "运行已结束" }); approvals.delete(a.id); }
		emit("run", view(run));
	});
	emit("run", view(run));
	return view(run);
}

export function stop(id: string) {
	const r = runs.get(id);
	if (!r?.child) return false;
	r.status = "stopped";
	r.child.kill("SIGINT");
	setTimeout(() => r.child?.kill("SIGKILL"), 5000).unref();
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

export const pending = () => [...approvals.values()].map(({ resolve: _r, ...a }) => a);
