// 能选的模型：Claude 的问本机的 claude（stream-json 的 control_request initialize 回的 models：默认、各系列最新的别名、固定的版本，
// 每个支持哪些思考强度），Codex 的问 app-server（codex-run.ts 的 model/list）。两边给网页的是一个样子（shared/model-info.ts 的 ModelInfo），
// 第一项是「默认」（id ""）。
// 问的时候起一个 claude -p --safe-mode（control：不跑 hooks、不连 MCP，几秒就回，不写会话记录、不花 token），同一个进程顺便问 get_usage
// （Claude 的用量，交给 usage.ts：终端里用掉的也算进来）。起来 5 秒后、之后每 10 分钟（跟 Codex 的用量一样：5 小时的窗口 10 分钟最多动几个百分点，
// 网页 30 分钟才算旧）、每次运行的 init 里命令行版本变了、网页要的时候列表超过 10 分钟，都问一次。
// Claude 出了新模型（命令行升级、账号开了新的），列表跟着变。
// 第一次见到的型号（Claude 按 resolvedModel，别名换了新版也算；Codex 按 id）记下时间（state.json），7 天内标「新」
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { ModelInfo } from "../shared/model-info.ts";
import * as codexRun from "./codex-run.ts";
import { say } from "./log.ts";
import * as state from "./state.ts";
import * as terminals from "./terminals.ts";
import * as usage from "./usage.ts";

const WEEK = 7 * 86_400_000;

type Raw = { value?: unknown; resolvedModel?: unknown; displayName?: unknown; supportedEffortLevels?: unknown };

/**
 * initialize 回的 models → 给网页的。别名（opus → claude-opus-5-5）是那个系列最新的：value 和 resolvedModel 不一样；
 * 固定版本两个一样。没有 resolvedModel 的（旧版命令行）按名字猜：不带 claude- 前缀的是别名。默认放第一个
 */
export function fromInit(models: Raw[], firstSeen: Record<string, string>, now = Date.now()): ModelInfo[] {
	const out: ModelInfo[] = [];
	for (const m of models) {
		const value = String(m.value ?? "");
		if (!value) continue;
		const resolved = typeof m.resolvedModel === "string" ? m.resolvedModel : null;
		const seen = resolved ? firstSeen[resolved] : undefined;
		out.push({
			id: value === "default" ? "" : value,
			label: value === "default" ? "默认" : String(m.displayName ?? value),
			resolved,
			efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : [],
			defaultEffort: null,
			latest: value !== "default" && (resolved ? value !== resolved : !value.startsWith("claude-")),
			isNew: value !== "default" && !!seen && now - Date.parse(seen) < WEEK,
		});
	}
	return out.sort((a, b) => Number(!!a.id) - Number(!!b.id));
}

/**
 * 起一个 claude -p --safe-mode 问几个 control_request（initialize、get_usage 这些），每个一个 Promise：回了 success 给 response，
 * 回 error（旧版命令行不认识这个 subtype）、30 秒没回、进程没了算失败。都有了回音就关。
 * 它也在 ~/.claude/sessions 登记，记进 terminals.mine，不算「终端中打开」
 */
export function control<K extends string>(reqs: Record<K, Record<string, unknown>>): Record<K, Promise<unknown>> {
	const wait = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	const out = {} as Record<K, Promise<unknown>>;
	for (const id of Object.keys(reqs) as K[]) {
		out[id] = new Promise((resolve, reject) => wait.set(id, { resolve, reject }));
		out[id].catch(() => {}); // 没人等的失败不算没处理
	}
	const fail = (why: string) => {
		for (const w of wait.values()) w.reject(new Error(why));
		wait.clear();
	};
	const child = spawn("claude", ["-p", "--safe-mode", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], { cwd: homedir(), stdio: ["pipe", "pipe", "ignore"] });
	const pid = child.pid;
	if (pid) terminals.mine.add(pid);
	const done = () => {
		clearTimeout(timer);
		child.stdin.end();
		child.kill();
	};
	const timer = setTimeout(() => { fail("30 秒没回"); done(); }, 30_000);
	let buf = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (c: string) => {
		buf += c;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const l = buf.slice(0, i);
			buf = buf.slice(i + 1);
			let ev: { type?: string; response?: { subtype?: string; request_id?: string; error?: unknown; response?: unknown } };
			try { ev = JSON.parse(l); } catch { continue; }
			const id = ev.type === "control_response" ? ev.response?.request_id : undefined;
			const w = id ? wait.get(id) : undefined;
			if (!id || !w || !ev.response) continue;
			wait.delete(id);
			if (ev.response.subtype === "error") w.reject(new Error(String(ev.response.error ?? "出错了")));
			else w.resolve(ev.response.response);
			if (!wait.size) done();
		}
	});
	child.stdin.on("error", () => {});
	child.on("error", (e) => { clearTimeout(timer); fail(e.message); });
	child.on("close", () => {
		clearTimeout(timer);
		if (pid) terminals.mine.delete(pid);
		fail("claude 退出了");
	});
	for (const [id, request] of Object.entries(reqs)) child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
	return out;
}

/** 重读 Claude 的（顺便问用量）。同时只问一次；没见过的型号记下第一次见到的时间（头一回读的不算新） */
let reading: Promise<ModelInfo[]> | null = null;
export function refresh(): Promise<ModelInfo[]> {
	reading ??= (async () => {
		const r = control({ models: { subtype: "initialize" }, usage: { subtype: "get_usage", skip_behaviors: true } });
		usage.claudeRead(r.usage);
		const models = ((await r.models) as { models?: unknown } | null)?.models;
		if (!Array.isArray(models)) throw new Error("回的没有 models");
		state.sawModels("claude", models.map((m: Raw) => m.resolvedModel).filter((x): x is string => typeof x === "string"));
		state.setClaudeModels({ at: new Date().toISOString(), version: version ?? state.claudeModels()?.version ?? null, models });
		return fromInit(models, state.modelsSeen("claude"));
	})().finally(() => { reading = null; });
	return reading;
}

/** 后台重读：失败了只记日志，同样的错只记一次（没装 claude 时每 10 分钟一条没用） */
let lastError = "";
const reread = () => {
	refresh().then(() => { lastError = ""; }, (e: Error) => {
		if (e.message !== lastError) say(`读 Claude 的模型失败：${e.message}`);
		lastError = e.message;
	});
};

/** 正在用的命令行版本（运行的 init 里有）：和读列表时的不同就重读 */
let version: string | null = null;
export function sawVersion(v: unknown) {
	if (typeof v !== "string" || v === version) return;
	version = v;
	if (state.claudeModels()?.version !== v) reread();
}

/** Claude 的：有存着的先给（旧了顺手重读），一次都没读过就等它读完 */
export async function claude(): Promise<ModelInfo[]> {
	const c = state.claudeModels();
	if (!c) return refresh();
	if (Date.now() - Date.parse(c.at) > 600_000) reread();
	return fromInit(c.models as Raw[], state.modelsSeen("claude"));
}

/** Codex 的：model/list 的，前面加上「默认」（是 isDefault 那个，思考强度也照它的） */
export async function codex(): Promise<ModelInfo[]> {
	const list = await codexRun.listModels();
	state.sawModels("codex", list.map((m) => m.id));
	const seen = state.modelsSeen("codex");
	const def = list.find((m) => m.isDefault);
	const rows = list.map((m) => ({ id: m.id, label: m.label, resolved: m.id, efforts: m.efforts, defaultEffort: m.defaultEffort, latest: false, isNew: !!seen[m.id] && Date.now() - Date.parse(seen[m.id]) < WEEK }));
	return [{ id: "", label: "默认", resolved: def?.id ?? null, efforts: def?.efforts ?? [], defaultEffort: def?.defaultEffort ?? null, latest: false, isNew: false }, ...rows];
}

/** 起来 5 秒后读一次，之后每 10 分钟（模型列表和用量一起） */
export function start() {
	setTimeout(() => {
		reread();
		setInterval(reread, 600_000).unref();
	}, 5000).unref();
}
