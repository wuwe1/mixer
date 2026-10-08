// 谁能用 mixer。服务只听 127.0.0.1，远程来的都经过隧道，按 data/access.json（不进 git）认：
//   本机：直接放行。Host 是 127.0.0.1 / localhost、对方是回环地址、而且没有任何代理加的头（隧道转来的一定带 x-forwarded-for 之类）
//   Cloudflare Access：验 Access 加在请求上的 JWT（cf-access-jwt-assertion）：签名（团队的公钥）、iss、aud、过期、邮箱
//   passkey：Tailscale Funnel 这种前面没人拦的，靠 mixer 自己登录。Mac 上 `pnpm mixer pair` 出一个一次性的配对码（二维码），
//     手机扫码打开、建一个 passkey；之后用 passkey 登录，拿到签名的 cookie（30 天）
// access.json 一项都没配：远程的一律不认（401），第一次有远程请求时提示去 `pnpm mixer setup …`。
// 配置改了不用重启：每次按文件修改时间看要不要重读（`pnpm mixer setup …` 直接改文件）
import { createHmac, createPublicKey, type KeyObject, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { DATA, PORT } from "./env.ts";
import { httpError, say } from "./log.ts";

export const FILE = join(DATA, "access.json");

export type Passkey = { id: string; key: string; counter: number; transports?: string[]; name: string; at: string };
export type Config = {
	/** team：<团队>.cloudflareaccess.com；aud：Access 应用的 AUD；emails：放行的邮箱。tunnel：mixer 自己跑的 cloudflared（没有就是隧道在别处配的） */
	cloudflare?: { team: string; aud: string; emails: string[]; tunnel?: { id: string; hostname: string; credentials: string } };
	/** Tailscale Funnel 的域名：手机打开的地址，也是 passkey 认的域名 */
	funnel?: { hostname: string };
	passkeys: Passkey[];
	/** 给登录 cookie 签名 */
	secret: string;
};

let cfg: Config = { passkeys: [], secret: "" };
let mtime = -1;
/** 按修改时间重读；文件没有就是空的 */
export function config(): Config {
	let m = 0;
	try { m = statSync(FILE).mtimeMs; } catch {}
	if (m !== mtime) {
		mtime = m;
		try { cfg = { passkeys: [], secret: "", ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch { cfg = { passkeys: [], secret: "" }; }
	}
	return cfg;
}
/** 读最新的、改、写回去（`pnpm mixer` 和服务都会写） */
export function update(f: (c: Config) => void) {
	const c = structuredClone(config());
	f(c);
	if (!c.secret) c.secret = randomBytes(32).toString("base64url");
	mkdirSync(dirname(FILE), { recursive: true });
	writeFileSync(`${FILE}.tmp`, `${JSON.stringify(c, null, "\t")}\n`, { mode: 0o600 });
	renameSync(`${FILE}.tmp`, FILE);
	mtime = -1;
	return config();
}
/** 配过任何一种远程访问 */
export const configured = (c = config()) => !!(c.cloudflare || c.funnel || c.passkeys.length);

const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, "127.0.0.1:5173", "localhost:5173"]);
const PROXIED = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "cf-ray", "cf-connecting-ip", "cf-access-jwt-assertion", "tailscale-funnel-request", "tailscale-user-login"];
export function isLocal(req: IncomingMessage) {
	const a = req.socket.remoteAddress;
	if (a !== "127.0.0.1" && a !== "::1" && a !== "::ffff:127.0.0.1") return false;
	if (PROXIED.some((h) => h in req.headers)) return false;
	return LOCAL_HOSTS.has(String(req.headers.host ?? ""));
}
const hostOf = (req: IncomingMessage) => String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

// —— Cloudflare Access ——
/**
 * 团队的公钥：一小时拿一次；遇到不认识的 kid（换钥匙了）马上再拿，但一分钟最多一次。
 * 拿不到（断网、Cloudflare 出错）：一分钟内不再试，先用手里旧的；同时来的请求等同一次
 */
type Certs = { at: number; keys: Map<string, KeyObject>; retry?: number; fetching?: Promise<void> };
const certs = new Map<string, Certs>();
async function keyFor(team: string, kid: string) {
	const c: Certs = certs.get(team) ?? { at: 0, keys: new Map() };
	certs.set(team, c);
	const stale = Date.now() - c.at > 3600_000 || (!c.keys.has(kid) && Date.now() - c.at > 60_000);
	if (stale && !(c.retry && Date.now() < c.retry)) {
		c.fetching ??= (async () => {
			try {
				const r = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
				if (!r.ok) throw new Error(`${r.status}`);
				const d = (await r.json()) as { keys?: (JsonWebKey & { kid: string })[] };
				c.keys = new Map((d.keys ?? []).map((k) => [k.kid, createPublicKey({ key: k, format: "jwk" })]));
				c.at = Date.now();
				delete c.retry;
			} catch (e) {
				c.retry = Date.now() + 60_000;
				say(`拿不到 ${team} 的公钥（${e instanceof Error ? e.message : e}），一分钟后再试`);
			} finally {
				delete c.fetching;
			}
		})();
		await c.fetching;
	}
	return c.keys.get(kid) ?? null;
}
/** Access 的 JWT 验过了：返回邮箱 */
async function accessEmail(req: IncomingMessage, cf: NonNullable<Config["cloudflare"]>): Promise<string | null> {
	const tok = req.headers["cf-access-jwt-assertion"];
	if (typeof tok !== "string") return null;
	const [h, p, s] = tok.split(".");
	if (!h || !p || !s) return null;
	try {
		const head = b64json(h) as { alg?: string; kid?: string };
		if (head.alg !== "RS256" || !head.kid) return null;
		const key = await keyFor(cf.team, head.kid);
		if (!key || !verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) return null;
		const c = b64json(p) as { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string };
		const now = Date.now() / 1000;
		if (c.iss !== `https://${cf.team}`) return null;
		if (!(Array.isArray(c.aud) ? c.aud : [c.aud]).includes(cf.aud)) return null;
		if (!c.exp || c.exp < now || (c.nbf && c.nbf > now + 60)) return null;
		const email = String(c.email ?? "").toLowerCase();
		if (cf.emails.length && !cf.emails.some((e) => e.toLowerCase() === email)) return null;
		return email || "access";
	} catch {
		return null;
	}
}
// —— 登录 cookie：<base64url {c: passkey id, e: 过期秒}>.<签名> ——
const COOKIE = "mixer_session";
const DAYS = 30;
const sign = (s: string) => createHmac("sha256", config().secret).update(s).digest("base64url");
function session(req: IncomingMessage): Passkey | null {
	const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)\\.([\\w-]+)`).exec(String(req.headers.cookie ?? ""));
	const c = config();
	if (!m || !c.secret) return null;
	const want = Buffer.from(sign(m[1]));
	const got = Buffer.from(m[2]);
	if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
	try {
		const d = b64json(m[1]) as { c: string; e: number };
		if (d.e < Date.now() / 1000) return null;
		// passkey 删掉了，用它登录的也一起作废
		return c.passkeys.find((k) => k.id === d.c) ?? null;
	} catch {
		return null;
	}
}
const cookie = (k: Passkey) => {
	const v = Buffer.from(JSON.stringify({ c: k.id, e: Math.floor(Date.now() / 1000) + DAYS * 86400 })).toString("base64url");
	return `${COOKIE}=${v}.${sign(v)}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`;
};

/**
 * 这个请求是谁：local / access:<邮箱> / passkey:<设备>；null 是不认识，接口一律 401（没配置时远程的都是 null）。
 * 页面本身（index.html、打包的 js）谁都能拿，里面没有数据
 */
let warned = false;
export async function who(req: IncomingMessage): Promise<string | null> {
	if (isLocal(req)) return "local";
	const c = config();
	if (!configured(c)) {
		if (!warned) {
			warned = true;
			say(`有远程来的请求，但远程访问还没配置：一律拒绝。跑 pnpm mixer setup cloudflare 或 pnpm mixer setup funnel 配上`);
		}
		return null;
	}
	if (c.cloudflare) {
		const email = await accessEmail(req, c.cloudflare);
		if (email) return `access:${email}`;
	}
	const k = session(req);
	return k ? `passkey:${k.name}` : null;
}

// —— passkey ——
/** passkey 认的域名：手机打开的那个地址。只认配置里有的，不跟着请求的 Host 走 */
function rp(req: IncomingMessage) {
	const c = config();
	const host = hostOf(req);
	const ok = [c.funnel?.hostname, c.cloudflare?.tunnel?.hostname].filter(Boolean).includes(host);
	if (!ok) throw httpError(403, "这个地址不能用 passkey 登录");
	return { rpID: host, origin: `https://${host}` };
}

/** 配对码：一次性，10 分钟。拿着它才能新建 passkey（第一台设备就是这样进来的） */
const pairs = new Map<string, { until: number; challenge: string | null }>();
const ttl = <T extends { until: number }>(m: Map<string, T>) => { for (const [k, v] of m) if (v.until < Date.now()) m.delete(k); };
export function pair() {
	const c = config();
	const host = c.funnel?.hostname ?? c.cloudflare?.tunnel?.hostname;
	if (!host) throw httpError(400, "还没配置手机访问的地址：先跑 pnpm mixer setup funnel");
	ttl(pairs);
	const code = randomBytes(16).toString("base64url");
	pairs.set(code, { until: Date.now() + 600_000, challenge: null });
	return { url: `https://${host}/?pair=${code}`, until: new Date(Date.now() + 600_000).toISOString() };
}
const pairing = (code: unknown) => {
	ttl(pairs);
	const p = typeof code === "string" ? pairs.get(code) : undefined;
	if (!p) throw httpError(403, "配对码不对或过期了：在 Mac 上再跑一次 pnpm mixer pair");
	return p;
};

const deviceName = (req: IncomingMessage) => {
	const ua = String(req.headers["user-agent"] ?? "");
	return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : "设备";
};

/** 验证没过（库对来源、挑战不对是直接抛错的）：一律 403，不当成服务出错 */
const rejected = (e?: unknown): never => { throw httpError(403, `passkey 没通过验证${e instanceof Error ? `：${e.message}` : ""}`); };

export async function registerOptions(req: IncomingMessage, code: unknown) {
	const p = pairing(code);
	const { rpID } = rp(req);
	const o = await generateRegistrationOptions({
		rpName: "mixer",
		rpID,
		userName: "mixer",
		userDisplayName: "mixer",
		attestationType: "none",
		excludeCredentials: config().passkeys.map((k) => ({ id: k.id, transports: k.transports })),
		authenticatorSelection: { residentKey: "required", userVerification: "required" },
	});
	p.challenge = o.challenge;
	return o;
}
export async function register(req: IncomingMessage, code: unknown, response: unknown) {
	const p = pairing(code);
	if (!p.challenge) throw httpError(400, "先拿注册参数");
	const { rpID, origin } = rp(req);
	const v = await verifyRegistrationResponse({ response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"], expectedChallenge: p.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }).catch(rejected);
	if (!v.verified) throw rejected();
	pairs.delete(code as string);
	const cr = v.registrationInfo.credential;
	const k: Passkey = { id: cr.id, key: Buffer.from(cr.publicKey).toString("base64url"), counter: cr.counter, transports: cr.transports, name: deviceName(req), at: new Date().toISOString() };
	update((c) => { c.passkeys = [...c.passkeys.filter((x) => x.id !== k.id), k]; });
	say(`新的 passkey：${k.name}`);
	return cookie(k);
}

/** 登录的挑战：发出去的记着，2 分钟内用一次 */
const challenges = new Map<string, { until: number; challenge: string }>();
export async function loginOptions(req: IncomingMessage) {
	const { rpID } = rp(req);
	ttl(challenges);
	const o = await generateAuthenticationOptions({ rpID, userVerification: "required" });
	const id = randomBytes(12).toString("base64url");
	challenges.set(id, { until: Date.now() + 120_000, challenge: o.challenge });
	return { id, options: o };
}
export async function login(req: IncomingMessage, id: unknown, response: unknown) {
	ttl(challenges);
	const ch = typeof id === "string" ? challenges.get(id) : undefined;
	if (!ch) throw httpError(403, "登录超时了，再试一次");
	challenges.delete(id as string);
	const res = response as Parameters<typeof verifyAuthenticationResponse>[0]["response"];
	const k = config().passkeys.find((x) => x.id === res?.id);
	if (!k) throw httpError(403, "这个 passkey 不认识（可能被删了）：在 Mac 上 pnpm mixer pair 重新配对");
	const { rpID, origin } = rp(req);
	const v = await verifyAuthenticationResponse({
		response: res,
		expectedChallenge: ch.challenge,
		expectedOrigin: origin,
		expectedRPID: rpID,
		credential: { id: k.id, publicKey: Buffer.from(k.key, "base64url"), counter: k.counter, transports: k.transports },
		requireUserVerification: true,
	}).catch(rejected);
	if (!v.verified) throw rejected();
	update((c) => { for (const x of c.passkeys) if (x.id === k.id) x.counter = v.authenticationInfo.newCounter; });
	return cookie(k);
}

/**
 * 对方的 IP：经 Cloudflare 来的看 cf-connecting-ip（Cloudflare 自己写的）；经 Funnel 来的看 x-forwarded-for 最后一个
 * （前面的是对方自己能写的，最后一个是 Tailscale 加的；cf-* 头 Funnel 不管，也是对方能写的）
 */
function clientIp(req: IncomingMessage) {
	const cf = req.headers["cf-connecting-ip"];
	if (typeof cf === "string" && cf && !("tailscale-funnel-request" in req.headers)) return cf.trim();
	const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	return xff.at(-1) ?? req.socket.remoteAddress ?? "";
}
/** 登录相关的接口：远程来的每个 IP 一分钟最多 30 次（Funnel 是公网，挡一挡乱试的） */
const buckets = new Map<string, { at: number; n: number }>();
export function limited(req: IncomingMessage) {
	if (isLocal(req)) return false;
	const now = Date.now();
	for (const [k, b] of buckets) if (now - b.at > 60_000) buckets.delete(k);
	const ip = clientIp(req);
	const b = buckets.get(ip) ?? { at: now, n: 0 };
	buckets.set(ip, b);
	return ++b.n > 30;
}

/** 页面打开时问：我是谁、能不能用 passkey 登录 */
export function status(req: IncomingMessage, via: string | null) {
	const c = config();
	let passkey = false;
	try { rp(req); passkey = true; } catch {}
	return { via, local: via === "local", passkey, passkeys: c.passkeys.length };
}
