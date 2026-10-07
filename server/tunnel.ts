// mixer 自己跑的 Cloudflare 隧道：access.json 里有 cloudflare.tunnel 就起一个 cloudflared，只转到本机的 mixer。
// 挂了隔一会儿再拉起来（越挂越久，最多一分钟）；配置改了就换一个。mixer 退出时一起停掉。
// 隧道在别处配的（比如和别的服务共用一条）：access.json 里没有 tunnel，这里什么都不做
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, FILE } from "./access.ts";
import { say } from "./log.ts";
let child: ChildProcess | null = null;
let running = "";
let fails = 0;
let wait = 0;

function check(port: number) {
	const t = config().cloudflare?.tunnel;
	const want = t ? JSON.stringify(t) : "";
	if (want === running && (child || Date.now() < wait)) return;
	if (child) {
		child.removeAllListeners("close");
		child.kill();
		child = null;
	}
	running = want;
	if (!t) return;
	// 自己写一份配置：不读 ~/.cloudflared/config.yml（那里可能是别的隧道的）
	const yml = join(FILE, "..", "cloudflared.yml");
	writeFileSync(yml, `tunnel: ${t.id}\ncredentials-file: ${t.credentials}\ningress:\n  - hostname: ${t.hostname}\n    service: http://127.0.0.1:${port}\n  - service: http_status:404\n`);
	const c = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--config", yml, "run"], { stdio: ["ignore", "ignore", "pipe"] });
	child = c;
	let up = false;
	let buf = "";
	/** 最后一行输出：起不来时它就是原因（不一定是 ERR 格式） */
	let last = "";
	c.stderr?.on("data", (d: Buffer) => {
		buf += d.toString("utf8");
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (line.trim()) last = line.replace(/^\S+ (ERR|INF|WRN) /, "");
			if (/ ERR /.test(line)) say(`cloudflared：${line.replace(/^\S+ ERR /, "")}`);
			if (!up && /Registered tunnel connection/.test(line)) {
				up = true;
				fails = 0;
				say(`隧道连上了：https://${t.hostname}`);
			}
		}
	});
	c.on("error", (e) => say(`起不来 cloudflared：${e.message}（装了吗？brew install cloudflared）`));
	// 用 close 不用 exit：没装 cloudflared 时（ENOENT）只有 error 和 close，没有 exit，child 一直不清掉、装上了也不再起
	c.on("close", (code) => {
		if (child !== c) return;
		child = null;
		fails++;
		const s = Math.min(60, 2 ** fails);
		wait = Date.now() + s * 1000;
		say(`cloudflared 退出了（${code}${up ? "" : `：${last}`}），${s} 秒后再起`);
	});
}

export function keep(port: number) {
	check(port);
	setInterval(() => check(port), 5000).unref();
	process.on("exit", stop);
}

/** 停掉 cloudflared（mixer 退出时） */
export function stop() {
	child?.removeAllListeners("close");
	child?.kill();
	child = null;
}
