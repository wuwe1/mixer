// 读 Claude Code 的会话记录（~/.claude/projects/<项目>/<会话 id>.jsonl）。
// 记录是 Claude Code 内部格式，会随版本变；这里只依赖几样东西：uuid / parentUuid 连成一棵树，type 是 user / assistant / system / attachment，
// message.content 是字符串或 [{type: text | thinking | tool_use | tool_result | image}]。认不出的记录一律跳过，不报错。
//
// 给页面的是「显示节点」：用户的话、Claude 的话、思考、工具调用（结果挂在调用上）、几种事件。
// 不显示的记录（附带的系统信息、元数据）被跳过，显示节点的 parent 指向最近的显示祖先。
// 这样一来：并行的工具调用（结果挂在各自的调用下）不会被当成分叉；只有真正的分支（比如改了问题重发）才是一个节点有多个子节点。
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as codex from "./codex.ts";
import { lines } from "./jsonl.ts";
import { summarize } from "../web/src/lib/tail.ts";
import { chosenModel, ourLastWrite, unread, windows } from "./state.ts";

export const PROJECTS = join(homedir(), ".claude", "projects");

/**
 * 记录只会往后追加：记下读到哪个字节，文件变了只读新写的部分。
 * 没变（大小、修改时间都一样）就是 "same"；变短了或者换了个文件（inode 不同）就得从头读
 */
type Cursor = { ino: number; size: number; mtime: number; offset: number };
const resume = (c: Cursor | undefined, st: Stats) =>
	!c || c.ino !== st.ino || st.size < c.offset ? "fresh" : c.size === st.size && c.mtime === st.mtimeMs ? "same" : "more";

/** 同一个文件一次只让一个人往下读：两个同时从同一处接着读，新的记录会算两遍 */
const locks = new Map<string, Promise<unknown>>();
function serial<T>(key: string, f: () => Promise<T>): Promise<T> {
	const p = (locks.get(key) ?? Promise.resolve()).then(f, f);
	locks.set(key, p.catch(() => {}));
	return p;
}

type Raw = Record<string, any>; // biome-ignore lint: 内部格式，没有类型

/** 这条回复发出时上下文里有多少 token（输入 + 缓存读 + 缓存写），和用的模型：窗口多大按模型查 */
type Ctx = { used: number; model: string };
/** 「消息 id : 第几段」：和运行输出流里的同一段对得上，网页靠它把正在写的换成记录里的 */
type Key = { key?: string };

export type Node =
	| { k: "user"; uuid: string; parent: string | null; ts: string; text: string; images: number; queued?: boolean }
	| ({ k: "assistant"; uuid: string; parent: string | null; ts: string; text: string; ctx?: Ctx } & Key)
	| ({ k: "thinking"; uuid: string; parent: string | null; ts: string; text: string; ctx?: Ctx } & Key)
	| {
			k: "tool";
			ctx?: Ctx;
			key?: string;
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
	/** Codex 的会话（codex.ts）；没有就是 Claude Code 的 */
	agent?: "codex";
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
/**
 * 节点里的工具参数只是个预览：长字符串截短，结构留着（文件路径还认得出来）。
 * 工具调用平时收着，完整的参数、结果点开时再拿（toolDetail）：大会话一下少发三分之二
 */
const PATHS = new Set(["file_path", "notebook_path", "path"]);
const brief = (input: unknown) => cut(JSON.stringify(input, (k, v) => (typeof v === "string" && !PATHS.has(k) && v.length > 80 ? `${v.slice(0, 80)}…` : v), 2), 400).text;
const BRIEF_RESULT = 120;

/** 项目目录名 → 真实路径：从会话记录的 cwd 里取（目录名是把路径里的符号换成 - 的，反推不唯一）。路径不会变，找到了就一直用 */
const paths = new Map<string, string>();
function projectPath(dir: string): string | null {
	const hit = paths.get(dir);
	if (hit) return hit;
	const buf = Buffer.alloc(200_000);
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
		// 只读开头：一个会话能有几百 MB
		const fd = openSync(join(dir, f), "r");
		let n: number;
		try { n = readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
		const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString("utf8", 0, n));
		if (!m) continue;
		const path = JSON.parse(`"${m[1]}"`) as string;
		paths.set(dir, path);
		return path;
	}
	return null;
}

export function listProjects() {
	const claude = !existsSync(PROJECTS) ? [] : readdirSync(PROJECTS, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => {
			const dir = join(PROJECTS, d.name);
			const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
			const mtime = Math.max(0, ...files.map((f) => statSync(join(dir, f)).mtimeMs));
			return { id: d.name, path: projectPath(dir), sessions: files.length, mtime: new Date(mtime).toISOString() };
		})
		.filter((p) => p.sessions > 0);
	// Codex 的会话按 cwd 算出同样的项目 id：同一个文件夹的并到一起，只有 Codex 会话的文件夹另加
	const by = new Map(claude.map((p) => [p.id, p]));
	for (const c of codex.projects()) {
		const p = by.get(c.id);
		const mtime = new Date(c.mtime).toISOString();
		if (!p) by.set(c.id, { ...c, mtime });
		else {
			p.sessions += c.sessions;
			p.path ??= c.path;
			if (mtime > p.mtime) p.mtime = mtime;
		}
	}
	return [...by.values()].sort((a, b) => b.mtime.localeCompare(a.mtime));
}

type Scan = Cursor & { title: string | null; first: string | null; last: string | null; prompts: number; root: string | null; fresh: string | null };
const metaCache = new Map<string, Scan>();

/** 扫文件拿标题、第一句和最后一句、提问次数（接着上次读到的地方往下扫） */
const scanMeta = (file: string) => serial(`meta:${file}`, () => scan(file));
async function scan(file: string): Promise<SessionMeta> {
	const st = statSync(file);
	let s = metaCache.get(file);
	const how = resume(s, st);
	if (how === "fresh" || !s) s = { ino: st.ino, size: 0, mtime: 0, offset: 0, title: null, first: null, last: null, prompts: 0, root: null, fresh: null };
	if (how !== "same") {
		for await (const { line, end } of lines(file, s.offset)) {
			s.offset = end;
			// 只解析可能有用的行，图片 base64 那种大行先看开头
			if (line.startsWith('{"type":"ai-title"')) {
				try { s.title = JSON.parse(line).aiTitle ?? s.title; } catch {}
				continue;
			}
			if (!line.includes('"type":"user"') || line.includes('"tool_result"')) continue;
			let d: Raw;
			try { d = JSON.parse(line); } catch { continue; }
			if (d.uuid) s.root ??= d.uuid;
			const t = promptText(d);
			if (t === null) continue;
			s.prompts++;
			s.first ??= t.slice(0, 200);
			s.last = t.slice(0, 200);
			if (!s.fresh && Date.parse(d.timestamp) >= st.birthtimeMs - 2000) s.fresh = t.slice(0, 200);
		}
		// 读的时候文件可能又长了：记的是开读前的大小，下次还会接着读
		s.size = st.size;
		s.mtime = st.mtimeMs;
		metaCache.set(file, s);
	}
	return {
		id: basename(file, ".jsonl"),
		title: s.title,
		first: s.first,
		last: s.last,
		fresh: s.fresh,
		prompts: s.prompts,
		size: st.size,
		mtime: st.mtime.toISOString(),
		active: Date.now() - st.mtimeMs < 90_000,
		root: s.root,
		born: st.birthtimeMs,
		parent: null,
		unread: null,
	};
}

export async function listSessions(project: string): Promise<SessionMeta[]> {
	const dir = join(PROJECTS, safe(project));
	const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
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
	const others: SessionMeta[] = (await codex.list(project)).map((m) => ({ ...m, unread: unread(m.id) }));
	return [...metas, ...others].sort((a, b) => b.mtime.localeCompare(a.mtime));
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

/**
 * 调用 skill（/名字 参数）：记录里先是一条 <command-name>，下一条 isMeta 的是 skill 的正文（Base directory for this skill: …）。
 * 正文那条换成人说的「/名字 参数」；/clear、/model 这类终端里的命令后面没有正文，还是不显示
 */
function skillCall(d: Raw, commands: Map<string, string>): string | null {
	if (!d.isMeta || !d.parentUuid) return null;
	const c = d.message?.content;
	const body = typeof c === "string" ? c : Array.isArray(c) ? (c[0]?.text ?? "") : "";
	if (!String(body).startsWith("Base directory for this skill:")) return null;
	const t = commands.get(d.parentUuid) ?? "";
	const name = tag(t, "command-name");
	if (!name) return null;
	const args = tag(t, "command-args");
	return args ? `${name} ${args}` : name;
}

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
type Tool = Extract<Node, { k: "tool" }>;
/**
 * 一个会话读到哪了、拼成的节点，文件长了接着往下读。
 * 节点新建、后来又改了（工具有了结果、压缩有了摘要）记一个递增的 rev：网页带着上次拿到的「epoch:rev」来，只给它之后变了的节点。
 * 从头重读换一个 epoch，网页手里的对不上就给全部
 */
type Parsed = Cursor & {
	epoch: string;
	rev: number;
	revs: Map<string, number>;
	nodes: Node[];
	images: Map<string, { media: string; data: string }[]>;
	results: Map<string, string>;
	/** 工具调用的完整参数（排好版的 JSON），按工具调用的 id */
	inputs: Map<string, string>;
	/** 每条记录的 parentUuid：找最近的显示祖先用。原记录不留，带图片的 base64 太占内存 */
	parents: Map<string, string | null>;
	/** <command-name> 那几条 user 记录的文字：下一条是 skill 正文时要用 */
	commands: Map<string, string>;
	shown: Set<string>;
	tools: Map<string, Tool>;
	/** 同一条消息的每一段各是一条 assistant 记录：按文件顺序数，第几条就是第几段（空的思考也算一段） */
	blockNo: Map<string, number>;
	compact: Extract<Node, { k: "event" }> | null;
	/** parentUuid 指向的记录还没读到（偶尔先写回复、后写它挂着的附带记录）：先当根，那条读到了再找 */
	waiting: Map<string, Node[]>;
};
/**
 * 读过的会话留在内存里（文件长了接着读），按最近用过的排；加起来超过 200MB（按文件大小算，图片的 base64 也在里面）
 * 就丢掉最久没用的，下次打开从头读。正在用的那个不丢
 */
const cache = new Map<string, Parsed>();
const BUDGET = 200 * 1024 * 1024;
function keep(file: string, p: Parsed) {
	cache.delete(file);
	cache.set(file, p);
	let total = 0;
	for (const x of cache.values()) total += x.size;
	for (const [f, x] of cache) {
		if (total <= BUDGET || f === file) break;
		cache.delete(f);
		total -= x.size;
	}
}

/** 读一个会话（或子 agent）的记录，变成显示节点 */
export const parse = (file: string) => serial(`parse:${file}`, () => read(file));

async function read(file: string): Promise<Parsed> {
	const st = statSync(file);
	const hit = cache.get(file);
	const todo = resume(hit, st);
	if (todo === "same" && hit) {
		keep(file, hit);
		return hit;
	}
	const s: Parsed =
		todo === "more" && hit
			? hit
			: { ino: st.ino, size: 0, mtime: 0, offset: 0, epoch: randomUUID().slice(0, 8), rev: 0, revs: new Map(), nodes: [], images: new Map(), results: new Map(), inputs: new Map(), parents: new Map(), commands: new Map(), shown: new Set(), tools: new Map(), blockNo: new Map(), compact: null, waiting: new Map() };
	cache.set(file, s);
	const touch = (n: Node) => s.revs.set(n.uuid, ++s.rev);
	// parent：沿 parentUuid 往上找最近的显示节点；半路断在还没读到的记录上就先等着
	const attach = (n: Node, from: string | null) => {
		let p = from;
		for (let hops = 0; p && !s.shown.has(p) && hops < 100_000; hops++) {
			const up = s.parents.get(p);
			if (up === undefined) {
				s.waiting.set(p, [...(s.waiting.get(p) ?? []), n]);
				p = null;
			} else p = up;
		}
		n.parent = p;
	};
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

	for await (const { line, end } of lines(file, s.offset)) {
		s.offset = end;
		if (!line.startsWith("{")) continue;
		let d: Raw;
		try { d = JSON.parse(line); } catch { continue; }
		// 同一条记录有时会被原样再追加一次（同一个 uuid）：只认第一次
		if (!d.uuid || s.parents.has(d.uuid)) continue;
		s.parents.set(d.uuid, d.parentUuid ?? null);
		const c = d.message?.content;
		let n: Node | null = null;
		if (d.type === "user") {
			const said = userText(d);
			if (said?.includes("<command-name>")) s.commands.set(d.uuid, said);
			const t = promptText(d);
			const skill = t === null ? skillCall(d, s.commands) : null;
			if (skill !== null) n = { k: "user", ...base(d), text: skill, images: 0 };
			else if (t !== null) {
				const imgs = Array.isArray(c) ? c.filter((b) => b?.type === "image" && b.source?.type === "base64") : [];
				if (imgs.length) s.images.set(d.uuid, imgs.map((b) => ({ media: b.source.media_type, data: b.source.data })));
				n = { k: "user", ...base(d), text: t, images: imgs.length };
			} else if (d.isCompactSummary) {
				// 压缩后接上的摘要：挂到刚才那条「上下文已压缩」上，点开看
				if (s.compact) {
					s.compact.detail = userText({ ...d, isMeta: false }) ?? undefined;
					touch(s.compact);
				}
			} else if (SYSTEM.test(said ?? "")) {
				// 后台任务的通知：一条事件；命令输出、提醒不显示
				if (said?.includes("<task-notification>")) n = task(d, said);
			} else if (Array.isArray(c)) {
				// 工具结果：挂到对应的调用上，不单独成节点
				for (const b of c) {
					if (b?.type !== "tool_result") continue;
					const text = resultText(b.content);
					s.results.set(b.tool_use_id, text);
					// 结果里的图片（读图片文件、截图）：按工具调用的 id 存，和人发的图片共用一个接口
					const imgs = Array.isArray(b.content) ? b.content.filter((x: Raw) => x?.type === "image" && x.source?.type === "base64") : [];
					if (imgs.length) s.images.set(b.tool_use_id, imgs.map((x: Raw) => ({ media: x.source.media_type, data: x.source.data })));
					const tool = s.tools.get(b.tool_use_id);
					if (tool) {
						const { text: t2, cut: cutted } = cut(text, BRIEF_RESULT);
						tool.result = { text: t2, error: !!b.is_error, cut: cutted, images: imgs.length };
						tool.resultUuid = d.uuid;
						const m = /agentId: (a[0-9a-f]+)/.exec(text);
						if (m) tool.agent = m[1];
						touch(tool);
					}
				}
			}
		} else if (d.type === "assistant" && Array.isArray(c)) {
			// 一条 assistant 记录一个内容块
			const b = c[0];
			if (b?.type === "text" && b.text?.trim()) n = { k: "assistant", ...base(d), text: b.text };
			else if (b?.type === "thinking" && b.thinking?.trim()) n = { k: "thinking", ...base(d), text: b.thinking };
			else if (b?.type === "tool_use") {
				s.inputs.set(b.id, JSON.stringify(b.input ?? {}, null, 2));
				const tool: Tool = {
					k: "tool",
					...base(d),
					id: b.id,
					name: b.name,
					summary: summarize(b.input ?? {}),
					input: brief(b.input ?? {}),
					result: null,
					resultUuid: null,
					agent: null,
				};
				s.tools.set(b.id, tool);
				n = tool;
			}
			const mid = String(d.message?.id ?? "");
			const no = s.blockNo.get(mid) ?? 0;
			s.blockNo.set(mid, no + 1);
			if (n && mid) n.key = `${mid}:${no}`;
			const u = d.message?.usage;
			const used = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
			if (n && used > 0 && typeof d.message.model === "string" && d.message.model !== "<synthetic>") n.ctx = { used, model: d.message.model };
		} else if (d.type === "system") {
			if (d.subtype === "away_summary" && d.content) n = { k: "event", ...base(d), kind: "summary", text: String(d.content) };
			else if (d.subtype === "compact_boundary") {
				const m = d.compactMetadata;
				const how = m ? `（${m.trigger === "auto" ? "自动" : "手动"}${m.preTokens && m.postTokens ? ` · ${wan(m.preTokens)} → ${wan(m.postTokens)} token` : ""}）` : "";
				n = s.compact = { k: "event", ...base(d), kind: "compact", text: `上下文已压缩${how}` };
			} else if (d.subtype === "informational" && d.content) n = { k: "event", ...base(d), kind: "info", text: String(d.content) };
		} else if (d.type === "attachment" && d.attachment?.type === "queued_command" && d.attachment.prompt) {
			// 跑的过程中插进来的：可能是人在终端里打的，也可能是任务通知、子代理的回报
			const t = String(d.attachment.prompt);
			if (d.attachment.commandMode === "task-notification" || t.trimStart().startsWith("<task-notification>")) n = task(d, t);
			else if (t.trimStart().startsWith("<agent-message")) n = report(d, t);
			else n = { k: "user", ...base(d), text: t, images: 0, queued: true };
		}
		if (n) {
			// 压缩那条的 parentUuid 是空的（logicalParentUuid 指的是压缩之后的记录，靠不住）：压缩发生在当时那条分支的末尾，接在它前面最后一个显示节点上
			attach(n, (d.parentUuid ?? (d.subtype === "compact_boundary" ? s.nodes[s.nodes.length - 1]?.uuid : null) ?? null) as string | null);
			s.shown.add(n.uuid);
			s.nodes.push(n);
			touch(n);
		}
		const later = s.waiting.get(d.uuid);
		if (later) {
			s.waiting.delete(d.uuid);
			for (const w of later) {
				attach(w, d.uuid);
				touch(w);
			}
		}
	}
	// 读的时候文件可能又长了：记的是开读前的大小，下次还会接着读
	s.size = st.size;
	s.mtime = st.mtimeMs;
	keep(file, s);
	return s;
}

/** 项目目录名、会话 id 只许是安全的字符 */
export function safe(s: string): string {
	if (!/^[\w.-]+$/.test(s)) throw new Error(`不合法的名字：${s}`);
	return s;
}

export const sessionFile = (project: string, id: string) => join(PROJECTS, safe(project), `${safe(id)}.jsonl`);
export const agentFile = (project: string, id: string, agent: string) => join(PROJECTS, safe(project), safe(id), "subagents", `agent-${safe(agent)}.jsonl`);

/**
 * 一个会话。since 是上次拿到的 version（「epoch:rev」）：对得上就只给之后新建、改过的节点（delta），
 * 跑的时候每 0.5 秒拉一次，不用每次把几 MB 的整个会话再发一遍
 */
export async function session(project: string, id: string, since?: string | null) {
	const cx = codex.find(id);
	if (cx) return codex.session(cx, since);
	const file = sessionFile(project, id);
	const [p, metas] = await Promise.all([parse(file), listSessions(project)]);
	const meta = metas.find((m) => m.id === id) ?? (await scanMeta(file));
	const [epoch, rev] = (since ?? "").split(":");
	const after = epoch === p.epoch ? Number(rev) : Number.NaN;
	const delta = Number.isInteger(after) && after <= p.rev;
	const nodes = delta ? p.nodes.filter((n) => (p.revs.get(n.uuid) ?? 0) > after) : p.nodes;
	return { meta, nodes, delta, version: `${p.epoch}:${p.rev}`, windows: windows(), model: chosenModel(id) };
}

export async function agent(project: string, id: string, agentId: string) {
	const file = agentFile(project, id, agentId);
	if (!existsSync(file)) return null;
	const { nodes } = await parse(file);
	let info: Raw = {};
	try { info = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch {}
	return { id: agentId, info, nodes };
}

/** 点开一个工具调用：完整参数，结果先给前 4000 字（再要完整的走 fullResult） */
export async function toolDetail(project: string, id: string, toolUseId: string, agentId?: string) {
	const cx = codex.find(id);
	if (cx) return codex.toolDetail(cx, toolUseId);
	const p = await parse(agentId ? agentFile(project, id, agentId) : sessionFile(project, id));
	const input = p.inputs.get(toolUseId);
	if (input === undefined) return null;
	const r = p.results.get(toolUseId);
	const res = r === undefined ? null : cut(r);
	return { input: cut(input, 20_000).text, result: res?.text ?? null, cut: res?.cut ?? false };
}

export async function fullResult(project: string, id: string, toolUseId: string, agentId?: string) {
	const cx = codex.find(id);
	if (cx) return codex.fullResult(cx, toolUseId);
	const { results } = await parse(agentId ? agentFile(project, id, agentId) : sessionFile(project, id));
	return results.get(toolUseId) ?? null;
}

/** 人发的图片（按消息的 uuid）或工具结果里的图片（按工具调用的 id） */
export async function image(project: string, id: string, uuid: string, i: number, agentId?: string) {
	const cx = codex.find(id);
	if (cx) return codex.image(cx, uuid, i);
	const { images } = await parse(agentId ? agentFile(project, id, agentId) : sessionFile(project, id));
	return images.get(uuid)?.[i] ?? null;
}
