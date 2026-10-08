// mixer 自己：页面的打包（web/dist）、页面的版本（开着的页面比一比就知道有没有新的）、删旧的打包文件；
// 改了自己的代码自动换上（服务端的重启、页面的重新打包）
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { say } from "./log.ts";
import * as runs from "./runs.ts";
import * as sse from "./sse.ts";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
export const DIST = join(ROOT, "web", "dist");

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
export const current = () => version;
const readVersion = () => {
	try { return /<script\b(?=[^>]*\btype="module")[^>]*\bsrc="([^"]+)"/.exec(readFileSync(join(DIST, "index.html"), "utf8"))?.[1] ?? null; } catch { return null; }
};
/**
 * 从磁盘重读版本，换了就告诉开着的页面：自己打完包、dist 的 index.html 变了（终端里 pnpm build）、有页面连上时都读。
 * 只在这里改 version：谁先读到新的谁就推 build，不会有人读了却没推。读不到（正写到一半）不算
 */
export function refreshVersion() {
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

/**
 * 改了 mixer 自己的代码：停手 3 秒、mixer 也闲下来（没有运行、排队、待确认）再换上，免得打断正在跑的、丢了排着的。
 *   服务端的代码（server/、两边共用的 shared/）：类型检查过了就退出，launchd（KeepAlive）马上拉起新的，启动时顺便重新打包页面。
 *   检查没过不重启，等下次改；终端里 pnpm start 的退出了没人拉，只提示一句。
 *   只改了页面：重新打包，刷新就是新的（rebuilt：main.ts 丢掉压好的旧文件）
 */
function watchCode(rebuilt: () => void) {
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
			rebuilt();
			say(err ? `页面改了，打包失败：\n${stderr}` : "页面改了：已重新打包");
			if (err) return;
			// 开着的页面：有新版本了
			refreshVersion();
			prune();
		});
	}, 5000).unref();
}

/** 起来时：盯着自己的代码，页面比代码旧就先打包，读版本，再盯着 dist（别处打的包） */
export function start(rebuilt: () => void) {
	watchCode(rebuilt);
	// 打包失败（页面代码写坏了、少装了包）不能挡住起服务：有旧的 dist 就先用旧的，等下次改好了再打包；连旧的都没有才退出，让 launchd 隔一会儿再拉。
	// 顶层抛出去会被 main.ts 的 uncaughtException 吞掉，后面的 listen 就不走了，进程靠文件监视挂着却不听端口
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
	// 别处打的包（终端里 pnpm build）：dist 的 index.html 换了就告诉开着的页面，0.5 秒内的合成一次。
	// 打包之后才监视：新拉下来的仓库原来没有 dist，监视不上
	let soon: NodeJS.Timeout | null = null;
	watch(DIST, (_, f) => {
		if (String(f ?? "") !== "index.html" || soon) return;
		soon = setTimeout(() => {
			soon = null;
			refreshVersion();
		}, 500);
	});
}
