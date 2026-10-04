// 运行会话：在本机启动 claude 命令行（用它自己登录的订阅），非交互模式，按行输出 JSON。
//   续接：claude -p --resume <id>            分叉：再加 --fork-session（新会话 id，原来的不动）
//   从中间某条消息分叉（实验）：把原会话从开头到那条消息之前的记录复制成一个新会话文件，再续接它
// 要确认的工具调用经 MCP 工具 mcp__mixer__approve 转到网页上（approvals）。
// 同一个会话如果还在别处跑着（记录 90 秒内有写入），不许直接续接，只能分叉：免得两边同时往一个文件里写。
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, sessionFile } from "./sessions.ts";

export type RunStatus = "running" | "done" | "error" | "stopped";
export type Run = {
	id: string;
	project: string;
	cwd: string;
	from: string | null;
	session: string | null;
	mode: "new" | "resume" | "fork" | "fork-at";
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

/** 从中间某条消息分叉：把从开头到 at（不含）的记录复制成一个新会话，返回新 id */
async function forkAt(project: string, id: string, at: string): Promise<string> {
	const { raw } = await parse(sessionFile(project, id));
	const chain: Record<string, unknown>[] = [];
	let p = raw.get(at)?.parentUuid as string | null;
	while (p) {
		const d = raw.get(p);
		if (!d) break;
		chain.unshift(d);
		p = d.parentUuid ?? null;
	}
	if (!raw.has(at)) throw new Error("找不到这条消息");
	const nid = randomUUID();
	const lines = chain.map((d) => JSON.stringify({ ...d, sessionId: nid }));
	writeFileSync(sessionFile(project, nid), `${lines.join("\n")}\n`);
	return nid;
}

export async function start(o: { project: string; cwd: string; session: string | null; mode: Run["mode"]; at?: string; prompt: string; permission: string }) {
	if (!o.prompt.trim()) throw new Error("说点什么");
	if (!["default", "acceptEdits", "plan", "manual"].includes(o.permission)) throw new Error("不支持的权限模式");
	let resume = o.session;
	if (o.mode !== "new" && !resume) throw new Error("要续接哪个会话？");
	if (o.mode === "resume" && resume && Date.now() - statSync(sessionFile(o.project, resume)).mtimeMs < 90_000) {
		throw new Error("这个会话还在别处跑着（90 秒内有写入）：现在只能分叉");
	}
	if (o.mode === "fork-at") {
		if (!resume || !o.at) throw new Error("从哪条消息分叉？");
		resume = await forkAt(o.project, resume, o.at);
	}
	const id = randomUUID().slice(0, 8);
	const dir = join(tmpdir(), "mixer");
	mkdirSync(dir, { recursive: true });
	const cfg = join(dir, `mcp-${id}.json`);
	writeFileSync(cfg, JSON.stringify({ mcpServers: { mixer: { command: process.execPath, args: [MCP], env: { MIXER_URL: `http://127.0.0.1:${process.env.MIXER_PORT ?? 4848}`, MIXER_TOKEN: TOKEN, MIXER_RUN: id } } } }));
	const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", o.permission, "--permission-prompt-tool", "mcp__mixer__approve", "--mcp-config", cfg];
	if (resume) args.push("--resume", resume);
	if (o.mode === "fork") args.push("--fork-session");
	const run: Run & { child?: ChildProcess } = {
		id,
		project: o.project,
		cwd: o.cwd,
		from: o.session,
		session: o.mode === "resume" || o.mode === "fork-at" ? resume : null,
		mode: o.mode,
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
