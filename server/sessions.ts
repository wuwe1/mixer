// 读 Claude Code 的会话记录（~/.claude/projects/<项目>/<会话 id>.jsonl）。
// 记录是 Claude Code 内部格式，会随版本变；这里只依赖几样东西：uuid / parentUuid 连成一棵树，type 是 user / assistant / system / attachment，
// message.content 是字符串或 [{type: text | thinking | tool_use | tool_result | image}]。认不出的记录一律跳过，不报错。
//
// 给页面的是「显示节点」：用户的话、Claude 的话、思考、工具调用（结果挂在调用上）、几种事件。
// 不显示的记录（附带的系统信息、元数据）被跳过，显示节点的 parent 指向最近的显示祖先。
// 这样一来：并行的工具调用（结果挂在各自的调用下）不会被当成分叉；只有真正的分支（比如改了问题重发）才是一个节点有多个子节点。
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Node, Project, SessionMeta, Sub } from "../shared/api.ts";
import { summarize } from "../shared/tail.ts";
import { BRIEF_RESULT, BRIEF_THOUGHT, type Cursor, cut, epoch, lines, lru, resume, serial } from "./jsonl.ts";
import { chosenEffort, chosenModel, chosenPermission, forkOf, unread, windows } from "./state.ts";
import * as terminals from "./terminals.ts";

export const PROJECTS = join(homedir(), ".claude", "projects");

type Raw = Record<string, any>; // biome-ignore lint: 内部格式，没有类型

/**
 * 节点里的工具参数只是个预览：长字符串截短，结构留着（文件路径还认得出来）。
 * 工具调用平时收着，完整的参数、结果点开时再拿（toolDetail）：大会话一下少发三分之二
 */
const PATHS = new Set(["file_path", "notebook_path", "path"]);
const brief = (input: unknown) => cut(JSON.stringify(input, (k, v) => (typeof v === "string" && !PATHS.has(k) && v.length > 80 ? `${v.slice(0, 80)}…` : v), 2), 400).text;

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

/** 上次列出来的项目：按 id 找路径的（projectOf）先看它 */
let known: Project[] = [];
/** 所有项目，新的在前。每次都重新列，记下来给 projectOf */
export function listProjects(): Project[] {
	known = !existsSync(PROJECTS) ? [] : readdirSync(PROJECTS, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => {
			const dir = join(PROJECTS, d.name);
			const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
			const mtime = Math.max(0, ...files.map((f) => statSync(join(dir, f)).mtimeMs));
			return { id: d.name, path: projectPath(dir), sessions: files.length, mtime: new Date(mtime).toISOString() };
		})
		.filter((p) => p.sessions > 0)
		.sort((a, b) => b.mtime.localeCompare(a.mtime));
	return known;
}
/** 项目 id → 项目：上次列的里没有（新建的文件夹）、还不知道路径的再列一遍 */
export function projectOf(id: string): Project | null {
	const hit = known.find((p) => p.id === id);
	return hit?.path ? hit : (listProjects().find((p) => p.id === id) ?? null);
}

/** Claude Code 启动时删掉多少天没动的会话：~/.claude/settings.json 的 cleanupPeriodDays（默认 30），文件改了再读 */
const SETTINGS = join(homedir(), ".claude", "settings.json");
let cleanup = { mtime: -1, days: 30 };
function cleanupDays() {
	let m = 0;
	try { m = statSync(SETTINGS).mtimeMs; } catch {}
	if (m !== cleanup.mtime) {
		let days = 30;
		try {
			const d = JSON.parse(readFileSync(SETTINGS, "utf8")).cleanupPeriodDays;
			if (typeof d === "number" && d >= 0) days = d;
		} catch {}
		cleanup = { mtime: m, days };
	}
	return cleanup.days;
}

/** 扫过的一个会话文件（接着上次读到的地方往下扫） */
type Scan = Cursor & {
	/** ai-title；custom：/rename、/branch 起的名字（custom-title），有就用它。都是后写的算 */
	title: string | null;
	custom: string | null;
	first: string | null;
	last: string | null;
	prompts: number;
	/** 第一条 user 记录的 uuid：猜终端里 --fork-session 的一家用（guess） */
	root: string | null;
	/** 终端里 /branch 出来的：复制过来的每条记录带 forkedFrom.sessionId（直接的原会话）；own 是第一句不带它的（分叉后自己问的） */
	from: string | null;
	own: string | null;
	/** 人说的每一句：uuid、开头。分叉复制过来的记录 uuid 不变，不在原会话里的就是分叉后自己问的 */
	asked: [string, string][];
};
const metaCache = new Map<string, Scan>();
type Seen = { id: string; s: Scan; size: number; mtime: Date; born: number };

const scanMeta = (file: string) => serial(`meta:${file}`, () => scan(file));
async function scan(file: string): Promise<Seen> {
	const st = statSync(file);
	let s = metaCache.get(file);
	const how = resume(s, st);
	if (how === "fresh" || !s) s = { ino: st.ino, size: 0, mtime: 0, offset: 0, title: null, custom: null, first: null, last: null, prompts: 0, root: null, from: null, own: null, asked: [] };
	if (how !== "same") {
		for await (const { line, end } of lines(file, s.offset)) {
			s.offset = end;
			// 只解析可能有用的行，图片 base64 那种大行先看开头
			if (line.startsWith('{"type":"ai-title"')) {
				try { s.title = JSON.parse(line).aiTitle ?? s.title; } catch {}
				continue;
			}
			if (line.startsWith('{"type":"custom-title"')) {
				try { s.custom = JSON.parse(line).customTitle || s.custom; } catch {}
				continue;
			}
			if (!line.includes('"type":"user"') || line.includes('"tool_result"')) continue;
			let d: Raw;
			try { d = JSON.parse(line); } catch { continue; }
			if (d.uuid) s.root ??= d.uuid;
			const from = typeof d.forkedFrom?.sessionId === "string" ? d.forkedFrom.sessionId : null;
			s.from ??= from;
			const t = promptText(d);
			if (t === null) continue;
			const head = t.slice(0, 200);
			s.prompts++;
			s.first ??= head;
			s.last = head;
			if (d.uuid) s.asked.push([d.uuid, head]);
			if (!from) s.own ??= head;
		}
		// 读的时候文件可能又长了：记的是开读前的大小，下次还会接着读
		s.size = st.size;
		s.mtime = st.mtimeMs;
		metaCache.set(file, s);
	}
	const id = basename(file, ".jsonl");
	// 整个项目扫过的，就地改这一家（root 可能刚有）
	roots.get(basename(dirname(file)))?.set(id, { root: s.root, born: st.birthtimeMs, from: s.from });
	return { id, s, size: st.size, mtime: st.mtime, born: st.birthtimeMs };
}

/** 记录里读出来的会话信息；terminal（在 mixer 外面开着）、unread（跑完没看）随时在变，给出去时由 live 加上 */
type Scanned = Omit<SessionMeta, "terminal" | "unread">;
const live = (m: Scanned): SessionMeta => ({ ...m, terminal: terminals.of(m.id), unread: unread(m.id) });

/** 一个 Claude 会话的信息：标题、几句话、从哪分叉、什么时候会被清理 */
async function metaOf(project: string, x: Seen): Promise<Scanned> {
	const { s } = x;
	const { parent, fresh } = await lineage(project, x.id, s);
	return {
		id: x.id,
		title: s.custom ?? s.title,
		custom: !!s.custom,
		first: s.first,
		last: s.last,
		fresh,
		prompts: s.prompts,
		size: x.size,
		mtime: x.mtime.toISOString(),
		parent,
		expires: new Date(x.mtime.getTime() + cleanupDays() * 86_400_000).toISOString(),
	};
}

/**
 * 从哪个会话分叉出来的（直接的原会话）、分叉后自己问的第一句。确切的两种：
 *   mixer 里分叉的：state 当场记下的（forkOf）
 *   终端里 /branch 的：复制过来的记录带 forkedFrom（终端里再 --fork-session 它，复制出来的也带着，那就成了原会话的原会话：认了）
 * 剩下终端里 claude --resume --fork-session 的（还有 mixer 记 forkOf 之前分叉的）什么标记都没有，只能猜：guess
 */
async function lineage(project: string, id: string, s: Scan): Promise<{ parent: string | null; fresh: string | null }> {
	const mine = forkOf(id)?.session;
	if (!mine && s.from) return { parent: s.from, fresh: s.own };
	const parent = mine ?? guess(project, id);
	return { parent, fresh: parent ? await freshOf(project, s, parent) : null };
}

/** 分叉后自己问的第一句：分叉的文件里原会话的记录 uuid 原样留着，第一句不在原会话里的。原会话的文件没了就不知道 */
async function freshOf(project: string, s: Scan, parent: string): Promise<string | null> {
	let file: string;
	try { file = sessionFile(project, parent); } catch { return null; }
	if (!existsSync(file)) return null;
	const had = new Set((await scanMeta(file)).s.asked.map(([u]) => u));
	return s.asked.find(([u]) => !had.has(u))?.[1] ?? null;
}

/**
 * 每个项目记着 会话 → 第一条 user 记录的 uuid（root）、建立时间、/branch 的来处：扫整个项目（family）时整个重建（顺带去掉别处删掉的），
 * 之后扫到一个会话（scan）、删掉一个（forget）就地改。listSessions 每次都重建；侧栏推一行（row）时这个项目还没扫过（mixer 刚起来）才扫一次
 */
const roots = new Map<string, Map<string, { root: string | null; born: number; from: string | null }>>();
/**
 * 猜的（只用在没有确切来处的会话上）：--fork-session 把原会话的记录原样复制过去，root 相同的是一家；
 * 一家里没有确切来处的按建立时间排（一样的按 id，次次一样），最早的、文件还在的当原会话，别的都挂在它下面。
 * 靠不住的地方：文件拷过（建立时间变了）、分叉的分叉也挂到最早的那个上（侧栏反正挂到最上面的祖先）
 */
function guess(project: string, id: string): string | null {
	const all = roots.get(project);
	const me = all?.get(id);
	if (!all || !me?.root) return null;
	const fam = [...all].filter(([k, v]) => v.root === me.root && (k === id || (!v.from && !forkOf(k)))).sort(([a, x], [b, y]) => x.born - y.born || a.localeCompare(b));
	const head = fam.find(([k]) => k === id || existsSync(sessionFile(project, k)))?.[0];
	return head && head !== id ? head : null;
}

/** 扫整个项目的 Claude 会话（接着上次读的），重建这个项目的 roots */
async function family(project: string) {
	const dir = join(PROJECTS, safe(project));
	const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
	const seen = await Promise.all(files.map((f) => scanMeta(join(dir, f))));
	roots.set(project, new Map(seen.map((x) => [x.id, { root: x.s.root, born: x.born, from: x.s.from }])));
	return seen;
}

export async function listSessions(project: string): Promise<SessionMeta[]> {
	const metas = await Promise.all((await family(project)).map(async (x) => live(await metaOf(project, x))));
	return metas.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** 侧栏里一个会话的那一行（会话文件变了，随通知推过去，侧栏不用整个工作区重拉） */
export async function row(project: string, id: string): Promise<SessionMeta | null> {
	const file = locate(project, id);
	return file ? metaAt(project, file) : null;
}
async function metaAt(project: string, file: string) {
	if (!roots.has(project)) await family(project);
	return live(await metaOf(project, await scanMeta(file)));
}

/** 会话删掉了（trash.ts）：读过的记录、扫过的信息、它的子代理都丢掉 */
export function forget(project: string, id: string) {
	const file = sessionFile(project, id);
	const dir = `${file.slice(0, -".jsonl".length)}/`;
	metaCache.delete(file);
	roots.get(project)?.delete(id);
	for (const f of cache.keys()) if (f === file || f.startsWith(dir)) cache.delete(f);
	for (const f of edits.keys()) if (f.startsWith(dir)) edits.delete(f);
}

/** 所有项目和它们的会话（「浏览会话」用） */
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
/** 停止之后命令行补的一句（「[Request interrupted by user]」，停在工具调用上是「… for tool use]」）：显示成一条事件 */
const INTERRUPTED = /^\s*\[Request interrupted by user[^\]]*\]\s*$/;

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
	return t === null || SYSTEM.test(t) || INTERRUPTED.test(t) ? null : t;
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

type Tool = Extract<Node, { k: "tool" }>;

const ident = (v: unknown) => (typeof v === "string" && /^[\w-]+$/.test(v) ? v : undefined);
/**
 * 工具结果结构化的那份（记录里的 toolUseResult，出错的只是一句字符串）里认得的几样，不从结果的文字里认：
 *   子代理：Agent 的 agentId，status 是 async_launched 的开了就回来、在后台跑；Skill 以 forked 跑的也有 agentId，background 是在后台
 *   后台任务：后台命令的 backgroundTaskId、Monitor 的 taskId
 *   改了的文件：Write / Edit / MultiEdit 的 filePath（带 structuredPatch）、NotebookEdit 的 notebook_path（带 updated_file）、
 *     命令的 bashEditDiff（这条命令改了工作区里的哪些文件；shared 是同一个工作区里别的进程也在改，分不清是谁改的，不算）。相对路径按 cwd 补全
 */
export function facts(name: string, r: unknown, cwd?: string): Partial<Pick<Tool, "agent" | "async" | "task" | "files">> {
	if (!r || typeof r !== "object" || Array.isArray(r)) return {};
	const x = r as Raw;
	const out: Partial<Pick<Tool, "agent" | "async" | "task" | "files">> = {};
	const agent = ident(x.agentId);
	if (agent) {
		out.agent = agent;
		if (x.status === "async_launched" || (x.status === "forked" && x.background === true)) out.async = { agentId: agent };
	}
	const task = ident(x.backgroundTaskId) ?? (name === "Monitor" ? ident(x.taskId) : undefined);
	if (task) out.task = task;
	const files: unknown[] = [];
	if (typeof x.filePath === "string" && "structuredPatch" in x) files.push(x.filePath);
	if (typeof x.notebook_path === "string" && "updated_file" in x) files.push(x.notebook_path);
	const bash = x.bashEditDiff;
	if (bash && typeof bash === "object" && !bash.shared) files.push(...(Array.isArray(bash.changedFiles) ? bash.changedFiles : Array.isArray(bash.files) ? bash.files.map((f: Raw) => f?.filePath) : []));
	const abs = files.flatMap((f) => (typeof f === "string" && f ? [isAbsolute(f) || !cwd ? f : join(cwd, f)] : []));
	if (abs.length) out.files = [...new Set(abs)];
	return out;
}

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
	/** 截短了的思考的全文，按节点的 uuid */
	thoughts: Map<string, string>;
	/** 每条记录的 parentUuid：找最近的显示祖先用。原记录不留，带图片的 base64 太占内存 */
	parents: Map<string, string | null>;
	/** <command-name> 那几条 user 记录的文字：下一条是 skill 正文时要用 */
	commands: Map<string, string>;
	shown: Set<string>;
	tools: Map<string, Tool>;
	/** 同一条消息的每一段各是一条 assistant 记录：记录带 apiBlockIndex 就照它，老的没有才按文件顺序数（空的思考也算一段） */
	blockNo: Map<string, number>;
	compact: Extract<Node, { k: "event" }> | null;
	/** parentUuid 指向的记录还没读到（偶尔先写回复、后写它挂着的附带记录）：先当根，那条读到了再找 */
	waiting: Map<string, Node[]>;
	/** 最后一条 last-prompt 的 leafUuid（explicit：终端里回退、分叉时写的，之后还没写过别的记录）；last：最后写的一条主线记录 */
	leaf: { uuid: string; explicit: boolean } | null;
	last: string | null;
	/** assistant 记录、工具结果记录 → 属于哪条消息（message.id）：并行的几个工具调用是同一条消息，leafOf 认「接着往下」时当一体 */
	mids: Map<string, string>;
	/** 工具改过的文件（toolUseResult 里的）：整个会话一份 */
	touched: Set<string>;
};
/**
 * 读过的会话留在内存里（文件长了接着读），按最近用过的排；加起来超过 200MB（按文件大小算，图片的 base64 也在里面）
 * 就丢掉最久没用的，下次打开从头读。正在用的那个不丢
 */
const cache = lru<Parsed>(200 * 1024 * 1024);

/** 读一个会话（或子 agent）的记录，变成显示节点 */
export const parse = (file: string) => serial(`parse:${file}`, () => read(file));

async function read(file: string): Promise<Parsed> {
	const st = statSync(file);
	const hit = cache.get(file);
	const todo = resume(hit, st);
	if (todo === "same" && hit) {
		cache.keep(file, hit);
		return hit;
	}
	const s: Parsed =
		todo === "more" && hit
			? hit
			: { ino: st.ino, size: 0, mtime: 0, offset: 0, epoch: epoch(), rev: 0, revs: new Map(), nodes: [], images: new Map(), results: new Map(), inputs: new Map(), thoughts: new Map(), parents: new Map(), commands: new Map(), shown: new Set(), tools: new Map(), blockNo: new Map(), compact: null, waiting: new Map(), leaf: null, last: null, mids: new Map(), touched: new Set() };
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
		// 命令行续接时接着哪条（没有 uuid 的元数据记录）
		if (d.type === "last-prompt" && typeof d.leafUuid === "string" && d.leafUuid) s.leaf = { uuid: d.leafUuid, explicit: d.explicit === true };
		// 同一条记录有时会被原样再追加一次（同一个 uuid）：只认第一次
		if (!d.uuid || s.parents.has(d.uuid)) continue;
		s.parents.set(d.uuid, d.parentUuid ?? null);
		if (!d.isSidechain && (d.type === "user" || d.type === "assistant" || d.type === "system" || d.type === "attachment")) {
			s.last = d.uuid;
			if (s.leaf) s.leaf.explicit = false;
			// 压缩之后命令行不再认之前的 leafUuid
			if (d.subtype === "compact_boundary") s.leaf = null;
		}
		const c = d.message?.content;
		let n: Node | null = null;
		/** 挂在哪条记录下面（不给就照 parentUuid） */
		let from: string | null | undefined;
		if (d.type === "user") {
			const said = userText(d);
			if (said?.includes("<command-name>")) s.commands.set(d.uuid, said);
			const t = promptText(d);
			const skill = t === null ? skillCall(d, s.commands) : null;
			// skill：节点用 <command-name> 那条的 uuid（写进 stdin 时带的 uuid 落在它上面），挂在它的上一条下面
			if (skill !== null) {
				n = { k: "user", ...base(d), uuid: d.parentUuid, text: skill, images: 0 };
				from = s.parents.get(d.parentUuid) ?? null;
			} else if (t !== null) {
				const imgs = Array.isArray(c) ? c.filter((b) => b?.type === "image" && b.source?.type === "base64") : [];
				if (imgs.length) s.images.set(d.uuid, imgs.map((b) => ({ media: b.source.media_type, data: b.source.data })));
				n = { k: "user", ...base(d), text: t, images: imgs.length };
			} else if (d.isCompactSummary) {
				// 压缩后接上的摘要：挂到刚才那条「上下文已压缩」上，点开看
				if (s.compact) {
					s.compact.detail = userText({ ...d, isMeta: false }) ?? undefined;
					touch(s.compact);
				}
			} else if (INTERRUPTED.test(said ?? "")) n = { k: "event", ...base(d), kind: "info", text: "被打断了" };
			else if (SYSTEM.test(said ?? "")) {
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
						const mid = tool.key?.split(":")[0];
						if (mid) s.mids.set(d.uuid, mid);
						// 一条记录一个工具结果，toolUseResult 是它结构化的那份（出错的是一句字符串）
						Object.assign(tool, facts(tool.name, d.toolUseResult, d.cwd));
						for (const f of tool.files ?? []) s.touched.add(f);
						touch(tool);
					}
				}
			}
		} else if (d.type === "assistant" && Array.isArray(c)) {
			// 一条 assistant 记录一个内容块
			const b = c[0];
			// 命令行自己合成的出错消息（isApiErrorMessage，模型是 <synthetic>）：不是 Claude 的回复，画成出错
			if (d.isApiErrorMessage && b?.type === "text") n = { k: "event", ...base(d), kind: "error", text: String(b.text ?? "").replace(/^API Error:\s*/, "") || "出错了" };
			else if (b?.type === "text" && b.text?.trim()) n = { k: "assistant", ...base(d), text: b.text };
			else if (b?.type === "thinking" && b.thinking?.trim()) {
				const t = cut(b.thinking, BRIEF_THOUGHT);
				if (t.cut) s.thoughts.set(d.uuid, b.thinking);
				n = { k: "thinking", ...base(d), ...t };
			} else if (b?.type === "tool_use") {
				s.inputs.set(b.id, JSON.stringify(b.input ?? {}, null, 2));
				const file = b.input?.file_path ?? b.input?.notebook_path;
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
					...(typeof file === "string" && file ? { file } : {}),
				};
				s.tools.set(b.id, tool);
				n = tool;
			}
			// 第几段：记录带着 apiBlockIndex 就照它（有的段没写进记录，按顺序数会错一位），老记录才数
			const mid = String(d.message?.id ?? "");
			if (mid) s.mids.set(d.uuid, mid);
			const no = typeof d.apiBlockIndex === "number" ? d.apiBlockIndex : (s.blockNo.get(mid) ?? 0);
			s.blockNo.set(mid, no + 1);
			if (n && n.k !== "event" && mid) n.key = `${mid}:${no}`;
			const u = d.message?.usage;
			const used = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
			if (n && n.k !== "event" && used > 0 && typeof d.message.model === "string" && d.message.model !== "<synthetic>") n.ctx = { used, model: d.message.model };
		} else if (d.type === "system") {
			if (d.subtype === "away_summary" && d.content) n = { k: "event", ...base(d), kind: "summary", text: String(d.content) };
			else if (d.subtype === "compact_boundary") {
				const m = d.compactMetadata;
				const how = m ? `（${m.trigger === "auto" ? "自动" : "手动"}${m.preTokens && m.postTokens ? ` · ${wan(m.preTokens)} → ${wan(m.postTokens)} token` : ""}）` : "";
				n = s.compact = { k: "event", ...base(d), kind: "compact", text: `上下文已压缩${how}` };
			} else if (d.subtype === "informational" && d.content) n = { k: "event", ...base(d), kind: "info", text: String(d.content) };
			// 连不上、过载：命令行自己隔一会儿重试，每次写一条（一轮可能重试十几分钟）
			else if (d.subtype === "api_error") {
				const why = String(d.error?.formatted ?? d.error?.message ?? "连不上");
				n = { k: "event", ...base(d), kind: "retry", text: `${why}，正在重试${typeof d.retryAttempt === "number" ? `（第 ${d.retryAttempt}${typeof d.maxRetries === "number" ? ` / ${d.maxRetries}` : ""} 次）` : ""}` };
			}
		} else if (d.type === "attachment" && d.attachment?.type === "queued_command" && d.attachment.prompt) {
			// 跑的过程中插进来的：可能是人在终端里打的，也可能是任务通知、子代理的回报
			const t = String(d.attachment.prompt);
			if (d.attachment.commandMode === "task-notification" || t.trimStart().startsWith("<task-notification>")) n = task(d, t);
			else if (t.trimStart().startsWith("<agent-message")) n = report(d, t);
			else n = { k: "user", ...base(d), text: t, images: 0, queued: true, ...(typeof d.attachment.source_uuid === "string" ? { source: d.attachment.source_uuid } : {}) };
		}
		if (n) {
			// 压缩那条的 parentUuid 是空的（logicalParentUuid 指的是压缩之后的记录，靠不住）：压缩发生在当时那条分支的末尾，接在它前面最后一个显示节点上
			attach(n, from === undefined ? ((d.parentUuid ?? (d.subtype === "compact_boundary" ? s.nodes[s.nodes.length - 1]?.uuid : null) ?? null) as string | null) : from);
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
	cache.keep(file, s);
	return s;
}

/** 项目目录名、会话 id 只许是安全的字符 */
export function safe(s: string): string {
	if (!/^[\w.-]+$/.test(s)) throw new Error(`不合法的名字：${s}`);
	return s;
}

export const sessionFile = (project: string, id: string) => join(PROJECTS, safe(project), `${safe(id)}.jsonl`);
export const agentFile = (project: string, id: string, agent: string) => join(PROJECTS, safe(project), safe(id), "subagents", `agent-${safe(agent)}.jsonl`);

/** 会话的记录文件；没有是 null */
export function locate(project: string, id: string): string | null {
	const file = sessionFile(project, id);
	return existsSync(file) ? file : null;
}
/** 读好的会话或子代理的记录：节点、点开看的详情都在里面。没有这个会话就是 ENOENT（404） */
const source = (project: string, id: string, agentId?: string) => parse(agentId ? agentFile(project, id, agentId) : sessionFile(project, id));

/**
 * 一个会话。since 是上次拿到的 version（「epoch:rev」）：对得上就只给之后新建、改过的节点（delta），
 * 跑的时候每 0.5 秒拉一次，不用每次把几 MB 的整个会话再发一遍。
 * windows：mixer 跑完时记下的（state.json）
 */
export async function session(project: string, id: string, since?: string | null) {
	const file = locate(project, id);
	if (!file) throw Object.assign(new Error("没有这个会话"), { status: 404 });
	const [p, meta] = await Promise.all([parse(file), metaAt(project, file)]);
	return { meta, ...changes(p, since), windows: windows(), model: chosenModel(id), effort: chosenEffort(id), permission: chosenPermission(id), leaf: leafOf(p), touched: await touchedOf(file, p) };
}

/** 会话记录现在写到哪了（和 session() 给的 version 一样）：读一遍（接着上次读的）再看。没有这个会话是 null */
export async function version(project: string, id: string): Promise<string | null> {
	const file = locate(project, id);
	if (!file) return null;
	const p = await parse(file);
	return `${p.epoch}:${p.rev}`;
}

/**
 * 命令行续接时接着哪条，照它读记录的办法：最后一条 last-prompt 的 leafUuid。
 *   终端里回退、分叉刚写的（explicit，之后还没写过别的记录）：就是它，哪怕它下面还挂着回退前的
 *   不然：之后写的最后一条是它的后代（接着往下跑了；它是并行工具调用里的一个时，从同一条消息的别的调用往下的也算）就从那条起，
 *     再走到下面最新的显示节点（偶尔先写回复、后写它挂着的附带记录，leafUuid 指的是那条附带记录）
 * 换成显示节点。没有（还没写过、压缩之后还没写）是 null，网页走最新的叶子
 */
function leafOf(p: Parsed): string | null {
	const l = p.leaf;
	if (!l || !p.parents.has(l.uuid)) return null;
	const up = function* (from: string) {
		let x: string | null | undefined = from;
		for (let hops = 0; x && hops < 1_000_000; hops++, x = p.parents.get(x)) yield x;
	};
	const batch = p.mids.get(l.uuid);
	let to = l.uuid;
	if (!l.explicit && p.last && p.last !== l.uuid) for (const x of up(p.last)) if (x === l.uuid || (batch && p.mids.get(x) === batch)) { to = p.last; break; }
	let at: string | null = null;
	for (const x of up(to)) if (p.shown.has(x)) { at = x; break; }
	return at && !l.explicit ? newest(p.nodes, at) : at;
}

/** from 和它下面的显示节点里最新的那个（一样新的取文件里靠后的） */
function newest(nodes: Node[], from: string): string {
	const kids = new Map<string, string[]>();
	for (const n of nodes) if (n.parent) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent))?.push(n.uuid);
	const under = new Set([from]);
	for (const todo = [from]; todo.length; ) {
		for (const k of kids.get(todo.pop() as string) ?? []) {
			if (under.has(k)) continue;
			under.add(k);
			todo.push(k);
		}
	}
	let best: Node | null = null;
	for (const n of nodes) if (under.has(n.uuid) && (!best || n.ts >= best.ts)) best = n;
	return best?.uuid ?? from;
}

/**
 * 子代理改过的文件：只解析带 toolUseResult 的行，接着上次读到的地方往下扫（不用把子代理的记录整个拼一遍）。
 * 在自己的 worktree 里干活的（meta 的 worktreePath）：那里面的改动在另一份检出里，不算这个会话的
 */
const edits = new Map<string, Cursor & { files: Set<string> }>();
const editsOf = (file: string) =>
	serial(`edits:${file}`, async () => {
		const st = statSync(file);
		let e = edits.get(file);
		const how = resume(e, st);
		if (how === "fresh" || !e) e = { ino: st.ino, size: 0, mtime: 0, offset: 0, files: new Set() };
		if (how !== "same") {
			const wt = info(file).worktreePath;
			const away = typeof wt === "string" && wt ? `${wt.replace(/\/+$/, "")}/` : null;
			for await (const { line, end } of lines(file, e.offset)) {
				e.offset = end;
				if (!line.includes('"toolUseResult":{')) continue;
				try {
					const d = JSON.parse(line);
					for (const f of facts("", d.toolUseResult, d.cwd).files ?? []) if (!away || !f.startsWith(away)) e.files.add(f);
				} catch {}
			}
			e.size = st.size;
			e.mtime = st.mtimeMs;
			edits.set(file, e);
		}
		return e.files;
	});

/** 这个会话改过的文件（所有分支），连它开过的子代理改的 */
async function touchedOf(file: string, p: Parsed): Promise<string[]> {
	const dir = join(file.replace(/\.jsonl$/, ""), "subagents");
	let names: string[] = [];
	try { names = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch {}
	const all = new Set(p.touched);
	const subs = await Promise.all(names.map((f) => editsOf(join(dir, f)).catch(() => new Set<string>())));
	for (const s of subs) for (const f of s) all.add(f);
	return [...all];
}

/** since 是「epoch:rev」：epoch 对得上就只给 rev 之后新建、改过的节点（delta），对不上给全部 */
function changes(p: Pick<Parsed, "epoch" | "rev" | "revs" | "nodes">, since?: string | null) {
	const [epoch, rev] = (since ?? "").split(":");
	const after = epoch === p.epoch ? Number(rev) : Number.NaN;
	const delta = Number.isInteger(after) && after <= p.rev;
	return { nodes: delta ? p.nodes.filter((n) => (p.revs.get(n.uuid) ?? 0) > after) : p.nodes, delta, version: `${p.epoch}:${p.rev}` };
}

/** 子代理的对话。since 和 session() 一样：对得上就只给之后变了的节点，开着看它跑的时候每次只拉一点 */
export async function agent(project: string, id: string, agentId: string, since?: string | null) {
	const file = agentFile(project, id, agentId);
	if (!existsSync(file)) return null;
	return { id: agentId, info: info(file), ...changes(await parse(file), since) };
}

/** agent-<id>.meta.json：{agentType, description, toolUseId（开它的那个 Agent 工具调用）, …}；子代理一开始就写 */
const info = (file: string): Raw => {
	try { return JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch { return {}; }
};

/** 子代理现在在做什么，一行：最后一个工具调用（工具名 + 摘要），或者最后一段回复的第一行 */
export function activity(nodes: Node[]): string | null {
	const clip = (t: string) => (t.length > 80 ? `${t.slice(0, 80)}…` : t);
	for (let i = nodes.length - 1; i >= 0; i--) {
		const n = nodes[i];
		if (n.k === "tool") return clip(`${n.name.replace(/^mcp__[^_]+__/, "")} ${n.summary}`.trim());
		if (n.k === "assistant") return clip(n.text.trim().split("\n")[0].trim());
	}
	return null;
}

/** 10 分钟没动的子代理不可能还在跑：不读它的记录，latest 给 null（列表打开时不用把一个会话的子代理全读一遍） */
const RECENT = 10 * 60_000;

/** 一个子代理：meta 里的身份、在做什么、最后写的时间（毫秒）。meta 和记录都没有就是 null */
export async function sub(project: string, id: string, agentId: string): Promise<Sub | null> {
	const file = agentFile(project, id, agentId);
	let mtime = 0;
	for (const f of [file, file.replace(/\.jsonl$/, ".meta.json")]) {
		try { mtime = Math.max(mtime, statSync(f).mtimeMs); } catch {}
	}
	if (!mtime) return null;
	const m = info(file);
	const str = (v: unknown) => (typeof v === "string" ? v : null);
	const latest = Date.now() - mtime < RECENT && existsSync(file) ? activity((await parse(file)).nodes) : null;
	return { agentId, toolUseId: str(m.toolUseId), agentType: str(m.agentType), description: str(m.description), latest, mtime };
}

/** 会话开过的子代理（<会话>/subagents/ 里的）：网页靠 toolUseId 把它们对上各自的 Agent 工具调用 */
export async function subs(project: string, id: string): Promise<Sub[]> {
	let names: string[] = [];
	try { names = readdirSync(join(PROJECTS, safe(project), safe(id), "subagents")); } catch {}
	const ids = new Set(names.flatMap((f) => /^agent-(a[0-9a-f]+)\.(?:jsonl|meta\.json)$/.exec(f)?.[1] ?? []));
	return (await Promise.all([...ids].map((a) => sub(project, id, a)))).filter((x): x is Sub => !!x);
}

/** 点开一个工具调用：完整参数，结果先给前 4000 字（再要完整的走 fullResult） */
export async function toolDetail(project: string, id: string, toolUseId: string, agentId?: string) {
	const p = await source(project, id, agentId);
	const input = p.inputs.get(toolUseId);
	if (input === undefined) return null;
	const r = p.results.get(toolUseId);
	const res = r === undefined ? null : cut(r);
	return { input: cut(input, 20_000).text, result: res?.text ?? null, cut: res?.cut ?? false };
}

export const fullResult = async (project: string, id: string, toolUseId: string, agentId?: string) => (await source(project, id, agentId)).results.get(toolUseId) ?? null;

/** 点开一段思考：全文（节点里只有开头） */
export const thought = async (project: string, id: string, uuid: string, agentId?: string) => (await source(project, id, agentId)).thoughts.get(uuid) ?? null;

/** 人发的图片（按消息的 uuid）或工具结果里的图片（按工具调用的 id） */
export const image = async (project: string, id: string, uuid: string, i: number, agentId?: string) => (await source(project, id, agentId)).images.get(uuid)?.[i] ?? null;
