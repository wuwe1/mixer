// 命令行：配置手机怎么访问 mixer（pnpm mixer …）。改的是 data/access.json，服务不用重启，几秒内换上。
//   pnpm mixer                    现在的配置、手机打开哪个地址
//   pnpm mixer setup cloudflare   Cloudflare Tunnel + Access：手机上什么都不用装，邮箱验证码登录。要有托管在 Cloudflare 上的域名
//   pnpm mixer setup funnel       Tailscale Funnel + passkey：不要域名；Mac 上装 Tailscale，手机什么都不用装，面容 / 指纹登录
//   pnpm mixer pair               出一个配对码（二维码），手机扫了建 passkey
//   pnpm mixer passkeys [rm <id>] 登录过的设备；删掉的那台立刻登不进来
//   pnpm mixer service            常驻（launchd）：显示要写的 plist。install [--force] 装上并启动，uninstall 停掉并删掉
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import { config, configured, update } from "./access.ts";

const PORT = Number(process.env.MIXER_PORT ?? 4848);
const LOCAL = `http://127.0.0.1:${PORT}`;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string, def = "") => (await rl.question(def ? `${q}（回车用 ${def}）：` : `${q}：`)).trim() || def;
const die = (m: string): never => { console.error(m); process.exit(1); };
const has = (cmd: string, args = ["--version"]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;

/** 本机正在跑的 mixer（没在跑给 null） */
async function local<T>(path: string, post = false): Promise<T | null> {
	try {
		const r = await fetch(`${LOCAL}${path}`, post ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : undefined);
		const d = await r.json();
		if (r.ok) return d as T;
		if (r.status === 404) die("在跑的 mixer 还是旧版本：等它闲下来自动换上，或者重启它");
		return post ? die(d?.error ?? `${r.status}`) : null;
	} catch {
		return null;
	}
}

async function showPair() {
	const p = await local<{ url: string }>("/api/pair", true);
	if (!p) return console.log("\nmixer 没在跑：先 pnpm start，再 pnpm mixer pair 出配对码");
	console.log(`\n用手机相机扫码（10 分钟内有效，用一次），在打开的页面上建一个 passkey：\n`);
	console.log(await QRCode.toString(p.url, { type: "terminal", small: true }));
	console.log(p.url);
	console.log("\n建好之后可以「添加到主屏幕」；主屏幕上打开时如果要登录，点「登录」用同一个 passkey");
}

async function setupCloudflare() {
	if (!has("cloudflared")) die("没找到 cloudflared：brew install cloudflared");
	const cur = config().cloudflare;
	const own = (await ask("隧道让 mixer 建、自己跑（1），还是你已经有一条指向 127.0.0.1:" + PORT + " 的隧道（2）", cur && !cur.tunnel ? "2" : "1")) === "1";
	let tunnel = cur?.tunnel;
	let hostname = tunnel?.hostname ?? "";
	if (own) {
		const cert = join(homedir(), ".cloudflared", "cert.pem");
		if (!existsSync(cert)) {
			console.log("\n先登录 Cloudflare：会打开浏览器，选你要用的域名");
			if (spawnSync("cloudflared", ["tunnel", "login"], { stdio: "inherit" }).status !== 0) die("登录没成功");
		}
		hostname = (await ask("手机上用的地址（在你 Cloudflare 的域名下，比如 mixer.example.com）", hostname)).toLowerCase();
		if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) die("地址不对");
		const name = "mixer";
		const list = (JSON.parse(execFileSync("cloudflared", ["tunnel", "list", "--output", "json", "--name", name], { encoding: "utf8" }) || "null") ?? []) as { id: string }[];
		let id: string | undefined = list[0]?.id;
		if (!id) {
			const out = execFileSync("cloudflared", ["tunnel", "create", name], { encoding: "utf8" });
			id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(out)?.[1];
			if (!id) die(`建隧道没成功：\n${out}`);
			console.log(`建好了隧道 ${name}（${id}）`);
		} else console.log(`用已有的隧道 ${name}（${id}）`);
		const credentials = join(homedir(), ".cloudflared", `${id}.json`);
		if (!existsSync(credentials)) die(`隧道 ${name} 已经有了，但这台机器上没有它的凭证（${credentials}）。在 Cloudflare 后台删掉它再来，或者选 2 自己配隧道`);
		// 这个地址已经有记录、指向别处会失败：不替换，免得把别的服务的域名抢过来。已经指向这条隧道（再跑一次 setup）算成功
		const dns = spawnSync("cloudflared", ["tunnel", "route", "dns", id as string, hostname], { encoding: "utf8" });
		if (dns.status !== 0 && !/already configured to route to your tunnel/i.test(`${dns.stdout}${dns.stderr}`)) die(`加 DNS 记录没成功（这个地址是不是已经有别的记录？）：\n${dns.stderr}`);
		tunnel = { id: id as string, hostname, credentials };
	}

	const seen = await local<{ team: string; aud: string; email: string } | null>("/api/auth/seen");
	console.log(`
还要在 Cloudflare 后台建一个 Access 应用，挡在 mixer 前面（只做一次）：
  1. 打开 https://one.dash.cloudflare.com → Access → Applications → Add an application → Self-hosted
  2. 域名填 ${hostname || "手机上用的那个地址"}，Session Duration 可以选 1 month
  3. Policy：Action 选 Allow，Include → Emails → 填你的邮箱
  4. 建好后，应用的 Overview 里有 Application Audience (AUD) Tag；团队域名在 Settings → Custom Pages（xxx.cloudflareaccess.com）`);
	if (seen) console.log("（下面的默认值是从刚才经过 Access 的请求里看到的）");
	const team = (await ask("\n团队域名", cur?.team ?? seen?.team)).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) die("团队域名应该像 xxx.cloudflareaccess.com");
	const aud = await ask("AUD", cur?.aud ?? seen?.aud);
	if (!/^[0-9a-f]{64}$/.test(aud)) die("AUD 是 64 位十六进制");
	const emails = (await ask("放行的邮箱（多个用逗号）", cur?.emails.join(",") ?? seen?.email)).split(",").map((e) => e.trim()).filter(Boolean);
	if (!emails.length) die("至少一个邮箱");
	const certs = await fetch(`https://${team}/cdn-cgi/access/certs`).then((r) => r.json() as Promise<{ keys?: unknown[] }>, () => null);
	if (!certs?.keys?.length) die(`拿不到 ${team} 的公钥，团队域名对吗？`);

	update((c) => { c.cloudflare = { team, aud, emails, ...(tunnel && own ? { tunnel } : {}) }; });
	console.log(`\n好了。mixer 只认带着这个 Access 应用签发、邮箱是 ${emails.join(" / ")} 的请求`);
	if (own) console.log(`隧道由 mixer 起（${await local("/api/auth/status") ? "几秒内连上" : "pnpm start 之后"}），手机打开 https://${hostname}`);
}

function tailscale() {
	for (const c of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) if (has(c, ["version"])) return c;
	return die("没找到 Tailscale：从 https://tailscale.com/download 装上并登录");
}

async function setupFunnel() {
	const ts = tailscale();
	const st = JSON.parse(execFileSync(ts, ["status", "--json"], { encoding: "utf8" })) as { BackendState?: string; Self?: { DNSName?: string } };
	if (st.BackendState !== "Running") die("Tailscale 没连上：打开 Tailscale 登录");
	const hostname = String(st.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
	if (!hostname) die("拿不到这台机器的 Tailscale 域名（MagicDNS 开了吗？）");
	const serving = spawnSync(ts, ["funnel", "status", "--json"], { encoding: "utf8" }).stdout ?? "";
	if (serving.trim() && serving.trim() !== "{}" && !serving.includes(`127.0.0.1:${PORT}`)) {
		console.log(`这台机器的 Tailscale 已经在对外提供别的服务：\n${serving}`);
		if ((await ask("继续会把 443 端口换成 mixer，继续吗（y/n）", "n")) !== "y") process.exit(0);
	}
	// 先写配置再开 Funnel：开了之后来的请求马上就要登录，不会有一段时间是敞开的
	update((c) => { c.funnel = { hostname }; });
	console.log(`\n打开 Funnel：https://${hostname} → 127.0.0.1:${PORT}（第一次可能要在浏览器里同意开启 HTTPS 和 Funnel）`);
	if (spawnSync(ts, ["funnel", "--bg", String(PORT)], { stdio: "inherit" }).status !== 0) die("Funnel 没开成");

	// 自检：从 Funnel 绕一圈回来的请求，mixer 不能当成本机的
	const s = await fetch(`https://${hostname}/api/auth/status`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json() as Promise<{ local?: boolean }>, () => null);
	if (s?.local) {
		spawnSync(ts, ["funnel", "reset"], { stdio: "inherit" });
		die("经 Funnel 来的请求被当成了本机的请求（不用登录），已经关掉 Funnel。这是 mixer 的问题，先别用这个方式");
	}
	if (!s) console.log(`（暂时连不上 https://${hostname}，证书第一次签发要等一会儿，稍后在手机上打开试试）`);
	await showPair();
}

async function passkeys(args: string[]) {
	if (args[0] === "rm") {
		const id = args[1] ?? die("pnpm mixer passkeys rm <id 开头几位>");
		const hit = config().passkeys.filter((k) => k.id.startsWith(id));
		if (hit.length !== 1) die(hit.length ? "对上了不止一个，多写几位" : "没有这个 passkey");
		update((c) => { c.passkeys = c.passkeys.filter((k) => k.id !== hit[0].id); });
		return console.log(`删掉了 ${hit[0].name}（${hit[0].id.slice(0, 8)}），它登录的也作废了`);
	}
	const ks = config().passkeys;
	if (!ks.length) return console.log("还没有 passkey：pnpm mixer pair");
	for (const k of ks) console.log(`${k.id.slice(0, 8)}  ${k.name}  ${k.at.slice(0, 10)}`);
}

// —— 常驻：launchd 开机起、挂了拉起来（KeepAlive）。main.ts 认 Label（com.mixer.server）：改了自己的代码就退出，等 launchd 拉起新的 ——
const LABEL = "com.mixer.server";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = join(homedir(), "Library", "Logs", "mixer.log");
const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const which = (cmd: string, dirs: string[]) => dirs.map((d) => join(d, cmd)).find((f) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } });

/** 要写的 plist。PATH 用现在的（去掉 pnpm 加的 node_modules/.bin 这些）：launchd 起的进程要找得到 claude、node、git */
function plist() {
	const dirs = [...new Set((process.env.PATH ?? "").split(":").filter((d) => d.startsWith("/") && !/node_modules|node-gyp-bin/.test(d)))];
	if (!which("node", dirs)) dirs.push(dirname(process.execPath));
	const node = which("node", dirs) ?? process.execPath;
	const missing = ["claude", "git"].filter((c) => !which(c, dirs));
	const env: [string, string][] = [["PATH", dirs.join(":")], ...(process.env.MIXER_PORT ? [["MIXER_PORT", process.env.MIXER_PORT] as [string, string]] : [])];
	const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(node)}</string>
		<string>server/main.ts</string>
	</array>
	<key>WorkingDirectory</key><string>${xml(ROOT)}</string>
	<key>EnvironmentVariables</key>
	<dict>
${env.map(([k, v]) => `\t\t<key>${k}</key><string>${xml(v)}</string>`).join("\n")}
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>${xml(LOG)}</string>
	<key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
	return { text, missing };
}

function service(args: string[]) {
	const domain = `gui/${process.getuid?.()}`;
	const { text, missing } = plist();
	const warn = () => { if (missing.length) console.log(`\n注意：现在的 PATH 里找不到 ${missing.join("、")}，launchd 起的 mixer 也找不到。装好、能在终端里用之后再来`); };
	if (args[0] === "install") {
		if (existsSync(PLIST) && !args.includes("--force")) die(`已经有 ${PLIST} 了（可能是你自己写的）。pnpm mixer service 看看要写的那份，确定要换：pnpm mixer service install --force`);
		// 已经装着的先停掉（没装过会失败，不管）
		spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
		mkdirSync(dirname(PLIST), { recursive: true });
		mkdirSync(dirname(LOG), { recursive: true });
		writeFileSync(PLIST, text);
		const r = spawnSync("launchctl", ["bootstrap", domain, PLIST], { encoding: "utf8" });
		if (r.status !== 0) die(`launchctl bootstrap 没成功：${r.stderr.trim()}`);
		console.log(`装好了：${PLIST}\nmixer 在 ${LOCAL}，开机自己起、挂了拉起来；日志 ${LOG}\n终端里开着的 pnpm start 要先停掉，不然端口被占着`);
		return warn();
	}
	if (args[0] === "uninstall") {
		if (!existsSync(PLIST)) return console.log(`没装过（没有 ${PLIST}）`);
		spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
		rmSync(PLIST);
		return console.log(`停掉了，删掉了 ${PLIST}`);
	}
	if (args.length) die("pnpm mixer service [install [--force] | uninstall]");
	console.log(`pnpm mixer service install 会写到 ${PLIST}${existsSync(PLIST) ? "（已经有了，要加 --force 才会覆盖）" : ""}：\n\n${text}`);
	warn();
}

async function show() {
	const c = config();
	const up = await local("/api/auth/status");
	console.log(`mixer ${up ? `在跑：${LOCAL}` : "没在跑（pnpm start）"}`);
	if (!configured(c)) {
		console.log("\n手机访问还没配置。二选一：\n  pnpm mixer setup cloudflare   有托管在 Cloudflare 上的域名；手机邮箱验证码登录\n  pnpm mixer setup funnel       不要域名，Mac 上装 Tailscale；手机用 passkey 登录");
		return;
	}
	if (c.cloudflare) {
		const t = c.cloudflare.tunnel;
		console.log(`\nCloudflare Access：${c.cloudflare.team}，放行 ${c.cloudflare.emails.join(" / ")}`);
		console.log(t ? `  隧道由 mixer 跑：https://${t.hostname}` : "  隧道在别处配的（指向 127.0.0.1:" + PORT + "）");
	}
	if (c.funnel) console.log(`\nTailscale Funnel：https://${c.funnel.hostname}（passkey 登录）`);
	console.log(`\npasskey：${c.passkeys.length} 个${c.passkeys.length ? "（pnpm mixer passkeys）" : ""}`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
	if (cmd === "setup" && rest[0] === "cloudflare") await setupCloudflare();
	else if (cmd === "setup" && rest[0] === "funnel") await setupFunnel();
	else if (cmd === "pair") await showPair();
	else if (cmd === "passkeys") await passkeys(rest);
	else if (cmd === "service") service(rest);
	else if (!cmd) await show();
	else die(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//   pnpm")).map((l) => l.slice(5)).join("\n"));
} finally {
	rl.close();
}
