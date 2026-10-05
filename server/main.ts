// mixer 的服务：127.0.0.1:4848（MIXER_PORT 可改），手机经 Cloudflare 隧道访问（前面必须有 Access，这个服务能在本机跑 claude）。
//   读：项目、会话（显示节点树）、子 agent、工具的完整结果、会话里的图片；仓库的文件、内容、git 状态、改动、提交
//   写：开始（新会话可以在家目录里任意文件夹开）/ 续接 / 分叉一次运行、停止；回答权限确认；新建文件夹
//   推：/api/events（SSE）：运行的输出、运行状态、确认请求、会话文件有变化
// 写的接口只收 JSON、只认自己页面的 Origin（本机 http，或隧道来的同源 https）；MCP 工具发来的确认请求要带 MIXER_TOKEN。
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, sep } from "node:path";
import { gzipSync } from "node:zlib";
import * as dirs from "./dirs.ts";
import * as repo from "./repo.ts";
import * as runs from "./runs.ts";
import { agent, fullResult, image, listProjects, listSessions, PROJECTS, session, tree } from "./sessions.ts";
import * as state from "./state.ts";

const PORT = Number(process.env.MIXER_PORT ?? 4848);
const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DIST = join(ROOT, "web", "dist");

/** web/src 比 web/dist 新就重新打包 */
function build() {
	const newest = (d: string): number => Math.max(0, ...readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(join(d, e.name)) : statSync(join(d, e.name)).mtimeMs)));
	const out = join(DIST, "index.html");
	if (existsSync(out) && statSync(out).mtimeMs > Math.max(newest(join(ROOT, "web", "src")), statSync(join(ROOT, "web", "index.html")).mtimeMs)) return;
	console.log("打包页面……");
	execFileSync(join(ROOT, "node_modules", ".bin", "vite"), ["build", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" });
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json",
};

/** JSON；大于 8KB 且对方收 gzip 就压缩（会话一个就一两 MB，手机上省流量） */
let current: IncomingMessage | null = null;
const json = (res: ServerResponse, status: number, v: unknown) => {
	const buf = Buffer.from(JSON.stringify(v));
	const gz = buf.length > 8192 && /\bgzip\b/.test(String(current?.headers["accept-encoding"] ?? ""));
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(gz ? { "content-encoding": "gzip" } : {}) });
	res.end(gz ? gzipSync(buf) : buf);
};
const body = (req: IncomingMessage) => new Promise<string>((ok) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => ok(s)); });

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

// SSE
const clients = new Set<ServerResponse>();
const emit = (type: string, data: unknown) => { for (const c of clients) c.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
runs.onEvent(emit);
setInterval(() => { for (const c of clients) c.write(": keepalive\n\n"); }, 25_000).unref();

// 会话文件有变化：告诉页面（同一个文件 1 秒内合成一次）
const timers = new Map<string, ReturnType<typeof setTimeout>>();
if (existsSync(PROJECTS)) {
	watch(PROJECTS, { recursive: true }, (_, f) => {
		const m = /^([^/]+)\/([0-9a-f-]{36})\.jsonl$/.exec(String(f ?? "").split(sep).join("/"));
		if (!m) return;
		const key = `${m[1]}/${m[2]}`;
		clearTimeout(timers.get(key));
		timers.set(key, setTimeout(() => emit("session", { project: m[1], id: m[2] }), 1000));
	});
}

type Handler = (req: IncomingMessage, res: ServerResponse, m: string[], url: URL) => unknown;
const GET: [RegExp, Handler][] = [
	[/^\/api\/health$/, (_q, res) => json(res, 200, { app: "mixer", pid: process.pid })],
	[/^\/api\/projects$/, (_q, res) => json(res, 200, (projCache = { at: 0, list: [] }, projects()))],
	[/^\/api\/tree$/, async (_q, res) => json(res, 200, await tree())],
	[/^\/api\/projects\/([\w.-]+)\/sessions$/, async (_q, res, m) => json(res, 200, await listSessions(m[1]))],
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)$/, async (_q, res, m) => json(res, 200, await session(m[1], m[2]))],
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/agents\/(a[0-9a-f]+)$/, async (_q, res, m) => {
		const a = await agent(m[1], m[2], m[3]);
		return a ? json(res, 200, a) : json(res, 404, { error: "没有这个子 agent 的记录" });
	}],
	[/^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/result\/([\w-]+)$/, async (_q, res, m, url) => {
		const t = await fullResult(m[1], m[2], m[3], url.searchParams.get("agent") ?? undefined);
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
		res.writeHead(200, { "content-type": TYPES[extname(f).toLowerCase()] ?? "application/octet-stream", "cache-control": "private, max-age=60" });
		createReadStream(f).pipe(res);
	}],
	[/^\/api\/repo\/([\w.-]+)\/status$/, (_q, res, m) => json(res, 200, repo.status(projectPath(m[1])))],
	[/^\/api\/repo\/([\w.-]+)\/diff$/, (_q, res, m, url) => json(res, 200, { diff: repo.diff(projectPath(m[1]), url.searchParams.get("path") ?? "") })],
	[/^\/api\/repo\/([\w.-]+)\/commit\/([0-9a-f]+)$/, (_q, res, m) => json(res, 200, { text: repo.commit(projectPath(m[1]), m[2]) })],
	[/^\/api\/runs$/, (_q, res) => json(res, 200, runs.list())],
	[/^\/api\/runs\/([\w-]+)$/, (_q, res, m) => { const r = runs.get(m[1]); return r ? json(res, 200, r) : json(res, 404, { error: "没有这次运行" }); }],
	[/^\/api\/approvals$/, (_q, res) => json(res, 200, runs.pending())],
	[/^\/api\/dirs$/, (_q, res, _m, url) => json(res, 200, dirs.list(url.searchParams.get("path") ?? ""))],
];
const POST: [RegExp, Handler][] = [
	[/^\/api\/runs$/, async (req, res) => {
		const b = JSON.parse(await body(req));
		// 新会话可以直接给文件夹（还没开过会话的也行）；其余的按项目找目录
		const cwd = b.mode === "new" && b.cwd ? dirs.folder(String(b.cwd)) : projectPath(b.project);
		const r = await runs.start({ project: b.mode === "new" && b.cwd ? dirs.projectId(cwd) : b.project, cwd, session: b.session ?? null, mode: b.mode ?? "resume", at: b.at ?? null, prompt: String(b.prompt ?? ""), permission: b.permission ?? "default" });
		json(res, 200, r);
	}],
	[/^\/api\/dirs$/, async (req, res) => {
		const b = JSON.parse(await body(req));
		json(res, 200, dirs.create(String(b.parent ?? ""), String(b.name ?? "").trim()));
	}],
	[/^\/api\/seen$/, async (req, res) => {
		const b = JSON.parse(await body(req));
		state.seen(String(b.session ?? ""));
		emit("state", { project: b.project, session: b.session });
		json(res, 200, { ok: true });
	}],
	[/^\/api\/runs\/([\w-]+)\/stop$/, (_q, res, m) => json(res, 200, { stopped: runs.stop(m[1]) })],
	[/^\/api\/approvals\/([\w-]+)$/, async (req, res, m) => {
		const b = JSON.parse(await body(req));
		json(res, 200, { ok: runs.answer(m[1], !!b.allow, b.message) });
	}],
];

build();
const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
	const path = url.pathname;
	current = req;
	try {
		if (path === "/api/events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(": hi\n\n");
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		// MCP 工具来的确认请求：只认 token，一直挂着等人点
		if (req.method === "POST" && path === "/api/approvals") {
			if (req.headers["x-mixer-token"] !== runs.TOKEN) return json(res, 403, { error: "token 不对" });
			const b = JSON.parse(await body(req));
			return json(res, 200, await runs.ask(String(b.run), String(b.tool), b.input));
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
			return void res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream", "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" }).end(readFileSync(f));
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(readFileSync(join(DIST, "index.html")));
	} catch (e) {
		const status = (e as { status?: number }).status ?? 500;
		if (status === 500) console.error(e);
		json(res, status, { error: e instanceof Error ? e.message : String(e) });
	}
});
server.listen(PORT, "127.0.0.1", () => {
	console.log(`${new Date().toISOString()} mixer http://127.0.0.1:${PORT}/ pid ${process.pid}`);
	// 先把所有会话扫一遍（第一次要读完所有记录，之后按修改时间缓存），侧栏第一次打开就快
	tree().catch((e) => console.error(e));
});
