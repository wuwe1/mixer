// mixer 的服务：127.0.0.1:4848（MIXER_PORT 可改），手机经隧道访问：Cloudflare Tunnel + Access，或 Tailscale Funnel + passkey（access.ts 认人，这个服务能在本机跑 claude）。
//   读：项目、会话（显示节点树）、子 agent、工具的完整结果、会话里的图片；仓库的文件、内容、git 状态、改动、提交
//   写：开始（新会话可以在家目录里任意文件夹开）/ 续接 / 分叉一次运行、停止；回答权限确认；新建文件夹；删掉会话（移到废纸篓）
//   推：/api/events（SSE）：运行的输出、运行状态、确认请求、会话文件有变化、子代理在做什么
// 接口都要先认出是谁（access.ts：本机、Access 的 JWT、passkey 登录的 cookie），页面本身谁都能拿。
// 每个接口在 ROUTES 里写明谁能用（user / open，见 refuse）；写的接口只收 JSON、只认自己页面的 Origin（本机 http，或隧道来的同源 https）。
import { execFile, execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, type Stats, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import * as access from "./access.ts";
import * as dirs from "./dirs.ts";
import { say } from "./log.ts";
import * as models from "./models.ts";
import * as repo from "./repo.ts";
import * as push from "./push.ts";
import * as runs from "./runs.ts";
import * as skills from "./skills.ts";
import * as sse from "./sse.ts";
import { agent, fullResult, image, listProjects, listSessions, PROJECTS, projectOf, row, session, sub, subs, thought, toolDetail, tree } from "./sessions.ts";
import * as state from "./state.ts";
import * as terminals from "./terminals.ts";
import * as trash from "./trash.ts";
import * as tunnel from "./tunnel.ts";
import * as usage from "./usage.ts";
import * as workspace from "./workspace.ts";

const { PORT } = access;
const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DIST = join(ROOT, "web", "dist");

// 哪里漏了没接住的错误：记下来，服务接着跑（launchd 会拉起，但正在跑的、排着的、待确认的就都没了）
process.on("uncaughtException", (e) => say(`没接住的错误：${e.stack ?? e}`));
process.on("unhandledRejection", (e) => say(`没接住的错误（Promise）：${e instanceof Error ? e.stack : e}`));
// 被停（launchd、Ctrl-C）：先停掉自己跑的隧道（cloudflared），再走一遍 exit
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { tunnel.stop(); process.exit(0); });

/** web/src、shared 比 web/dist 新就重新打包 */
function build() {
	const newest = (d: string): number => Math.max(0, ...readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(join(d, e.name)) : statSync(join(d, e.name)).mtimeMs)));
	const out = join(DIST, "index.html");
	if (existsSync(out) && statSync(out).mtimeMs > Math.max(newest(join(ROOT, "web", "src")), newest(join(ROOT, "shared")), statSync(join(ROOT, "web", "index.html")).mtimeMs)) return;
	console.log("打包页面……");
	execFileSync(join(ROOT, "node_modules", ".bin", "vite"), ["build", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" });
	prune();
}

/** 页面现在的版本：index.html 里入口脚本的路径（文件名带 hash）。开着的页面比一比，就知道有没有新的 */
let version: string | null = null;
const readVersion = () => {
	try { return /<script\b(?=[^>]*\btype="module")[^>]*\bsrc="([^"]+)"/.exec(readFileSync(join(DIST, "index.html"), "utf8"))?.[1] ?? null; } catch { return null; }
};
/**
 * 从磁盘重读版本，换了就告诉开着的页面：自己打完包、dist 的 index.html 变了（终端里 pnpm build）、有页面连上时都读。
 * 只在这里改 version：谁先读到新的谁就推 build，不会有人读了却没推。读不到（正写到一半）不算
 */
function refreshVersion() {
	const v = readVersion();
	if (!v || v === version) return;
	version = v;
	sse.emit("build", { version });
}

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

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
/** 对方收 br 用 br，不然 gzip；都不收是 null */
const encoding = (req: IncomingMessage) => {
	const a = String(req.headers["accept-encoding"] ?? "");
	return /\bbr\b/.test(a) ? "br" : /\bgzip\b/.test(a) ? "gzip" : null;
};
/**
 * JSON；大于 8KB 就压缩（会话大的压之前有半 MB 多，走隧道、手机上省流量）：对方收 br 用 br（质量 5，和 gzip 一样快、小一成多），不然 gzip。
 * 在线程池里压，不挡别的请求和推送
 */
const json = (res: ServerResponse, status: number, v: unknown) => {
	const buf = Buffer.from(JSON.stringify(v));
	const head = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
	const how = buf.length <= 8192 ? null : encoding(res.req);
	if (!how) return void res.writeHead(status, head).end(buf);
	// 压完之前处理函数已经出错回过了（headersSent）就不再回
	(how === "br" ? brotli(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }) : gz(buf)).then(
		(z) => { if (!res.headersSent && !res.destroyed) res.writeHead(status, { ...head, "content-encoding": how }).end(z); },
		() => { if (!res.headersSent && !res.destroyed) res.writeHead(status, head).end(buf); },
	);
};
// 先攒 Buffer 再一起解码：按块拼字符串，中文会在块的边界被切坏（带图片时请求体很大，一定会分块）。
// 最多 20MB（10 张图片也够），再大回 413。解析成 JSON 对象，不是的回 400
const LIMIT = 20 * 1024 * 1024;
type Body = Record<string, any>; // biome-ignore lint: 请求体，各个接口自己挑字段
/** 登录那几个（谁都能来）用不着大的请求体：64KB 就够，免得没登录的一分钟塞几百 MB 进内存 */
const SMALL = 64 * 1024;
const body = (req: IncomingMessage, limit = LIMIT) => new Promise<Body>((ok, no) => {
	const too = () => fail(413, `太大了：最多 ${limit >= 1024 * 1024 ? `${limit / 1024 / 1024}MB` : `${limit / 1024}KB`}`);
	if (Number(req.headers["content-length"] ?? 0) > limit) return no(too());
	const cs: Buffer[] = [];
	let n = 0;
	req.on("data", (c: Buffer) => {
		if (n > limit) return;
		n += c.length;
		if (n <= limit) return void cs.push(c);
		cs.length = 0;
		no(too());
	});
	req.on("end", () => {
		if (n > limit) return;
		let v: unknown;
		try { v = JSON.parse(Buffer.concat(cs).toString("utf8")); } catch { return no(fail(400, "请求体不是 JSON")); }
		if (!v || typeof v !== "object" || Array.isArray(v)) return no(fail(400, "请求体要是 JSON 对象"));
		ok(v as Body);
	});
	req.on("error", no);
});

/** 自己页面来的：同源（本机的是 http，pnpm dev 的 5173 也是，转过来 Host 不变；隧道来的是 https）。没有 Origin 的是命令行 */
function ours(req: IncomingMessage) {
	const o = req.headers.origin;
	return !o || o === `${access.isLocal(req) ? "http" : "https"}://${req.headers.host}`;
}

// 项目 id → 路径（projectOf 先看上次列的，没有再列一遍）
const projectPath = (id: string) => {
	const p = projectOf(id);
	if (!p?.path || !existsSync(p.path)) throw Object.assign(new Error("找不到这个项目的目录"), { status: 404 });
	return p.path;
};

// 打包出来的文件（文件名带 hash，不会变）：第一次有人要时压好 br 和 gzip 存着。主包 700 多 KB，压完两百来 KB
const PACK = new Set([".js", ".css", ".svg", ".json"]);
const packed = new Map<string, Promise<{ br: Buffer; gzip: Buffer }>>();
const pack = (f: string) => {
	let p = packed.get(f);
	if (!p) {
		const raw = readFileSync(f);
		p = Promise.all([brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }), gz(raw, { level: 9 })]).then(([br, gzip]) => ({ br, gzip }));
		packed.set(f, p);
	}
	return p;
};

// SSE（sse.ts）。连上先发 build（页面的版本）、再发 hello（全部状态），之后每 25 秒一个 ping：页面靠它知道连接还活着（手机睡醒、切网络后连接常常已经断了却没报错）
const { emit } = sse;
// 推给页面的同时看要不要推通知（push.ts：来了确认请求、跑完了、出错了）
runs.onEvent((type, data) => {
	emit(type, data);
	void push.watch(type, data);
});
setInterval(() => emit("ping", {}), 25_000).unref();

/** 同一个 key 0.5 秒最多跑一次：第一次来时排上，0.5 秒后跑，这期间再来的不管。是节流不是防抖：Claude 跑起来一直在写，防抖会一直推不出去 */
const pending = new Set<string>();
const throttle = (key: string, f: () => unknown) => {
	if (pending.has(key)) return;
	pending.add(key);
	setTimeout(() => {
		pending.delete(key);
		f();
	}, 500);
};

// 会话文件有变化：告诉页面，同一个文件 0.5 秒内的变化合成一次。
// 在工作区里的，带上侧栏那一行（meta：parent 也算好了，terminal 是在 mixer 外面开着），侧栏整行换掉，不用整个工作区重拉；
// 正看着这个会话的页面自己带 version 拉增量
const changed = (project: string, id: string) =>
	throttle(`session ${project}/${id}`, async () => {
		const meta = state.workspace()?.sessions[id] === project ? await row(project, id).catch(() => null) : null;
		emit("session", meta ? { project, id, meta } : { project, id });
	});
// 子代理的记录（<项目>/<会话>/subagents/agent-<id>.jsonl，开的时候先写 .meta.json）：推 agent，带上它现在在做什么（sub），
// 网页把它放在开它的那个 Agent 工具调用下面。同样每个子代理 0.5 秒最多一次；记录是接着上次读的，不贵
const subChanged = (project: string, session: string, agentId: string) =>
	throttle(`agent ${project}/${session}/${agentId}`, async () => {
		const a = await sub(project, session, agentId).catch(() => null);
		if (a) emit("agent", { project, session, ...a });
	});
if (existsSync(PROJECTS)) {
	watch(PROJECTS, { recursive: true }, (_, f) => {
		const p = String(f ?? "").split(sep).join("/");
		const m = /^([^/]+)\/([0-9a-f-]{36})\.jsonl$/.exec(p);
		if (m) return changed(m[1], m[2]);
		const a = /^([^/]+)\/([0-9a-f-]{36})\/subagents\/agent-(a[0-9a-f]+)\.(?:jsonl|meta\.json)$/.exec(p);
		if (a) subChanged(a[1], a[2], a[3]);
	});
}
// 在 mixer 外面开着、关了（terminals.ts）：和会话文件变了一样推。项目先看工作区，再按登记的 cwd 算
terminals.start((id, cwd) => {
	const project = state.workspace()?.sessions[id] ?? (cwd ? dirs.projectId(cwd) : null);
	if (project) changed(project, id);
});

type Handler = (req: IncomingMessage, res: ServerResponse, m: string[], url: URL) => unknown;
function fail(status: number, msg: string) { return Object.assign(new Error(msg), { status }); }

/**
 * 接口谁能用：
 *   user：认出来的人（access.who：本机、Access 的 JWT、passkey 登录的 cookie）
 *   open：谁都行，只有登录用的那几个；远程来的 POST 每个 IP 一分钟限次数（Funnel 是公网，挡一挡乱试的）
 * 写的（POST）还要是 JSON、Origin 是自己的页面。不让过的给 [状态码, 回什么]
 */
type Policy = "user" | "open";
const LOGIN = { error: "要先登录", login: true };
async function refuse(req: IncomingMessage, policy: Policy): Promise<[number, object] | null> {
	if (policy === "open") {
		if (req.method === "POST" && access.limited(req)) return [429, { error: "试得太频繁了，过一分钟再来" }];
	} else if (!(await access.who(req))) return [401, LOGIN];
	if (req.method === "POST" && (!req.headers["content-type"]?.startsWith("application/json") || !ours(req))) return [403, { error: "只收自己页面的 JSON" }];
	return null;
}

/** 会话里的图片（记录里的、排队的）：类型是记录里写的，不可信。和 /raw 一样只有那几种图片直接显示，别的（SVG、HTML……）当下载，都带 nosniff 和 sandbox 的 CSP */
const INLINE_TYPES = new Set([...INLINE].map((e) => TYPES[e]));
function sendImage(res: ServerResponse, img: { media: string; data: string } | null, maxAge: number) {
	if (!img) return void res.writeHead(404).end();
	const type = String(img.media ?? "").trim().toLowerCase();
	const inline = INLINE_TYPES.has(type);
	res.writeHead(200, {
		"content-type": inline ? type : "application/octet-stream",
		"cache-control": `private, max-age=${maxAge}`,
		"x-content-type-options": "nosniff",
		"content-security-policy": RAW_CSP,
		...(inline ? {} : { "content-disposition": "attachment" }),
	}).end(Buffer.from(img.data, "base64"));
}

const ROUTES: [method: "GET" | "POST", re: RegExp, policy: Policy, h: Handler][] = [
	["GET", /^\/api\/auth\/status$/, "open", async (req, res) => json(res, 200, access.status(req, await access.who(req)))],
	// 推送（sse.ts）：先发 build（页面的版本），再发 hello（全部状态）。连上时也从磁盘重读一次版本：换了先推给已经开着的，这条连接直接拿新的
	["GET", /^\/api\/events$/, "user", (req, res) => {
		refreshVersion();
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(version ? sse.frame("build", { version }) : ": hi\n\n");
		// 连着的时候每 30 秒再认一次：删掉了 passkey、JWT 过期了，开着的这条也断掉，不再收到运行的输出（重连时就被拦下）
		const check = setInterval(() => void access.who(req).then((u) => { if (!u) res.end(); }, () => res.end()), 30_000).unref();
		res.on("close", () => { clearInterval(check); sse.leave(res); });
		res.on("error", () => { clearInterval(check); sse.leave(res); });
		sse.join(res, workspace.hello).catch((e) => console.error(e));
	}],
	["GET", /^\/api\/health$/, "user", (_q, res) => json(res, 200, { app: "mixer", pid: process.pid })],
	["GET", /^\/api\/projects$/, "user", (_q, res) => json(res, 200, listProjects())],
	["GET", /^\/api\/tree$/, "user", async (_q, res) => json(res, 200, await tree())],
	["GET", /^\/api\/workspace$/, "user", async (_q, res) => json(res, 200, await workspace.view())],
	// 能选的模型：问命令行（models.ts），第一项是默认
	["GET", /^\/api\/models$/, "user", async (_q, res) => json(res, 200, await models.claude())],
	["GET", /^\/api\/projects\/([\w.-]+)\/sessions$/, "user", async (_q, res, m) => json(res, 200, await listSessions(m[1]))],
	["GET", /^\/api\/sessions\/([\w.-]+)\/([\w-]+)$/, "user", async (_q, res, m, url) => json(res, 200, await session(m[1], m[2], url.searchParams.get("since")))],
	// 会话开过的子代理：各自对应哪个 Agent 工具调用、现在在做什么
	["GET", /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/agents$/, "user", async (_q, res, m) => json(res, 200, await subs(m[1], m[2]))],
	["GET", /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/agents\/(a[0-9a-f]+)$/, "user", async (_q, res, m, url) => {
		const a = await agent(m[1], m[2], m[3], url.searchParams.get("since"));
		return a ? json(res, 200, a) : json(res, 404, { error: "没有这个子 agent 的记录" });
	}],
	["GET", /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/tool\/([\w-]+)$/, "user", async (_q, res, m, url) => {
		const d = await toolDetail(m[1], m[2], m[3], url.searchParams.get("agent") ?? undefined);
		return d ? json(res, 200, d) : json(res, 404, { error: "没有这个工具调用" });
	}],
	["GET", /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/result\/([\w-]+)$/, "user", async (_q, res, m, url) => {
		const t = await fullResult(m[1], m[2], m[3], url.searchParams.get("agent") ?? undefined);
		return t === null ? json(res, 404, { error: "没有" }) : json(res, 200, { text: t });
	}],
	["GET", /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/thinking\/([\w-]+)$/, "user", async (_q, res, m, url) => {
		const t = await thought(m[1], m[2], m[3], url.searchParams.get("agent") ?? undefined);
		return t === null ? json(res, 404, { error: "没有" }) : json(res, 200, { text: t });
	}],
	// 你的消息还没写进记录（网页先画上的那条）：从运行带着的图里拿
	["GET", /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/image\/([\w-]+)\/(\d+)$/, "user", async (_q, res, m, url) => {
		const agent = url.searchParams.get("agent") ?? undefined;
		const img = await image(m[1], m[2], m[3], Number(m[4]), agent).catch(() => null);
		sendImage(res, img ?? (agent ? null : runs.runImage(m[3], Number(m[4]))), 86400);
	}],
	["GET", /^\/api\/repo\/([\w.-]+)\/files$/, "user", async (_q, res, m) => json(res, 200, { root: projectPath(m[1]), files: await repo.files(projectPath(m[1])) })],
	["GET", /^\/api\/repo\/([\w.-]+)\/file$/, "user", (_q, res, m, url) => json(res, 200, repo.file(projectPath(m[1]), url.searchParams.get("path") ?? ""))],
	["GET", /^\/api\/repo\/([\w.-]+)\/raw$/, "user", (_q, res, m, url) => {
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
	["GET", /^\/api\/repo\/([\w.-]+)\/status$/, "user", async (_q, res, m) => json(res, 200, await repo.status(projectPath(m[1])))],
	["GET", /^\/api\/repo\/([\w.-]+)\/diff$/, "user", async (_q, res, m, url) => json(res, 200, { diff: await repo.diff(projectPath(m[1]), url.searchParams.get("path") ?? "") })],
	["GET", /^\/api\/repo\/([\w.-]+)\/commit\/([0-9a-f]+)$/, "user", async (_q, res, m) => json(res, 200, await repo.commit(projectPath(m[1]), m[2]))],
	["GET", /^\/api\/runs\/([\w-]+)\/tail$/, "user", (_q, res, m) => { const t = runs.tail(m[1]); return t ? json(res, 200, t) : json(res, 404, { error: "没有这次运行" }); }],
	["GET", /^\/api\/hosts\/([\w-]+)\/tasks\/([\w-]+)\/output$/, "user", async (_q, res, m) => { const o = await runs.taskOutput(m[1], m[2]); return o ? json(res, 200, o) : json(res, 404, { error: "没有这个后台任务的输出" }); }],
	["GET", /^\/api\/queue\/([\w-]+)\/image\/(\d+)$/, "user", (_q, res, m) => sendImage(res, runs.queuedImage(m[1], Number(m[2])), 3600)],
	["GET", /^\/api\/dirs$/, "user", (_q, res, _m, url) => json(res, 200, dirs.list(url.searchParams.get("path") ?? ""))],
	// cwd：新会话的文件夹（还没开过会话的项目 projectPath 找不到），只认家目录里的
	["GET", /^\/api\/skills\/([\w.-]+)$/, "user", (_q, res, m, url) => {
		const cwd = url.searchParams.get("cwd");
		json(res, 200, skills.list(m[1], cwd ? dirs.folder(cwd) : projectPath(m[1])));
	}],
	// 登录：配对码建 passkey、passkey 登录。登录成功种 cookie
	["POST", /^\/api\/auth\/register\/options$/, "open", async (req, res) => json(res, 200, await access.registerOptions(req, (await body(req, SMALL)).code))],
	["POST", /^\/api\/auth\/register$/, "open", async (req, res) => {
		const b = await body(req, SMALL);
		res.setHeader("set-cookie", await access.register(req, b.code, b.response));
		json(res, 200, { ok: true });
	}],
	["POST", /^\/api\/auth\/login\/options$/, "open", async (req, res) => json(res, 200, await access.loginOptions(req))],
	["POST", /^\/api\/auth\/login$/, "open", async (req, res) => {
		const b = await body(req, SMALL);
		res.setHeader("set-cookie", await access.login(req, b.id, b.response));
		json(res, 200, { ok: true });
	}],
	// 新的配对码（加一台设备）：已经认出来的才能要，`pnpm mixer pair` 从本机来要
	["POST", /^\/api\/pair$/, "user", (_q, res) => json(res, 200, access.pair())],
	["POST", /^\/api\/runs$/, "user", async (req, res) => {
		const b = await body(req);
		// 新会话可以直接给文件夹（还没开过会话的也行）；其余的按项目找目录
		const folder = b.mode === "new" && b.cwd ? dirs.folder(String(b.cwd)) : null;
		const cwd = folder ?? projectPath(b.project);
		const r = await runs.start({ project: folder ? dirs.projectId(folder) : b.project, cwd, session: b.session ?? null, mode: b.mode ?? "resume", at: b.at ?? null, prompt: String(b.prompt ?? ""), images: Array.isArray(b.images) ? b.images : [], permission: b.permission ?? "default", model: typeof b.model === "string" ? b.model : null, effort: typeof b.effort === "string" ? b.effort : null, uuid: typeof b.uuid === "string" ? b.uuid : null });
		json(res, 200, r);
	}],
	["POST", /^\/api\/dirs$/, "user", async (req, res) => {
		const b = await body(req);
		json(res, 200, dirs.create(String(b.parent ?? ""), String(b.name ?? "").trim()));
	}],
	// 工作区：add（放进来；不给 session 就只放文件夹，sessions 是撤销移出文件夹时一起放回去的）/ remove（不给 session 就移掉整个文件夹）/ order（文件夹拖完的顺序）
	["POST", /^\/api\/workspace$/, "user", async (req, res) => {
		const b = await body(req);
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
	// 删掉一个会话（trash.ts）：移到废纸篓。在跑、排队、待确认、终端里开着的回 409
	["POST", /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/delete$/, "user", async (_q, res, m) => {
		await trash.remove(m[1], m[2]);
		emit("workspace", null);
		json(res, 200, { ok: true });
	}],
	// 推送通知（push.ts）：公钥、存订阅、删订阅；页面在前台时报一声（有页面看着就不推）
	["GET", /^\/api\/push\/key$/, "user", (_q, res) => json(res, 200, { key: push.key() })],
	["POST", /^\/api\/push\/subscribe$/, "user", async (req, res) => {
		push.subscribe((await body(req)).subscription, typeof req.headers.origin === "string" ? req.headers.origin : null);
		json(res, 200, { ok: true });
	}],
	["POST", /^\/api\/push\/unsubscribe$/, "user", async (req, res) => {
		push.unsubscribe(String((await body(req)).endpoint ?? ""));
		json(res, 200, { ok: true });
	}],
	["POST", /^\/api\/presence$/, "user", async (req, res) => {
		const b = await body(req);
		push.presence(String(b.id ?? "").slice(0, 64), b.here === true);
		json(res, 200, { ok: true });
	}],
	["POST", /^\/api\/seen$/, "user", async (req, res) => {
		const b = await body(req);
		state.seen(String(b.session ?? ""));
		emit("state", { project: b.project, session: b.session });
		json(res, 200, { ok: true });
	}],
	["POST", /^\/api\/runs\/([\w-]+)\/stop$/, "user", (_q, res, m) => json(res, 200, { stopped: runs.stop(m[1]) })],
	["POST", /^\/api\/hosts\/([\w-]+)\/tasks\/([\w-]+)\/stop$/, "user", (_q, res, m) => json(res, 200, { stopped: runs.stopTask(m[1], m[2]) })],
	["POST", /^\/api\/queue\/([\w-]+)\/cancel$/, "user", (_q, res, m) => json(res, 200, { ok: runs.unqueue(m[1]) })],
	["POST", /^\/api\/approvals\/([\w-]+)$/, "user", async (req, res, m) => {
		const b = await body(req);
		// answers：回答提问（问题 → 答案，都是字）；mode：批准计划后的权限
		const answers = b.answers && typeof b.answers === "object" ? Object.fromEntries(Object.entries(b.answers).map(([k, v]) => [k, String(v)])) : undefined;
		const mode = ["auto", "default", "acceptEdits"].includes(b.mode) ? b.mode : undefined;
		json(res, 200, { ok: runs.answer(m[1], { allow: !!b.allow, message: typeof b.message === "string" ? b.message.slice(0, 2000) : undefined, answers, mode }) });
	}],
];

/**
 * 改了 mixer 自己的代码：停手 3 秒、mixer 也闲下来（没有运行、排队、待确认）再换上，免得打断正在跑的、丢了排着的。
 *   服务端的代码（server/、两边共用的 shared/）：类型检查过了就退出，launchd（KeepAlive）马上拉起新的，启动时顺便重新打包页面。
 *   检查没过不重启，等下次改；终端里 pnpm start 的退出了没人拉，只提示一句。
 *   只改了页面：重新打包，刷新就是新的
 */
const LAUNCHD = process.env.XPC_SERVICE_NAME === "com.mixer.server";
const dirty = { server: 0, web: 0 };
let swapping = false;
const CODE = /\.(tsx?|css|html)$/;
const touched = (kind: keyof typeof dirty) => (_: unknown, f: string | Buffer | null) => { if (CODE.test(String(f ?? ""))) dirty[kind] = Date.now(); };
watch(join(ROOT, "server"), { recursive: true }, touched("server"));
watch(join(ROOT, "shared"), { recursive: true }, touched("server"));
watch(join(ROOT, "web", "index.html"), touched("web"));
watch(join(ROOT, "web", "src"), { recursive: true }, touched("web"));
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
		refreshVersion();
		prune();
	});
}, 5000).unref();

// 打包失败（页面代码写坏了、少装了包）不能挡住起服务：有旧的 dist 就先用旧的，等下次改好了再打包；连旧的都没有才退出，让 launchd 隔一会儿再拉。
// 顶层抛出去会被上面的 uncaughtException 吞掉，后面的 listen 就不走了，进程靠文件监视挂着却不听端口
try {
	build();
} catch (e) {
	if (!existsSync(join(DIST, "index.html"))) {
		say(`打包失败，也没有旧的页面，退出：${e instanceof Error ? e.message : e}`);
		process.exit(1);
	}
	say(`打包失败，先用旧的页面：${e instanceof Error ? e.message : e}`);
}
refreshVersion();
// 别处打的包（终端里 pnpm build）：dist 的 index.html 换了就告诉开着的页面。打包之后才监视：新拉下来的仓库原来没有 dist，监视不上
watch(DIST, (_, f) => { if (String(f ?? "") === "index.html") throttle("dist", refreshVersion); });
const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
	const path = url.pathname;
	try {
		for (const [method, re, policy, h] of ROUTES) {
			const m = method === req.method ? re.exec(path) : null;
			if (!m) continue;
			const no = await refuse(req, policy);
			return no ? json(res, no[0], no[1]) : await h(req, res, m, url);
		}
		// 没有这个接口：没认出来的照样先说要登录
		if (path.startsWith("/api/")) return (await access.who(req)) ? json(res, 404, { error: "没有这个接口" }) : json(res, 401, LOGIN);
		// 页面
		const f = join(DIST, path);
		if (path !== "/" && f.startsWith(DIST + sep) && existsSync(f) && statSync(f).isFile()) {
			const head = { "content-type": TYPES[extname(f)] ?? "application/octet-stream", "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache", vary: "accept-encoding", ...(extname(f) === ".html" ? PAGE : {}) };
			const how = path.startsWith("/assets/") && PACK.has(extname(f)) ? encoding(req) : null;
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
	say(`mixer http://127.0.0.1:${PORT}/ pid ${process.pid}`);
	tunnel.keep(PORT);
	usage.start();
	models.start();
	// 先把所有会话扫一遍（第一次要读完所有记录，之后按修改时间缓存），侧栏第一次打开就快
	tree().catch((e) => console.error(e));
});
