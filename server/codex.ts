// 读 Codex 的会话记录（~/.codex/sessions/年/月/日/rollout-<时间>-<会话 id>.jsonl），拼成和 Claude Code 的一样的显示节点。
// 现在只读：能在「浏览会话」里看到、放进工作区、打开看；在 mixer 里继续 Codex 会话是下一步（codex app-server）。
//
// 记录的格式跟着 Codex 的版本变，这里只依赖各版本都有的几样：
//   第一行 session_meta：id、cwd；thread_source 不是 user（比如 guardian_review 自动审批）、有 parent_thread_id 的是 Codex 内部的会话，不列
//   人说的话：event_msg 的 user_message（老）或 item_completed 里的 UserMessage（新）。response_item 里 role=user 的混着
//     AGENTS.md、环境信息这些注入的东西，不用它
//   回复、推理摘要、工具调用和结果：response_item 的 message(assistant) / reasoning.summary / function_call / custom_tool_call /
//     web_search_call 和对应的 *_output（按 call_id 挂到调用上）
//   compacted / context_compacted：上下文压缩；turn_aborted：被打断；token_count：上下文用量和窗口；turn_context：模型
// 标题在 ~/.codex/session_index.jsonl（同一个 id 后写的算）。记录是一条直线（没有 Claude 那种 uuid 树），每个节点挂在上一个下面
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lines } from "./jsonl.ts";

export const CODEX = join(homedir(), ".codex", "sessions");
const INDEX = join(homedir(), ".codex", "session_index.jsonl");
/** 项目 id 和 Claude Code 的规则一样（路径里非字母数字的都换成 -）：同一个文件夹里两种会话在一组 */
const projectId = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

type Ctx = { used: number; model: string };
type Node =
	| { k: "user"; uuid: string; parent: string | null; ts: string; text: string; images: number }
	| { k: "assistant" | "thinking"; uuid: string; parent: string | null; ts: string; text: string; ctx?: Ctx; key?: string }
	| { k: "tool"; uuid: string; parent: string | null; ts: string; id: string; name: string; summary: string; input: string; result: { text: string; error: boolean; cut: boolean; images: number } | null; resultUuid: null; agent: null; ctx?: Ctx; key?: string }
	| { k: "event"; uuid: string; parent: string | null; ts: string; kind: "compact" | "info"; text: string; detail?: string };

// —— 有哪些会话 ——
type Info = { id: string; file: string; cwd: string; project: string; born: number; hidden: boolean };
const infos = new Map<string, Info>();
const byId = new Map<string, Info>();

/** 一个文件的第一行（session_meta）：里面有很长的系统提示，按块读到换行为止 */
function firstLine(file: string): string {
	const fd = openSync(file, "r");
	try {
		const parts: Buffer[] = [];
		const buf = Buffer.alloc(64 * 1024);
		for (let pos = 0; pos < 8 * 1024 * 1024; ) {
			const n = readSync(fd, buf, 0, buf.length, pos);
			if (n <= 0) break;
			const i = buf.subarray(0, n).indexOf(10);
			parts.push(Buffer.from(buf.subarray(0, i >= 0 ? i : n)));
			if (i >= 0) break;
			pos += n;
		}
		return Buffer.concat(parts).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** 扫一遍会话目录，新文件读它的 session_meta（读过的不再读） */
function refresh() {
	if (!existsSync(CODEX)) return;
	const walk = (dir: string, depth: number): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() && depth < 3 ? walk(join(dir, e.name), depth + 1) : e.isFile() && e.name.endsWith(".jsonl") && depth === 3 ? [join(dir, e.name)] : []));
	const files = walk(CODEX, 0);
	// Codex 会删掉自己的临时会话：文件没了就忘掉
	const seen = new Set(files);
	for (const [file, i] of infos) {
		if (seen.has(file)) continue;
		infos.delete(file);
		cache.delete(file);
		if (byId.get(i.id) === i) byId.delete(i.id);
	}
	for (const file of files) {
		if (infos.has(file)) continue;
		try {
			const m = JSON.parse(firstLine(file)) as { type?: string; payload?: { id?: string; cwd?: string; thread_source?: string; parent_thread_id?: string } };
			const p = m.payload;
			if (m.type !== "session_meta" || !p?.id || !p.cwd) continue;
			const info = { id: p.id, file, cwd: p.cwd, project: projectId(p.cwd), born: statSync(file).birthtimeMs, hidden: (!!p.thread_source && p.thread_source !== "user") || !!p.parent_thread_id };
			infos.set(file, info);
			byId.set(info.id, info);
		} catch {}
	}
}
let scanned = 0;
/** 所有（不是内部的）会话；5 秒内扫过就不再扫 */
function all() {
	if (Date.now() - scanned > 5000) {
		refresh();
		scanned = Date.now();
	}
	return [...byId.values()].filter((i) => !i.hidden && existsSync(i.file));
}
/** 这个 id 是不是 Codex 的会话（不认识的再扫一次目录：刚建的） */
export function find(id: string): Info | null {
	if ((!byId.has(id) || !existsSync(byId.get(id)!.file)) && /^[0-9a-f-]{36}$/.test(id)) refresh();
	const i = byId.get(id);
	return i && !i.hidden && existsSync(i.file) ? i : null;
}
/** 监视到的文件名（年/月/日/rollout-…-<id>.jsonl）→ 会话 */
export function fromPath(rel: string) {
	const m = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(rel);
	return m ? find(m[1]) : null;
}

/** 标题：session_index.jsonl，同一个 id 后写的算 */
let titles = { mtime: -1, map: new Map<string, string>() };
function title(id: string) {
	let m = 0;
	try { m = statSync(INDEX).mtimeMs; } catch {}
	if (m !== titles.mtime) {
		const map = new Map<string, string>();
		try {
			for (const l of readFileSync(INDEX, "utf8").split("\n")) {
				try { const d = JSON.parse(l) as { id?: string; thread_name?: string }; if (d.id && d.thread_name) map.set(d.id, d.thread_name); } catch {}
			}
		} catch {}
		titles = { mtime: m, map };
	}
	return titles.map.get(id) ?? null;
}

// —— 拼节点 ——
const CUT = 4000;
const cut = (s: string, n = CUT) => (s.length > n ? { text: s.slice(0, n), cut: true } : { text: s, cut: false });
const BRIEF_RESULT = 120;

type Raw = Record<string, any>; // biome-ignore lint: 记录是 Codex 的内部格式
/** 工具的输出：字符串，或者 [{type: input_text, text} | {type: input_image}]，老版本是 {content, success} */
function outputText(o: unknown): { text: string; error: boolean; images: number } {
	if (typeof o === "string") return { text: o, error: false, images: 0 };
	if (Array.isArray(o)) return { text: o.map((b: Raw) => (b?.type === "input_text" || b?.type === "output_text" ? b.text : b?.type === "input_image" ? "[图片]" : "")).join("\n"), error: false, images: 0 };
	const r = (o ?? {}) as Raw;
	return { text: typeof r.content === "string" ? r.content : JSON.stringify(r), error: r.success === false, images: 0 };
}
/** 工具调用的一行摘要：命令、路径、搜索词…… */
function summarize(name: string, input: string): string {
	try {
		const a = JSON.parse(input) as Raw;
		const cmd = Array.isArray(a.command) ? a.command.join(" ") : a.cmd ?? a.command;
		const pick = a.description ?? cmd ?? a.file_path ?? a.path ?? a.query ?? a.url ?? a.pattern ?? a.title ?? a.questions?.[0]?.title ?? a.prompt ?? "";
		if (pick) return String(pick).split("\n")[0].slice(0, 160);
	} catch {}
	// apply_patch、exec（一段 JS）这类原样的输入：第一行有意义的
	const line = input.split("\n").find((l) => l.trim() && !/^\*\*\* Begin Patch/.test(l)) ?? "";
	return (name === "apply_patch" ? line.replace(/^\*\*\* (Update|Add|Delete) File: /, "") : line).slice(0, 160);
}
/** 回答 Codex 提的问题（request_user_input）：记录里是一段 JSON，人说的是里面的 answer */
function answers(text: string): string | null {
	const m = /^\s*<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>\s*$/.exec(text);
	if (!m) return null;
	try {
		return (JSON.parse(m[1]) as { answer?: string }[]).map((x) => x.answer ?? "").filter(Boolean).join("\n");
	} catch {
		return null;
	}
}
const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

/** 拼的时候不用写 parent：add 接到上一个节点下面 */
type NoParent<T> = T extends unknown ? Omit<T, "parent"> : never;
type Parsed = {
	size: number;
	mtime: number;
	nodes: Node[];
	inputs: Map<string, string>;
	results: Map<string, string>;
	images: Map<string, { media: string; data: string }[]>;
	/** 节点在第几轮（分叉要按轮：thread/fork 的 lastTurnId） */
	turns: Map<string, string>;
	/** 节点是文件里第几条记录（ordinal）：分叉出来的会话只带原会话这条之前的 */
	ords: Map<string, number>;
	/** 这个会话用过的模型 → 上下文窗口 */
	windows: Record<string, number>;
	meta: { first: string | null; last: string | null; fresh: string | null; prompts: number; parent: string | null };
};
const cache = new Map<string, Parsed>();

/** 命令：「/bin/zsh -lc '…'」或 ["/bin/zsh", "-lc", "…"] → 里面那句（记录里和运行中的流里都这样显示） */
export function shellInner(cmd: unknown): string {
	if (Array.isArray(cmd)) return String(cmd.length === 3 && /sh$/.test(String(cmd[0])) && cmd[1] === "-lc" ? cmd[2] : cmd.join(" "));
	const s = String(cmd ?? "");
	const m = /^\/bin\/(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/.exec(s);
	return m ? m[2] : s;
}
/** 一个工具 item（记录里的 PascalCase 和流里的 camelCase 都认）→ 工具名、给网页的参数（JSON，按 tail.ts 的 summarize 挑一句显示） */
export function toolOf(item: Raw): { name: string; input: Raw } | null {
	const t = String(item.type ?? "").toLowerCase();
	if (t === "commandexecution") return { name: "exec_command", input: { command: shellInner(item.command) } };
	if (t === "filechange") {
		const ch = item.changes;
		const paths = Array.isArray(ch) ? ch.map((c: Raw) => String(c.path)) : Object.keys(ch ?? {});
		return { name: "apply_patch", input: { file_path: paths[0] ?? "", ...(paths.length > 1 ? { files: paths } : {}) } };
	}
	if (t === "mcptoolcall") return { name: String(item.tool ?? "mcp"), input: { description: item.arguments?.title, ...(item.arguments ?? {}) } };
	if (t === "websearch" || (t === "extension" && item.kind === "web.search")) return { name: "web_search", input: { query: item.query ?? item.action?.queries?.[0] ?? "" } };
	return null;
}
/** 工具 item 的结果：输出、出没出错 */
function resultOf(item: Raw): { text: string; error: boolean } {
	const t = String(item.type ?? "").toLowerCase();
	const failed = /fail|declin|error/i.test(String(item.status ?? ""));
	if (t === "commandexecution") {
		const code = item.exit_code ?? item.exitCode;
		const text = item.aggregated_output ?? item.aggregatedOutput ?? [item.stdout, item.stderr].filter(Boolean).join("\n");
		return { text: String(text ?? ""), error: failed || (typeof code === "number" && code !== 0) };
	}
	if (t === "filechange") return { text: String(item.stdout ?? item.stderr ?? ""), error: failed };
	if (t === "mcptoolcall") return { text: (item.result?.content ?? []).map((c: Raw) => (c?.type === "text" ? c.text : c?.type === "image" ? "[图片]" : "")).join("\n") || (item.error ? JSON.stringify(item.error) : ""), error: failed || !!item.error };
	return { text: (item.results ?? []).map((r: Raw) => [r.title, r.url].filter(Boolean).join(" ")).join("\n"), error: failed };
}

/**
 * 整个文件读一遍（变了就重读：Codex 的记录不大，也不像 Claude 那样要按 uuid 接）。
 * 新版本（有 item_completed 的）按 item 拼：id 和 app-server 流里的一样，运行中正在写的那段写进记录后能对上（key「item id:0」）；
 * 老版本按 response_item 拼。分叉出来的会话文件里只有自己的记录：前面接上原会话 forked_from_ordinal_exclusive 之前的节点
 */
async function parse(file: string): Promise<Parsed> {
	const st = statSync(file);
	const old = cache.get(file);
	if (old && old.size === st.size && old.mtime === st.mtimeMs) return old;
	const recs: Raw[] = [];
	for await (const { line } of lines(file)) {
		try { recs.push(JSON.parse(line)); } catch {}
	}
	const meta = (recs[0]?.type === "session_meta" ? recs[0].payload : {}) as Raw;
	const short = String(meta.id ?? "").slice(-8);
	const modern = recs.some((r) => r.type === "event_msg" && r.payload?.type === "item_completed");
	const p: Parsed = { size: st.size, mtime: st.mtimeMs, nodes: [], inputs: new Map(), results: new Map(), images: new Map(), turns: new Map(), ords: new Map(), windows: {}, meta: { first: null, last: null, fresh: null, prompts: 0, parent: null } };

	// 分叉：先接上原会话分叉点之前的
	const from = typeof meta.forked_from_id === "string" ? byId.get(meta.forked_from_id) : undefined;
	if (from && from.file !== file) {
		const base = await parse(from.file);
		const upto = typeof meta.forked_from_ordinal_exclusive === "number" ? meta.forked_from_ordinal_exclusive : Number.POSITIVE_INFINITY;
		p.nodes = base.nodes.filter((n) => (base.ords.get(n.uuid) ?? 0) < upto);
		for (const k of ["inputs", "results", "images", "turns", "ords"] as const) (p[k] as Map<string, unknown>) = new Map(base[k] as Map<string, unknown>);
		Object.assign(p.windows, base.windows);
		const users = p.nodes.filter((n) => n.k === "user") as Extract<Node, { k: "user" }>[];
		p.meta = { ...p.meta, first: users[0]?.text.slice(0, 200) ?? null, last: users.at(-1)?.text.slice(0, 200) ?? null, prompts: users.length, parent: from.id };
	}

	const tools = new Map<string, Extract<Node, { k: "tool" }>>();
	let model = "";
	let window = 0;
	let turn = "";
	let ord = 0;
	const add = (n: NoParent<Node>) => {
		const node = { ...n, parent: p.nodes[p.nodes.length - 1]?.uuid ?? null } as Node;
		p.nodes.push(node);
		if (turn) p.turns.set(node.uuid, turn);
		p.ords.set(node.uuid, ord);
		return node;
	};
	const human = (uuid: string, ts: string, raw: string, images: string[]) => {
		const text = (answers(raw) ?? raw).trim();
		const imgs = images.flatMap((u) => { const m = /^data:([^;]+);base64,(.*)$/s.exec(u); return m ? [{ media: m[1], data: m[2] }] : []; });
		if (imgs.length) p.images.set(uuid, imgs);
		add({ k: "user", uuid, ts, text, images: imgs.length });
		p.meta.prompts++;
		p.meta.first ??= text.slice(0, 200);
		p.meta.fresh ??= text.slice(0, 200);
		p.meta.last = text.slice(0, 200);
	};
	const tool = (uuid: string, ts: string, id: string, name: string, input: string, summary: string, key?: string) => {
		p.inputs.set(id, pretty(input));
		const t = add({ k: "tool", uuid, ts, id, name, summary, input: cut(pretty(input), 400).text, result: null, resultUuid: null, agent: null, ...(key ? { key } : {}) }) as Extract<Node, { k: "tool" }>;
		tools.set(id, t);
		return t;
	};
	const done = (t: Extract<Node, { k: "tool" }>, text: string, error: boolean) => {
		p.results.set(t.id, text);
		const c = cut(text, BRIEF_RESULT);
		t.result = { text: c.text, cut: c.cut, error, images: 0 };
	};

	for (const [no, r] of recs.entries()) {
		const uuid = `${short}-${no}`;
		ord = typeof r.ordinal === "number" ? r.ordinal : no;
		const ts = String(r.timestamp ?? "");
		const d = (r.payload ?? {}) as Raw;
		const tid = d.turn_id ?? d.internal_chat_message_metadata_passthrough?.turn_id;
		if (typeof tid === "string") turn = tid;
		if (r.type === "turn_context" && typeof d.model === "string") model = d.model;
		else if (r.type === "compacted") add({ k: "event", uuid, ts, kind: "compact", text: "上下文已压缩", ...(d.message ? { detail: String(d.message) } : {}) });
		else if (r.type === "event_msg") {
			if (d.type === "user_message" && !modern) human(uuid, ts, String(d.message ?? ""), Array.isArray(d.images) ? d.images.map(String) : []);
			else if (d.type === "turn_aborted") add({ k: "event", uuid, ts, kind: "info", text: "被打断了" });
			else if (d.type === "context_compacted" && !(p.nodes.at(-1)?.k === "event" && (p.nodes.at(-1) as Raw).kind === "compact")) add({ k: "event", uuid, ts, kind: "compact", text: "上下文已压缩" });
			else if (d.type === "task_started" && typeof d.model_context_window === "number") window = d.model_context_window;
			else if (d.type === "token_count" && d.info) {
				const u = d.info.last_token_usage as Raw | undefined;
				if (typeof d.info.model_context_window === "number") window = d.info.model_context_window;
				if (model && window) p.windows[model] = window;
				// 用量记在最近一个 Codex 的节点上（和 Claude 的一样，网页取路上最后一个带 ctx 的）
				const last = [...p.nodes].reverse().find((n) => n.k !== "user" && n.k !== "event") as Raw | undefined;
				if (u && last && model) last.ctx = { used: (u.input_tokens ?? 0) + (u.output_tokens ?? 0), model };
			} else if (d.type === "item_completed" && d.item) {
				// 新版本：一个 item 一个节点，uuid 用 item 的 id
				const it = d.item as Raw;
				const id = String(it.id ?? uuid);
				const key = `${id}:0`;
				if (it.type === "UserMessage") {
					const content = (it.content ?? []) as Raw[];
					human(id, ts, content.map((c) => (c?.type === "text" ? c.text : "")).join(""), content.flatMap((c) => (c?.type === "image" && typeof c.url === "string" ? [c.url] : [])));
				} else if (it.type === "AgentMessage") {
					const text = (it.content ?? []).map((c: Raw) => c?.text ?? "").join("");
					if (text.trim()) add({ k: "assistant", uuid: id, ts, text, key });
				} else if (it.type === "Reasoning") {
					const text = [...(it.summary_text ?? it.summary ?? [])].map(String).filter(Boolean).join("\n\n");
					if (text.trim()) add({ k: "thinking", uuid: id, ts, text, key });
				} else {
					const t = toolOf(it);
					if (!t) continue;
					const input = JSON.stringify(t.input);
					const node = tool(id, ts, id, t.name, input, summarize(t.name, input), key);
					const res = resultOf(it);
					done(node, res.text, res.error);
				}
			}
		} else if (r.type === "response_item" && !modern) {
			// 老版本：按 response_item 拼
			if (d.type === "message" && d.role === "assistant") {
				const text = (d.content ?? []).map((c: Raw) => (c?.type === "output_text" ? c.text : "")).join("");
				if (text.trim()) add({ k: "assistant", uuid, ts, text });
			} else if (d.type === "reasoning") {
				const text = (d.summary ?? []).map((s: Raw) => s?.text ?? "").filter(Boolean).join("\n\n");
				if (text.trim()) add({ k: "thinking", uuid, ts, text });
			} else if (d.type === "function_call" || d.type === "custom_tool_call" || d.type === "local_shell_call" || d.type === "web_search_call") {
				const id = String(d.call_id ?? d.id ?? uuid);
				const name = d.type === "web_search_call" ? "web_search" : d.type === "local_shell_call" ? "shell" : String(d.name ?? "tool");
				const input = d.type === "function_call" ? String(d.arguments ?? "") : d.type === "custom_tool_call" ? String(d.input ?? "") : JSON.stringify(d.action ?? {});
				const t = tool(uuid, ts, id, name, input, summarize(name, input));
				// 网页搜索没有单独的结果记录：搜过就算完成
				if (d.type === "web_search_call") done(t, "", false);
			} else if (d.type === "function_call_output" || d.type === "custom_tool_call_output" || d.type === "local_shell_call_output") {
				const t = tools.get(String(d.call_id ?? ""));
				if (!t) continue;
				const o = outputText(d.output);
				// 命令的输出里写着退出码：不是 0 算出错
				const code = /Process exited with code (\d+)/.exec(o.text)?.[1] ?? /"exit_code":\s*(\d+)/.exec(o.text)?.[1];
				done(t, o.text, o.error || (!!code && code !== "0"));
			}
		}
	}
	cache.set(file, p);
	return p;
}

// —— 给 sessions.ts 的：和 Claude 的会话一样的样子 ——
async function metaOf(i: Info) {
	const st = statSync(i.file);
	const p = await parse(i.file);
	return {
		id: i.id,
		agent: "codex" as const,
		title: title(i.id),
		first: p.meta.first,
		last: p.meta.last,
		fresh: p.meta.fresh,
		prompts: p.meta.prompts,
		size: st.size,
		mtime: st.mtime.toISOString(),
		active: Date.now() - st.mtimeMs < 90_000,
		root: null,
		born: i.born,
		// 分叉出来的（forked_from_id）：挂在原会话下面
		parent: p.meta.parent,
		unread: null,
	};
}

/** 有 Codex 会话的文件夹：项目 id、路径、几个会话、最近修改 */
export function projects() {
	const m = new Map<string, { id: string; path: string; sessions: number; mtime: number }>();
	for (const i of all()) {
		const p = m.get(i.project) ?? { id: i.project, path: i.cwd, sessions: 0, mtime: 0 };
		p.sessions++;
		p.mtime = Math.max(p.mtime, statSync(i.file).mtimeMs);
		m.set(i.project, p);
	}
	return [...m.values()];
}

/** 一个文件夹里的 Codex 会话（第一次要整个读一遍，之后文件没变就用缓存） */
export const list = (project: string) => Promise.all(all().filter((i) => i.project === project).map(metaOf));

/** 一个会话。没变（version 对得上）就只回「没变」，不再发一遍 */
export async function session(i: Info, since?: string | null) {
	const p = await parse(i.file);
	const version = `codex:${p.size}:${p.mtime}`;
	const same = since === version;
	return { meta: await metaOf(i), nodes: same ? [] : p.nodes, delta: same, version, windows: p.windows, model: null };
}

export async function toolDetail(i: Info, id: string) {
	const p = await parse(i.file);
	const input = p.inputs.get(id);
	if (input === undefined) return null;
	const r = p.results.get(id);
	const res = r === undefined ? null : cut(r);
	return { input: cut(input, 20_000).text, result: res?.text ?? null, cut: res?.cut ?? false };
}
export const fullResult = async (i: Info, id: string) => (await parse(i.file)).results.get(id) ?? null;
export const image = async (i: Info, uuid: string, n: number) => (await parse(i.file)).images.get(uuid)?.[n] ?? null;
/** 这个节点在第几轮（从它分叉：thread/fork 的 lastTurnId） */
export const turnOf = async (i: Info, uuid: string) => (await parse(i.file)).turns.get(uuid) ?? null;
