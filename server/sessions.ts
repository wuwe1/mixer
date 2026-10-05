// 读 Claude Code 的会话记录（~/.claude/projects/<项目>/<会话 id>.jsonl）。
// 记录是 Claude Code 内部格式，会随版本变；这里只依赖几样东西：uuid / parentUuid 连成一棵树，type 是 user / assistant / system / attachment，
// message.content 是字符串或 [{type: text | thinking | tool_use | tool_result | image}]。认不出的记录一律跳过，不报错。
//
// 给页面的是「显示节点」：用户的话、Claude 的话、思考、工具调用（结果挂在调用上）、几种事件。
// 不显示的记录（附带的系统信息、元数据）被跳过，显示节点的 parent 指向最近的显示祖先。
// 这样一来：并行的工具调用（结果挂在各自的调用下）不会被当成分叉；只有真正的分支（比如改了问题重发）才是一个节点有多个子节点。
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ourLastWrite, unread } from "./state.ts";

export const PROJECTS = join(homedir(), ".claude", "projects");

/** 按 \n 一行一行读。不用 node:readline：它把 U+2028、U+2029 也当换行，而工具结果里会出现这两个字符，一条记录就被切断了 */
async function* lines(file: string): AsyncGenerator<string> {
	let rest = "";
	for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
		rest += chunk;
		let i: number;
		while ((i = rest.indexOf("\n")) >= 0) {
			yield rest.slice(0, i);
			rest = rest.slice(i + 1);
		}
	}
	if (rest) yield rest;
}

type Raw = Record<string, any>; // biome-ignore lint: 内部格式，没有类型

export type Node =
	| { k: "user"; uuid: string; parent: string | null; ts: string; text: string; images: number; queued?: boolean }
	| { k: "assistant"; uuid: string; parent: string | null; ts: string; text: string }
	| { k: "thinking"; uuid: string; parent: string | null; ts: string; text: string }
	| {
			k: "tool";
			uuid: string;
			parent: string | null;
			ts: string;
			id: string;
			name: string;
			summary: string;
			input: string;
			result: { text: string; error: boolean; cut: boolean; images: number } | null;
			/** 结果所在那条 user 记录：从这一步分叉要用它（用工具调用那条，结果就丢了） */
			resultUuid: string | null;
			agent: string | null;
	  }
	| {
			k: "event";
			uuid: string;
			parent: string | null;
			ts: string;
			/** summary 离开时的小结；compact 上下文压缩；info 系统提示（比如用量到了）；task 后台任务（子代理、后台命令）的通知；agent 子代理发回来的回报 */
			kind: "summary" | "compact" | "info" | "task" | "agent";
			text: string;
			/** 点开才看的：压缩前的摘要、任务的结果 */
			detail?: string;
			/** 任务的状态：completed / failed / killed …… */
			status?: string;
			/** 对应的子代理（有它的记录才给），能打开看它的对话 */
			agent?: string;
	  };

export type SessionMeta = {
	id: string;
	title: string | null;
	first: string | null;
	last: string | null;
	/** 这个文件自己的第一句（分叉出来的会话，前面的记录是从原会话复制来的，时间早于文件建立） */
	fresh: string | null;
	prompts: number;
	size: number;
	mtime: string;
	active: boolean;
	/** 第一条记录的 uuid。分叉（--fork-session）出来的会话把原会话的记录原样复制过去，第一条 uuid 相同，靠它认出谁从谁分出来 */
	root: string | null;
	born: number;
	/** 从哪个会话分叉出来的（同一个项目里 root 相同、比它早建的那个） */
	parent: string | null;
	unread: "done" | "error" | null;
};

const CUT = 4000;
const cut = (s: string, n = CUT) => (s.length > n ? { text: s.slice(0, n), cut: true } : { text: s, cut: false });

/** 项目目录名 → 真实路径：从会话记录的 cwd 里取（目录名是把路径里的符号换成 - 的，反推不唯一） */
function projectPath(dir: string): string | null {
	const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	for (const f of files) {
		const head = readFileSync(join(dir, f), { encoding: "utf8", flag: "r" }).slice(0, 200_000);
		const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
		if (m) return JSON.parse(`"${m[1]}"`);
	}
	return null;
}

export function listProjects() {
	if (!existsSync(PROJECTS)) return [];
	return readdirSync(PROJECTS, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => {
			const dir = join(PROJECTS, d.name);
			const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
			const mtime = Math.max(0, ...files.map((f) => statSync(join(dir, f)).mtimeMs));
			return { id: d.name, path: projectPath(dir), sessions: files.length, mtime: new Date(mtime).toISOString() };
		})
		.filter((p) => p.sessions > 0)
		.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

const metaCache = new Map<string, { mtime: number; meta: SessionMeta }>();

/** 扫一遍文件拿标题、第一句和最后一句、提问次数（按 mtime 缓存） */
async function scanMeta(file: string): Promise<SessionMeta> {
	const st = statSync(file);
	const hit = metaCache.get(file);
	if (hit && hit.mtime === st.mtimeMs) return hit.meta;
	let title: string | null = null;
	let first: string | null = null;
	let last: string | null = null;
	let prompts = 0;
	let root: string | null = null;
	let fresh: string | null = null;
	for await (const line of lines(file)) {
		// 只解析可能有用的行，图片 base64 那种大行先看开头
		if (line.startsWith('{"type":"ai-title"')) {
			try { title = JSON.parse(line).aiTitle ?? title; } catch {}
			continue;
		}
		if (!line.includes('"type":"user"') || line.includes('"tool_result"')) continue;
		let d: Raw;
		try { d = JSON.parse(line); } catch { continue; }
		if (d.uuid) root ??= d.uuid;
		const t = promptText(d);
		if (t === null) continue;
		prompts++;
		first ??= t.slice(0, 200);
		last = t.slice(0, 200);
		if (!fresh && Date.parse(d.timestamp) >= st.birthtimeMs - 2000) fresh = t.slice(0, 200);
	}
	const meta: SessionMeta = {
		id: basename(file, ".jsonl"),
		title,
		first,
		last,
		fresh,
		prompts,
		size: st.size,
		mtime: st.mtime.toISOString(),
		active: Date.now() - st.mtimeMs < 90_000,
		root,
		born: st.birthtimeMs,
		parent: null,
		unread: null,
	};
	metaCache.set(file, { mtime: st.mtimeMs, meta });
	return meta;
}

export async function listSessions(project: string): Promise<SessionMeta[]> {
	const dir = join(PROJECTS, safe(project));
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	const metas = (await Promise.all(files.map((f) => scanMeta(join(dir, f))))).map((m) => ({
		...m,
		active: Date.now() - Date.parse(m.mtime) < 90_000 && !ourLastWrite(m.id, Date.parse(m.mtime)),
		unread: unread(m.id),
	}));
	// 分叉：root 相同的一家，最早建的是原会话，其余都挂在它下面
	const families = new Map<string, SessionMeta[]>();
	for (const m of metas) if (m.root) families.set(m.root, [...(families.get(m.root) ?? []), m]);
	for (const fam of families.values()) {
		if (fam.length < 2) continue;
		fam.sort((a, b) => a.born - b.born);
		for (const m of fam.slice(1)) m.parent = fam[0].id;
	}
	return metas.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** 所有项目和它们的会话（侧栏用） */
export async function tree() {
	return Promise.all(listProjects().map(async (p) => ({ ...p, sessions: await listSessions(p.id) })));
}

/** user 记录里的文字（字符串或 text 块拼起来）；工具结果、元信息返回 null */
function userText(d: Raw): string | null {
	if (d.type !== "user" || d.isMeta) return null;
	const c = d.message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c) || c.some((b) => b?.type === "tool_result")) return null;
	const t = c.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
	return t || (c.some((b) => b?.type === "image") ? "" : null);
}

/** 系统借 user 消息塞进来的东西（后台任务通知、命令输出、提醒），不算人说的话 */
const SYSTEM = /^\s*<(task-notification|command-name|command-message|local-command|system-reminder|bash-input|bash-stdout)/;

/** 用户真正说的话；不是就返回 null */
function promptText(d: Raw): string | null {
	if (d.isCompactSummary) return null;
	const t = userText(d);
	return t === null || SYSTEM.test(t) ? null : t;
}

const tag = (t: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(t)?.[1]?.trim();
/** 1234567 → 123.5 万 */
const wan = (n: number) => (n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万` : String(n));

/** 子代理发回来的回报（<agent-message from="…">）：去掉外面那层说明，只留回报本身 */
function agentReport(t: string) {
	const from = /<agent-message from="([^"]+)"/.exec(t)?.[1];
	let body = t.replace(/^\s*<agent-message[^>]*>\s*/, "").replace(/\s*<\/agent-message>\s*$/, "");
	const i = body.indexOf("The report follows:");
	if (i >= 0) body = body.slice(i + "The report follows:".length);
	return { from, body: body.split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n").trim() };
}

const resultText = (c: unknown): string => {
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[图片]" : "")).join("\n");
	return "";
};

/** 工具调用的一行摘要：命令、文件路径、搜索词…… */
function summarize(input: Raw): string {
	const pick = input.description ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.prompt ?? input.skill ?? "";
	return String(pick).split("\n")[0].slice(0, 160);
}

type Parsed = { nodes: Node[]; images: Map<string, { media: string; data: string }[]>; results: Map<string, string>; raw: Map<string, Raw> };
const cache = new Map<string, { mtime: number; parsed: Parsed }>();

/** 读一个会话（或子 agent）的记录，变成显示节点 */
export async function parse(file: string): Promise<Parsed> {
	const st = statSync(file);
	const hit = cache.get(file);
	if (hit && hit.mtime === st.mtimeMs) return hit.parsed;
	const raw = new Map<string, Raw>();
	const order: Raw[] = [];
	for await (const line of lines(file)) {
		if (!line.startsWith("{")) continue;
		let d: Raw;
		try { d = JSON.parse(line); } catch { continue; }
		// 同一条记录有时会被原样再追加一次（同一个 uuid）：只认第一次
		if (!d.uuid || raw.has(d.uuid)) continue;
		raw.set(d.uuid, d);
		order.push(d);
	}
	const shown = new Map<string, Node>();
	const tools = new Map<string, Extract<Node, { k: "tool" }>>();
	const images = new Map<string, { media: string; data: string }[]>();
	const results = new Map<string, string>();
	const nodes: Node[] = [];
	const base = (d: Raw) => ({ uuid: d.uuid as string, parent: null as string | null, ts: d.timestamp as string });
	// 子代理的记录在 <会话>/subagents/agent-<id>.jsonl；有才给 id，网页上能点开看
	const agentOf = (id: string | undefined) => (id && /^[\w-]+$/.test(id) && existsSync(join(file.replace(/\.jsonl$/, ""), "subagents", `agent-${id}.jsonl`)) ? id : undefined);
	const task = (d: Raw, t: string): Node => {
		const detail = tag(t, "result");
		return { k: "event", ...base(d), kind: "task", text: tag(t, "summary") ?? tag(t, "status") ?? "后台任务有了结果", status: tag(t, "status"), detail, agent: agentOf(tag(t, "task-id")) };
	};
	const report = (d: Raw, t: string): Node => {
		const r = agentReport(t);
		return { k: "event", ...base(d), kind: "agent", text: r.body, agent: agentOf(r.from) };
	};
	let compact: Extract<Node, { k: "event" }> | null = null;

	for (const d of order) {
		const c = d.message?.content;
		let n: Node | null = null;
		if (d.type === "user") {
			const t = promptText(d);
			if (t !== null) {
				const imgs = Array.isArray(c) ? c.filter((b) => b?.type === "image" && b.source?.type === "base64") : [];
				if (imgs.length) images.set(d.uuid, imgs.map((b) => ({ media: b.source.media_type, data: b.source.data })));
				n = { k: "user", ...base(d), text: t, images: imgs.length };
			} else if (d.isCompactSummary) {
				// 压缩后接上的摘要：挂到刚才那条「上下文已压缩」上，点开看
				if (compact) compact.detail = userText({ ...d, isMeta: false }) ?? undefined;
			} else if (SYSTEM.test(userText(d) ?? "")) {
				// 后台任务的通知：一条事件；命令输出、提醒不显示
				const t = userText(d) ?? "";
				if (t.includes("<task-notification>")) n = task(d, t);
			} else if (Array.isArray(c)) {
				// 工具结果：挂到对应的调用上，不单独成节点
				for (const b of c) {
					if (b?.type !== "tool_result") continue;
					const text = resultText(b.content);
					results.set(b.tool_use_id, text);
					// 结果里的图片（读图片文件、截图）：按工具调用的 id 存，和人发的图片共用一个接口
					const imgs = Array.isArray(b.content) ? b.content.filter((x: Raw) => x?.type === "image" && x.source?.type === "base64") : [];
					if (imgs.length) images.set(b.tool_use_id, imgs.map((x: Raw) => ({ media: x.source.media_type, data: x.source.data })));
					const tool = tools.get(b.tool_use_id);
					if (tool) {
						const { text: t2, cut: cutted } = cut(text);
						tool.result = { text: t2, error: !!b.is_error, cut: cutted, images: imgs.length };
						tool.resultUuid = d.uuid;
						const m = /agentId: (a[0-9a-f]+)/.exec(text);
						if (m) tool.agent = m[1];
					}
				}
			}
		} else if (d.type === "assistant" && Array.isArray(c)) {
			// 一条 assistant 记录一个内容块
			const b = c[0];
			if (b?.type === "text" && b.text?.trim()) n = { k: "assistant", ...base(d), text: b.text };
			else if (b?.type === "thinking" && b.thinking?.trim()) n = { k: "thinking", ...base(d), text: b.thinking };
			else if (b?.type === "tool_use") {
				const input = JSON.stringify(b.input ?? {}, null, 2);
				const tool: Extract<Node, { k: "tool" }> = {
					k: "tool",
					...base(d),
					id: b.id,
					name: b.name,
					summary: summarize(b.input ?? {}),
					input: cut(input).text,
					result: null,
					resultUuid: null,
					agent: null,
				};
				tools.set(b.id, tool);
				n = tool;
			}
		} else if (d.type === "system") {
			if (d.subtype === "away_summary" && d.content) n = { k: "event", ...base(d), kind: "summary", text: String(d.content) };
			else if (d.subtype === "compact_boundary") {
				const m = d.compactMetadata;
				const how = m ? `（${m.trigger === "auto" ? "自动" : "手动"}${m.preTokens && m.postTokens ? ` · ${wan(m.preTokens)} → ${wan(m.postTokens)} token` : ""}）` : "";
				n = compact = { k: "event", ...base(d), kind: "compact", text: `上下文已压缩${how}` };
			} else if (d.subtype === "informational" && d.content) n = { k: "event", ...base(d), kind: "info", text: String(d.content) };
		} else if (d.type === "attachment" && d.attachment?.type === "queued_command" && d.attachment.prompt) {
			// 跑的过程中插进来的：可能是人在终端里打的，也可能是任务通知、子代理的回报
			const t = String(d.attachment.prompt);
			if (d.attachment.commandMode === "task-notification" || t.trimStart().startsWith("<task-notification>")) n = task(d, t);
			else if (t.trimStart().startsWith("<agent-message")) n = report(d, t);
			else n = { k: "user", ...base(d), text: t, images: 0, queued: true };
		}
		if (!n) continue;
		// parent：沿 parentUuid 往上找最近的显示节点
		// 压缩那条的 parentUuid 是空的（logicalParentUuid 指的是压缩之后的记录，靠不住）：压缩发生在当时那条分支的末尾，接在它前面最后一个显示节点上
		let p = (d.parentUuid ?? (d.subtype === "compact_boundary" ? nodes[nodes.length - 1]?.uuid : null) ?? null) as string | null;
		for (let hops = 0; p && !shown.has(p) && hops < 100_000; hops++) p = raw.get(p)?.parentUuid ?? null;
		n.parent = p;
		shown.set(n.uuid, n);
		nodes.push(n);
	}
	const parsed = { nodes, images, results, raw };
	cache.set(file, { mtime: st.mtimeMs, parsed });
	return parsed;
}

/** 项目目录名、会话 id 只许是安全的字符 */
export function safe(s: string): string {
	if (!/^[\w.-]+$/.test(s)) throw new Error(`不合法的名字：${s}`);
	return s;
}

export const sessionFile = (project: string, id: string) => join(PROJECTS, safe(project), `${safe(id)}.jsonl`);
export const agentFile = (project: string, id: string, agent: string) => join(PROJECTS, safe(project), safe(id), "subagents", `agent-${safe(agent)}.jsonl`);

export async function session(project: string, id: string) {
	const file = sessionFile(project, id);
	const [{ nodes }, metas] = await Promise.all([parse(file), listSessions(project)]);
	return { meta: metas.find((m) => m.id === id) ?? (await scanMeta(file)), nodes };
}

export async function agent(project: string, id: string, agentId: string) {
	const file = agentFile(project, id, agentId);
	if (!existsSync(file)) return null;
	const { nodes } = await parse(file);
	let info: Raw = {};
	try { info = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch {}
	return { id: agentId, info, nodes };
}

export async function fullResult(project: string, id: string, toolUseId: string, agentId?: string) {
	const { results } = await parse(agentId ? agentFile(project, id, agentId) : sessionFile(project, id));
	return results.get(toolUseId) ?? null;
}

/** 人发的图片（按消息的 uuid）或工具结果里的图片（按工具调用的 id） */
export async function image(project: string, id: string, uuid: string, i: number, agentId?: string) {
	const { images } = await parse(agentId ? agentFile(project, id, agentId) : sessionFile(project, id));
	return images.get(uuid)?.[i] ?? null;
}
