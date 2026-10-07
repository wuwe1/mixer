// 能选的模型：Claude 的问本机的 claude（stream-json 的 control_request initialize 回的 models：默认、各系列最新的别名、固定的版本，
// 每个支持哪些思考强度），Codex 的问 app-server（codex-run.ts 的 model/list）。两边给网页的是一个样子（web/src/lib/model.ts 的 ModelInfo），
// 第一项是「默认」（id ""）。
// Claude 出了新模型（命令行升级、账号开了新的），列表跟着变：起来 5 秒后、之后每小时、每次运行的 init 里命令行版本变了、
// 网页要的时候列表超过 10 分钟，都重读。问的时候带 --safe-mode：不跑 hooks、不连 MCP，几秒就回，也不写会话记录。
// 第一次见到的型号（Claude 按 resolvedModel，别名换了新版也算；Codex 按 id）记下时间（state.json），7 天内标「新」
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { ModelInfo } from "../web/src/lib/model-info.ts";
import * as codexRun from "./codex-run.ts";
import * as state from "./state.ts";

const say = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const WEEK = 7 * 86_400_000;

type Raw = { value?: unknown; resolvedModel?: unknown; displayName?: unknown; supportedEffortLevels?: unknown };

/** initialize 回的 models → 给网页的。别名（不带 claude- 前缀的）是那个系列最新的；默认放第一个 */
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
			latest: value !== "default" && !value.startsWith("claude-"),
			isNew: value !== "default" && !!seen && now - Date.parse(seen) < WEEK,
		});
	}
	return out.sort((a, b) => Number(!!a.id) - Number(!!b.id));
}

let reading: Promise<ModelInfo[]> | null = null;

/** 起一个 claude 只问 initialize，拿到就关。30 秒没回就算了 */
function ask(): Promise<{ models: Raw[] }> {
	return new Promise((resolve, reject) => {
		const child = spawn("claude", ["-p", "--safe-mode", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], { cwd: homedir(), stdio: ["pipe", "pipe", "ignore"] });
		const timer = setTimeout(() => { child.kill(); reject(new Error("30 秒没回")); }, 30_000);
		let buf = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c: string) => {
			buf += c;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const l = buf.slice(0, i);
				buf = buf.slice(i + 1);
				let ev: { type?: string; response?: { request_id?: string; response?: { models?: unknown } } };
				try { ev = JSON.parse(l); } catch { continue; }
				if (ev.type !== "control_response" || ev.response?.request_id !== "models") continue;
				clearTimeout(timer);
				child.stdin.end();
				child.kill();
				const models = ev.response.response?.models;
				return Array.isArray(models) ? resolve({ models }) : reject(new Error("回的没有 models"));
			}
		});
		child.stdin.on("error", () => {});
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("close", () => { clearTimeout(timer); reject(new Error("claude 退出了")); });
		child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}\n`);
	});
}

/** 重读 Claude 的。同时只问一次；没见过的型号记下第一次见到的时间（头一回读的不算新） */
export function refresh(): Promise<ModelInfo[]> {
	reading ??= (async () => {
		const { models } = await ask();
		state.sawModels("claude", models.map((m) => m.resolvedModel).filter((x): x is string => typeof x === "string"));
		state.setClaudeModels({ at: new Date().toISOString(), version: version ?? state.claudeModels()?.version ?? null, models });
		return fromInit(models, state.modelsSeen("claude"));
	})().finally(() => { reading = null; });
	return reading;
}

/** 正在用的命令行版本（运行的 init 里有）：和读列表时的不同就重读 */
let version: string | null = null;
export function sawVersion(v: unknown) {
	if (typeof v !== "string" || v === version) return;
	version = v;
	if (state.claudeModels()?.version !== v) refresh().catch((e: Error) => say(`读 Claude 的模型失败：${e.message}`));
}

/** Claude 的：有存着的先给（旧了顺手重读），一次都没读过就等它读完 */
export async function claude(): Promise<ModelInfo[]> {
	const c = state.claudeModels();
	if (!c) return refresh();
	if (Date.now() - Date.parse(c.at) > 600_000) refresh().catch((e: Error) => say(`读 Claude 的模型失败：${e.message}`));
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

/** 起来 5 秒后读一次，之后每小时 */
export function start() {
	setTimeout(() => {
		refresh().catch((e: Error) => say(`读 Claude 的模型失败：${e.message}`));
		setInterval(() => refresh().catch((e: Error) => say(`读 Claude 的模型失败：${e.message}`)), 3_600_000).unref();
	}, 5000).unref();
}
