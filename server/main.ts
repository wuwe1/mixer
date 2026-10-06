// mixer 的服务：127.0.0.1:4848（MIXER_PORT 可改），手机经隧道访问：Cloudflare Tunnel + Access，或 Tailscale Funnel + passkey（access.ts 认人，这个服务能在本机跑 claude）。
//   读：项目、会话（显示节点树）、子 agent、工具的完整结果、会话里的图片；仓库的文件、内容、git 状态、改动、提交
//   写：开始（新会话可以在家目录里任意文件夹开）/ 续接 / 分叉一次运行、停止；回答权限确认；新建文件夹；删掉会话（移到废纸篓 / codex archive）
//   推：/api/events（SSE）：运行的输出、运行状态、确认请求、会话文件有变化、子代理在做什么
// 接口都要先认出是谁（access.ts：本机、Access 的 JWT、passkey 登录的 cookie），页面本身谁都能拿。
// 写的接口只收 JSON、只认自己页面的 Origin（本机 http，或隧道来的同源 https）；MCP 工具发来的确认请求要带 MIXER_TOKEN。
import { execFile, execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, type Stats, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip, gzipSync } from "node:zlib";
import * as access from "./access.ts";
import * as codex from "./codex.ts";
import * as codexRun from "./codex-run.ts";
import * as dirs from "./dirs.ts";
import * as repo from "./repo.ts";
import * as runs from "./runs.ts";
import * as skills from "./skills.ts";
import * as sse from "./sse.ts";
import { agent, fullResult, image, listProjects, listSessions, PROJECTS, row, session, sub, subs, thought, toolDetail, tree } from "./sessions.ts";
import * as state from "./state.ts";
import * as trash from "./trash.ts";
import * as tunnel from "./tunnel.ts";
import * as usage from "./usage.ts";
import * as workspace from "./workspace.ts";

const PORT = Number(process.env.MIXER_PORT ?? 4848);
const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DIST = join(ROOT, "web", "dist");
const say = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

// 哪里漏了没接住的错误：记下来，服务接着跑（launchd 会拉起，但正在跑的、排着的、待确认的就都没了）
process.on("uncaughtException", (e) => say(`没接住的错误：${e.stack ?? e}`));
process.on("unhandledRejection", (e) => say(`没接住的错误（Promise）：${e instanceof Error ? e.stack : e}`));

/** web/src 比 web/dist 新就重新打包 */
function build() {
	const newest = (d: string): number => Math.max(0, ...readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(join(d, e.name)) : statSync(join(d, e.name)).mtimeMs)));
	const out = join(DIST, "index.html");
	if (existsSync(out) && statSync(out).mtimeMs > Math.max(newest(join(ROOT, "web", "src")), statSync(join(ROOT, "web", "index.html")).mtimeMs)) return;
	console.log("打包页面……");
	execFileSync(join(ROOT, "node_modules", ".bin", "vite"), ["build", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" });
	prune();
}

/** 页面现在的版本：index.html 里入口脚本的路径（文件名带 hash）。开着的页面比一比，就知道有没有新的 */
let version: string | null = null;
const readVersion = () => {
	try { version = /<script\b(?=[^>]*\btype="module")[^>]*\bsrc="([^"]+)"/.exec(readFileSync(join(DIST, "index.html"), "utf8"))?.[1] ?? null; } catch { version = null; }
	return version;
};

/**
 * 打包不清空 dist（emptyOutDir: false）：已经开着的页面还要按需加载旧的那些块。
 * 打包完把一天前的、新的 index.html 顺着引用找不到的删掉
 */
function prune() {
	const dir = join(DIST, "assets");
	let names: string[];
	try { names = readdirSync(dir); } catch { return; }
	const all = new Set(names);
	const used = new Set<string>();
	const todo = [join(DIST, "index.html")];
	for (let f = todo.pop(); f; f = todo.pop()) {
		let text: string;
		try { text = readFileSync(f, "utf8"); } catch { continue; }
		for (const m of text.matchAll(/[\w.-]+\.(?:js|css|wasm|woff2?|ttf|svg|png|jpe?g|gif|webp|json)\b/g)) {
			if (!all.has(m[0]) || used.has(m[0])) continue;
			used.add(m[0]);
			if (/\.(js|css)$/.test(m[0])) todo.push(join(dir, m[0]));
		}
	}
	let n = 0;
	for (const name of names) {
		if (used.has(name)) continue;
		try {
			if (Date.now() - statSync(join(dir, name)).mtimeMs < 86_400_000) continue;
			rmSync(join(dir, name), { force: true });
			n++;
		} catch {}
	}
	if (n) say(`删掉了 ${n} 个一天前的旧打包文件`);
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp",
	".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json",
};
/** 仓库里的文件原样给（/raw）：只有这几种图片能在页面里直接显示；别的（包括 SVG、HTML）一律当下载，还加上 sandbox 的 CSP，里面的脚本跑不起来 */
const INLINE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp"]);
const RAW_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
/** 页面本身不许被别的网站嵌进去（点击劫持） */
const PAGE = { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" };

/** JSON；大于 8KB 且对方收 gzip 就压缩（会话一个就一两 MB，手机上省流量） */
const json = (res: ServerResponse, status: number, v: unknown) => {
	const buf = Buffer.from(JSON.stringify(v));
	const gz = buf.length > 8192 && /\bgzip\b/.test(String(res.req?.headers["accept-encoding"] ?? ""));
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(gz ? { "content-encoding": "gzip" } : {}) });
	res.end(gz ? gzipSync(buf) : buf);
};
// 先攒 Buffer 再一起解码：按块拼字符串，中文会在块的边界被切坏（带图片时请求体很大，一定会分块）。
// 最多 20MB（10 张图片也够），再大回 413
const LIMIT = 20 * 1024 * 1024;
const body = (req: IncomingMessage) => new Promise<string>((ok, no) => {
	if (Number(req.headers["content-length"] ?? 0) > LIMIT) return no(fail(413, "太大了：最多 20MB"));
	const cs: Buffer[] = [];
	let n = 0;
	req.on("data", (c: Buffer) => {
		if (n > LIMIT) return;
		n += c.length;
		if (n <= LIMIT) return void cs.push(c);
		cs.length = 0;
		no(fail(413, "太大了：最多 20MB"));
	});
	req.on("end", () => { if (n <= LIMIT) ok(Buffer.concat(cs).toString("utf8")); });
	req.on("error", no);
});

function ours(req: IncomingMessage) {
	const o = req.headers.origin;
	if (!o) return true;
	if (o === `http://127.0.0.1:${PORT}` || o === `http://localhost:${PORT}` || o === "http://localhost:5173") return true;
	return o === `https://${req.headers.host}`;
}

// 项目 id → 路径（listProjects 要读文件，缓存 30 秒）
let projCache: { at: number; list: ReturnType<typeof listProjects> } = { at: 0, list: [] };
const projects = () => {
	if (Date.now() - projCache.at > 30_000) projCache = { at: Date.now(), list: listProjects() };
	return projCache.list;
};
const projectPath = (id: string) => {
	const p = projects().find((x) => x.id === id) ?? (projCache = { at: 0, list: [] }, projects().find((x) => x.id === id));
	if (!p?.path || !existsSync(p.path)) throw Object.assign(new Error("找不到这个项目的目录"), { status: 404 });
	return p.path;
};

// 打包出来的文件（文件名带 hash，不会变）：第一次有人要时压好 br 和 gzip 存着。主包 700 多 KB，压完两百来 KB
const PACK = new Set([".js", ".css", ".svg", ".json", ".html"]);
const packed = new Map<string, Promise<{ br: Buffer; gzip: Buffer }>>();
const pack = (f: string) => {
	let p = packed.get(f);
	if (!p) {
		const raw = readFileSync(f);
		p = Promise.all([promisify(brotliCompress)(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }), promisify(gzip)(raw, { level: 9 })]).then(([br, gz]) => ({ br, gzip: gz }));
		packed.set(f, p);
	}
	return p;
};

// SSE（sse.ts）。连上先发 build（页面的版本）、再发 hello（全部状态），之后每 25 秒一个 ping：页面靠它知道连接还活着（手机睡醒、切网络后连接常常已经断了却没报错）
const { emit } = sse;
runs.onEvent(emit);
setInterval(() => emit("ping", {}), 25_000).unref();

// 会话文件有变化：告诉页面。同一个文件 0.5 秒内的变化合成一次；是节流不是防抖：Claude 跑起来一直在写，防抖会一直推不出去。
// 在工作区里的，带上侧栏那一行（meta），侧栏就地换掉，不用整个工作区重拉；正看着这个会话的页面自己带 version 拉增量
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const changed = (project: string, id: string) => {
	const key = `${project}/${id}`;
	if (timers.has(key)) return;
	timers.set(key, setTimeout(async () => {
		timers.delete(key);
		const meta = state.workspace()?.sessions[id] === project ? await row(project, id).catch(() => null) : null;
		emit("session", meta ? { project, id, meta } : { project, id });
	}, 500));
};
// 子代理的记录（<项目>/<会话>/subagents/agent-<id>.jsonl，开的时候先写 .meta.json）：推 agent，带上它现在在做什么（sub），
// 网页把它放在开它的那个 Agent 工具调用下面。同样每个子代理 0.5 秒最多一次；记录是接着上次读的，不贵
const subTimers = new Map<string, ReturnType<typeof setTimeout>>();
const subChanged = (project: string, session: string, agentId: string) => {
	const key = `${project}/${session}/${agentId}`;
	if (subTimers.has(key)) return;
	subTimers.set(key, setTimeout(async () => {
		subTimers.delete(key);
		const a = await sub(project, session, agentId).catch(() => null);
		if (a) emit("agent", { project, session, ...a });
	}, 500));
};
if (existsSync(PROJECTS)) {
	watch(PROJECTS, { recursive: true }, (_, f) => {
		const p = String(f ?? "").split(sep).join("/");
		const m = /^([^/]+)\/([0-9a-f-]{36})\.jsonl$/.exec(p);
		if (m) return changed(m[1], m[2]);
		const a = /^([^/]+)\/([0-9a-f-]{36})\/subagents\/agent-(a[0-9a-f]+)\.(?:jsonl|meta\.json)$/.exec(p);
		if (a) subChanged(a[1], a[2], a[3]);
	});
}
// Codex 的会话：年/月/日/rollout-…-<id>.jsonl，项目按它的 cwd 算
if (existsSync(codex.CODEX)) {
	watch(codex.CODEX, { recursive: true }, (_, f) => {
		const i = codex.fromPath(String(f ?? "").split(sep).join("/"));
		if (i) changed(i.project, i.id);
	});
}

type Handler = (req: IncomingMessage, res: ServerResponse, m: string[], url: URL) => unknown;
function fail(status: number, msg: string) { return Object.assign(new Error(msg), { status }); }
const GET: [RegExp, Handler][] = [
	[/^\/api\/auth\/status$/, async (req, res) => json(res, 200, access.status(req, await access.who(req)))],
	[/^\/api\/auth\/seen$/, (req, res) => { if (!access.isLocal(req)) throw fail(403, "只能在本机看"); json(res, 200, access.seenAccess()); }],
	[/^\/api\/health$/, (_q, res) => json(res, 200, { app: "mixer", pid: process.pid })],
	[/^\/api\/projects$/, (_q, res) => json(res, 200, (projCache = { at: 0, list: [] }, projects()))],
	[/^\/api\/tree$/, async (_q, res) => json(res, 200, await tree())],
	[/^\/api\/workspace$/, async (_q, res) => json(res, 200, await workspace.view())],
	// Codex 能用的模型（codex app-server 的 model/list）
	[/^\/api\/codex\/models$/, async (_q, res) => json(res, 200, await codexRun.listModels())],
	[/^\/api\/projects\/([\w.-]+)\/sessions$/, async (_q, res, m) => json(res, 200, await listSessions(m[1]))],
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)$/, async (_q, res, m, url) => json(res, 200, await session(m[1], m[2], url.searchParams.get("since")))],
	// 会话开过的子代理：各自对应哪个 Agent 工具调用、现在在做什么
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/agents$/, async (_q, res, m) => json(res, 200, await subs(m[1], m[2]))],
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/agents\/(a[0-9a-f]+)$/, async (_q, res, m, url) => {
		const a = await agent(m[1], m[2], m[3], url.searchParams.get("since"));
		return a ? json(res, 200, a) : json(res, 404, { error: "没有这个子 agent 的记录" });
	}],
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/tool\/([\w-]+)$/, async (_q, res, m, url) => {
		const d = await toolDetail(m[1], m[2], m[3], url.searchParams.get("agent") ?? undefined);
		return d ? json(res, 200, d) : json(res, 404, { error: "没有这个工具调用" });
	}],
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/result\/([\w-]+)$/, async (_q, res, m, url) => {
		const t = await fullResult(m[1], m[2], m[3], url.searchParams.get("agent") ?? undefined);
		return t === null ? json(res, 404, { error: "没有" }) : json(res, 200, { text: t });
	}],
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/thinking\/([\w-]+)$/, async (_q, res, m, url) => {
		const t = await thought(m[1], m[2], m[3], url.searchParams.get("agent") ?? undefined);
		return t === null ? json(res, 404, { error: "没有" }) : json(res, 200, { text: t });
	}],
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/image\/([\w-]+)\/(\d+)$/, async (_q, res, m, url) => {
		const img = await image(m[1], m[2], m[3], Number(m[4]), url.searchParams.get("agent") ?? undefined);
		if (!img) return void res.writeHead(404).end();
		res.writeHead(200, { "content-type": img.media, "cache-control": "private, max-age=86400" }).end(Buffer.from(img.data, "base64"));
	}],
	[/^\/api\/repo\/([\w.-]+)\/files$/, (_q, res, m) => json(res, 200, { root: projectPath(m[1]), files: repo.files(projectPath(m[1])) })],
	[/^\/api\/repo\/([\w.-]+)\/file$/, (_q, res, m, url) => json(res, 200, repo.file(projectPath(m[1]), url.searchParams.get("path") ?? ""))],
	[/^\/api\/repo\/([\w.-]+)\/raw$/, (_q, res, m, url) => {
		const f = repo.inside(projectPath(m[1]), url.searchParams.get("path") ?? "");
		let st: Stats | null = null;
		try { st = statSync(f); } catch {}
		if (!st?.isFile()) return json(res, 404, { error: "没有这个文件" });
		const ext = extname(f).toLowerCase();
		res.writeHead(200, {
			"content-type": TYPES[ext] ?? "application/octet-stream",
			"content-length": st.size,
			"cache-control": "private, max-age=60",
			"x-content-type-options": "nosniff",
			"content-security-policy": RAW_CSP,
			...(INLINE.has(ext) ? {} : { "content-disposition": "attachment" }),
		});
		createReadStream(f).on("error", () => res.destroy()).pipe(res);
	}],
	[/^\/api\/repo\/([\w.-]+)\/status$/, async (_q, res, m) => json(res, 200, await repo.status(projectPath(m[1])))],
	[/^\/api\/repo\/([\w.-]+)\/diff$/, (_q, res, m, url) => json(res, 200, { diff: repo.diff(projectPath(m[1]), url.searchParams.get("path") ?? "") })],
	[/^\/api\/repo\/([\w.-]+)\/commit\/([0-9a-f]+)$/, (_q, res, m) => json(res, 200, repo.commit(projectPath(m[1]), m[2]))],
	[/^\/api\/runs$/, (_q, res) => json(res, 200, runs.list())],
	[/^\/api\/runs\/([\w-]+)\/tail$/, (_q, res, m) => { const t = runs.tail(m[1]); return t ? json(res, 200, t) : json(res, 404, { error: "没有这次运行" }); }],
	[/^\/api\/runs\/([\w-]+)$/, (_q, res, m) => { const r = runs.get(m[1]); return r ? json(res, 200, r) : json(res, 404, { error: "没有这次运行" }); }],
	[/^\/api\/approvals$/, (_q, res) => json(res, 200, runs.pending())],
	[/^\/api\/usage$/, (_q, res) => json(res, 200, usage.list())],
	[/^\/api\/queue$/, (_q, res) => json(res, 200, runs.queued())],
	[/^\/api\/queue\/([\w-]+)\/image\/(\d+)$/, (_q, res, m) => {
		const img = runs.queuedImage(m[1], Number(m[2]));
		if (!img) return void res.writeHead(404).end();
		res.writeHead(200, { "content-type": img.media, "cache-control": "private, max-age=3600" }).end(Buffer.from(img.data, "base64"));
	}],
	[/^\/api\/dirs$/, (_q, res, _m, url) => json(res, 200, dirs.list(url.searchParams.get("path") ?? ""))],
	[/^\/api\/skills\/([\w.-]+)$/, (_q, res, m) => json(res, 200, skills.list(m[1], projectPath(m[1])))],
];
const POST: [RegExp, Handler][] = [
	// 登录：配对码建 passkey、passkey 登录。登录成功种 cookie
	[/^\/api\/auth\/register\/options$/, async (req, res) => json(res, 200, await access.registerOptions(req, JSON.parse(await body(req)).code))],
	[/^\/api\/auth\/register$/, async (req, res) => {
		const b = JSON.parse(await body(req));
		res.setHeader("set-cookie", await access.register(req, b.code, b.response));
		json(res, 200, { ok: true });
	}],
	[/^\/api\/auth\/login\/options$/, async (req, res) => json(res, 200, await access.loginOptions(req))],
	[/^\/api\/auth\/login$/, async (req, res) => {
		const b = JSON.parse(await body(req));
		res.setHeader("set-cookie", await access.login(req, b.id, b.response));
		json(res, 200, { ok: true });
	}],
	[/^\/api\/auth\/logout$/, (_q, res) => { res.setHeader("set-cookie", access.logoutCookie); json(res, 200, { ok: true }); }],
	// 新的配对码（加一台设备）：已经认出来的才能要，`pnpm mixer pair` 从本机来要
	[/^\/api\/pair$/, (_q, res) => json(res, 200, access.pair())],
	[/^\/api\/runs$/, async (req, res) => {
		const b = JSON.parse(await body(req));
		// 新会话可以直接给文件夹（还没开过会话的也行）；其余的按项目找目录
		const cwd = b.mode === "new" && b.cwd ? dirs.folder(String(b.cwd)) : projectPath(b.project);
		const r = await runs.start({ project: b.mode === "new" && b.cwd ? dirs.projectId(cwd) : b.project, cwd, session: b.session ?? null, mode: b.mode ?? "resume", at: b.at ?? null, prompt: String(b.prompt ?? ""), images: Array.isArray(b.images) ? b.images : [], permission: b.permission ?? "default", model: typeof b.model === "string" ? b.model : null, agent: typeof b.agent === "string" ? b.agent : null });
		json(res, 200, r);
	}],
	[/^\/api\/dirs$/, async (req, res) => {
		const b = JSON.parse(await body(req));
		json(res, 200, dirs.create(String(b.parent ?? ""), String(b.name ?? "").trim()));
	}],
	// 工作区：add（放进来；不给 session 就只放文件夹，sessions 是撤销移出文件夹时一起放回去的）/ remove（不给 session 就移掉整个文件夹）/ order（文件夹拖完的顺序）
	[/^\/api\/workspace$/, async (req, res) => {
		const b = JSON.parse(await body(req));
		const id = (v: unknown) => (typeof v === "string" && /^[\w.-]+$/.test(v) ? v : null);
		const project = id(b.project);
		const session = id(b.session);
		const sessions = Array.isArray(b.sessions) ? b.sessions.flatMap((x: unknown) => id(x) ?? []) : [];
		const changed =
			b.op === "add" && project ? state.addToWorkspace(project, typeof b.path === "string" ? b.path : null, session ? [session, ...sessions] : sessions)
			: b.op === "remove" && project ? state.removeFromWorkspace(project, session)
			: b.op === "order" && Array.isArray(b.order) ? state.orderWorkspace(b.order.flatMap((x: unknown) => id(x) ?? []))
			: null;
		if (changed === null) throw fail(400, "不认识的操作");
		if (changed) emit("workspace", null);
		json(res, 200, { ok: true });
	}],
	// 删掉一个会话（trash.ts）：Claude 的移到废纸篓，Codex 的 codex archive。在跑、排队、待确认、终端里开着的回 409
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/delete$/, async (_q, res, m) => {
		await trash.remove(m[1], m[2]);
		emit("workspace", null);
		json(res, 200, { ok: true });
	}],
	[/^\/api\/seen$/, async (req, res) => {
		const b = JSON.parse(await body(req));
		state.seen(String(b.session ?? ""));
		emit("state", { project: b.project, session: b.session });
		json(res, 200, { ok: true });
	}],
	[/^\/api\/runs\/([\w-]+)\/stop$/, (_q, res, m) => json(res, 200, { stopped: runs.stop(m[1]) })],
	[/^\/api\/queue\/([\w-]+)\/cancel$/, (_q, res, m) => json(res, 200, { ok: runs.unqueue(m[1]) })],
	[/^\/api\/approvals\/([\w-]+)$/, async (req, res, m) => {
		const b = JSON.parse(await body(req));
		json(res, 200, { ok: runs.answer(m[1], !!b.allow, b.message) });
	}],
];

/**
 * 改了 mixer 自己的代码：停手 3 秒、mixer 也闲下来（没有运行、排队、待确认）再换上，免得打断正在跑的、丢了排着的。
 *   服务端的代码（server/、mcp/、两边共用的 web/src/lib/tail.ts）：类型检查过了就退出，launchd（KeepAlive）马上拉起新的，启动时顺便重新打包页面。
 *   检查没过不重启，等下次改；终端里 pnpm start 的退出了没人拉，只提示一句。
 *   只改了页面：重新打包，刷新就是新的
 */
const LAUNCHD = process.env.XPC_SERVICE_NAME === "com.mixer.server";
const dirty = { server: 0, web: 0 };
let swapping = false;
const CODE = /\.(tsx?|css|html)$/;
const touched = (kind: keyof typeof dirty) => (_: unknown, f: string | Buffer | null) => { if (CODE.test(String(f ?? ""))) dirty[kind] = Date.now(); };
watch(join(ROOT, "server"), { recursive: true }, touched("server"));
watch(join(ROOT, "mcp"), { recursive: true }, touched("server"));
watch(join(ROOT, "web", "index.html"), touched("web"));
watch(join(ROOT, "web", "src"), { recursive: true }, (e, f) => touched(String(f ?? "").split(sep).join("/") === "lib/tail.ts" ? "server" : "web")(e, f));
setInterval(() => {
	const last = Math.max(dirty.server, dirty.web);
	if (swapping || !last || Date.now() - last < 3000 || !runs.idle()) return;
	swapping = true;
	if (dirty.server) {
		const at = dirty.server;
		execFile(join(ROOT, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", "server"], { cwd: ROOT }, (err, out) => {
			swapping = false;
			// 检查的时候又改了、又有人开始跑了：下一轮再说
			if (dirty.server !== at || !runs.idle()) return;
			dirty.server = 0;
			if (err) return say(`服务端代码改了，类型检查没过，先不重启：\n${out}`);
			if (!LAUNCHD) return say("服务端代码改了：重启后生效");
			say("服务端代码改了，现在空闲：重启");
			process.exit(0);
		});
		return;
	}
	const at = dirty.web;
	execFile(join(ROOT, "node_modules", ".bin", "vite"), ["build", "--logLevel", "warn"], { cwd: ROOT }, (err, _out, stderr) => {
		swapping = false;
		if (dirty.web === at) dirty.web = 0;
		packed.clear();
		say(err ? `页面改了，打包失败：\n${stderr}` : "页面改了：已重新打包");
		if (err) return;
		// 开着的页面：有新版本了
		if (readVersion()) emit("build", { version });
		prune();
	});
}, 5000).unref();

build();
readVersion();
const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
	const path = url.pathname;
	try {
		// MCP 工具来的确认请求：只认 token，一直挂着等人点
		if (req.method === "POST" && path === "/api/approvals") {
			if (req.headers["x-mixer-token"] !== runs.TOKEN) return json(res, 403, { error: "token 不对" });
			const b = JSON.parse(await body(req));
			// 问的那边断了（claude 退出了）：确认请求作废
			const gone = new AbortController();
			res.on("close", () => { if (!res.writableEnded) gone.abort(); });
			return json(res, 200, await runs.ask(String(b.run), String(b.tool), b.input, gone.signal));
		}
		// 接口要先认出是谁；登录用的那几个除外（一分钟限次数）
		if (path.startsWith("/api/auth/")) {
			if (req.method === "POST" && access.limited(req)) return json(res, 429, { error: "试得太频繁了，过一分钟再来" });
		} else if (path.startsWith("/api/") && !(await access.who(req))) return json(res, 401, { error: "要先登录", login: true });
		if (path === "/api/events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(version ? sse.frame("build", { version }) : ": hi\n\n");
			res.on("close", () => sse.leave(res));
			res.on("error", () => sse.leave(res));
			return void sse.join(res, workspace.hello).catch((e) => console.error(e));
		}
		const table = req.method === "POST" ? POST : req.method === "GET" ? GET : [];
		if (req.method === "POST" && (!req.headers["content-type"]?.startsWith("application/json") || !ours(req))) return json(res, 403, { error: "只收自己页面的 JSON" });
		for (const [re, h] of table) {
			const m = re.exec(path);
			if (m) return await h(req, res, m.map((x) => (x === undefined ? x : decodeURIComponent(x))), url);
		}
		if (path.startsWith("/api/")) return json(res, 404, { error: "没有这个接口" });
		// 页面
		const f = join(DIST, path);
		if (path !== "/" && f.startsWith(DIST + sep) && existsSync(f) && statSync(f).isFile()) {
			const head = { "content-type": TYPES[extname(f)] ?? "application/octet-stream", "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache", vary: "accept-encoding", ...(extname(f) === ".html" ? PAGE : {}) };
			const accept = String(req.headers["accept-encoding"] ?? "");
			const how = !path.startsWith("/assets/") || !PACK.has(extname(f)) ? null : /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
			if (how) return void res.writeHead(200, { ...head, "content-encoding": how }).end((await pack(f))[how]);
			return void res.writeHead(200, head).end(readFileSync(f));
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...PAGE }).end(readFileSync(join(DIST, "index.html")));
	} catch (e) {
		// 文件刚好没了（会话被删、临时文件）：404，不算服务出错
		const status = (e as { status?: number }).status ?? ((e as { code?: string }).code === "ENOENT" ? 404 : 500);
		if (status === 500) console.error(e);
		if (res.headersSent) return void res.destroy();
		// 请求体太大：回完就断开，剩下的不读了
		if (status === 413) {
			res.setHeader("connection", "close");
			res.on("finish", () => req.destroy());
		}
		json(res, status, { error: e instanceof Error ? e.message : String(e) });
	}
});
// 隧道（cloudflared）把空闲的连接留着再用，留得比 Node 默认的 5 秒久：这边先关了，正好用上的那个请求就 502。
// 比它留得久（120 秒）；headersTimeout 要比这个长。都只管收请求，挂着的回应（SSE、等人点的确认请求）不受影响
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
// 端口被占了之类：起不来就退出（launchd 隔一会儿再拉），不要挂着一个不听端口的进程
server.on("error", (e) => {
	say(`起不来：${e.message}`);
	process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
	console.log(`${new Date().toISOString()} mixer http://127.0.0.1:${PORT}/ pid ${process.pid}`);
	tunnel.keep(PORT);
	usage.start();
	// 先把所有会话扫一遍（第一次要读完所有记录，之后按修改时间缓存），侧栏第一次打开就快
	tree().catch((e) => console.error(e));
});
