// access.ts：谁能用 mixer。本机、Cloudflare Access 的 JWT、passkey 登录的 cookie
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.MIXER_DATA = mkdtempSync(join(tmpdir(), "mixer-access-"));
process.env.MIXER_PORT = "4848";
const access = await import("../server/access.ts");

type Headers = Record<string, string>;
const req = (headers: Headers, remoteAddress = "127.0.0.1") => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;
/** 隧道转来的：对方也是回环地址（cloudflared、tailscaled 在本机），但带着代理的头 */
const remote = (h: Headers = {}) => req({ host: "mixer.example.com", "x-forwarded-for": "203.0.113.7", ...h });

// —— 假的 Cloudflare Access：自己的钥匙，拦住拿公钥的 fetch ——
const TEAM = "demo.cloudflareaccess.com";
const AUD = "a".repeat(64);
const EMAIL = "me@example.com";
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
let fetched = 0;
globalThis.fetch = (async (url: string | URL) => {
	assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
	fetched++;
	return new Response(JSON.stringify({ keys: [{ ...key.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] }));
}) as typeof fetch;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
function jwt(claims: object = {}, head: object = {}, k: KeyObject = key.privateKey) {
	const h = b64({ alg: "RS256", kid: "k1", typ: "JWT", ...head });
	const p = b64({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: now() + 600, iat: now(), ...claims });
	return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), k).toString("base64url")}`;
}
const viaAccess = (tok: string) => remote({ "cf-access-jwt-assertion": tok, "cf-ray": "x" });

test("本机：Host 是 127.0.0.1 / localhost、对方是回环地址、没有代理的头", async () => {
	for (const host of ["127.0.0.1:4848", "localhost:4848", "127.0.0.1:5173", "localhost:5173"]) {
		for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
			assert.equal(access.isLocal(req({ host }, a)), true, `${host} ${a}`);
			assert.equal(await access.who(req({ host }, a)), "local");
		}
	}
});

test("不是本机：对方不是回环地址", () => {
	for (const a of ["192.168.1.5", "10.0.0.2", "::ffff:192.168.1.5", "100.64.0.1", ""]) assert.equal(access.isLocal(req({ host: "127.0.0.1:4848" }, a)), false, a);
});

test("不是本机：带着任何一个代理加的头", () => {
	for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "cf-ray", "cf-connecting-ip", "cf-access-jwt-assertion", "tailscale-funnel-request", "tailscale-user-login"]) {
		assert.equal(access.isLocal(req({ host: "127.0.0.1:4848", [h]: "x" })), false, h);
	}
});

test("不是本机：Host 不对（DNS rebinding、别的端口、没有 Host）", () => {
	for (const host of ["evil.example.com", "evil.example.com:4848", "127.0.0.1", "127.0.0.1:8080", "localhost", "127.0.0.1.example.com:4848", ""]) {
		assert.equal(access.isLocal(req({ host })), false, host);
	}
	assert.equal(access.isLocal(req({})), false);
});

test("没配置：远程的一律不认，带着 Access JWT 也不认（不验签）", async () => {
	assert.equal(access.configured(), false);
	assert.equal(await access.who(remote()), null);
	const fake = `${b64({ alg: "none" })}.${b64({ iss: `https://${TEAM}`, aud: AUD, email: EMAIL })}.`;
	assert.equal(await access.who(viaAccess(fake)), null);
	// 看到的记下来给 setup cloudflare 当默认值
	assert.deepEqual(access.seenAccess(), { team: TEAM, aud: AUD, email: EMAIL });
	assert.equal(fetched, 0);
});

test("Cloudflare Access：验过的 JWT → access:<邮箱>", async () => {
	access.update((c) => { c.cloudflare = { team: TEAM, aud: AUD, emails: ["Me@Example.com"] }; });
	assert.equal(await access.who(viaAccess(jwt())), `access:${EMAIL}`);
	// aud 是字符串也行
	assert.equal(await access.who(viaAccess(jwt({ aud: AUD }))), `access:${EMAIL}`);
	// 公钥一小时拿一次
	assert.equal(await access.who(viaAccess(jwt())), `access:${EMAIL}`);
	assert.equal(fetched, 1);
});

test("Cloudflare Access：哪一样不对都不认", async () => {
	const bad: [string, string][] = [
		["aud 不对", jwt({ aud: ["b".repeat(64)] })],
		["iss 不对", jwt({ iss: "https://evil.cloudflareaccess.com" })],
		["过期了", jwt({ exp: now() - 10 })],
		["没有 exp", jwt({ exp: undefined })],
		["还没生效", jwt({ nbf: now() + 3600 })],
		["邮箱不在名单里", jwt({ email: "someone@example.com" })],
		["别的钥匙签的", jwt({}, {}, other.privateKey)],
		["alg none", (() => { const [, p] = jwt().split("."); return `${b64({ alg: "none", kid: "k1" })}.${p}.`; })()],
		["alg HS256", (() => { const [, p, s] = jwt().split("."); return `${b64({ alg: "HS256", kid: "k1" })}.${p}.${s}`; })()],
		["没有 kid", jwt({}, { kid: undefined })],
		["改了内容", (() => { const [h, , s] = jwt().split("."); return `${h}.${b64({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: now() + 9999 })}.${s}`; })()],
		["不是 JWT", "abc"],
		["空的", ""],
	];
	for (const [why, tok] of bad) assert.equal(await access.who(viaAccess(tok)), null, why);
	// 不认识的 kid：一分钟内不再去拿公钥
	assert.equal(await access.who(viaAccess(jwt({}, { kid: "k2" }))), null);
	assert.equal(fetched, 1);
});

// —— passkey 登录的 cookie：<base64url {c: passkey id, e: 过期秒}>.<HMAC> ——
const PK = { id: "cred-1", key: "x", counter: 0, name: "iPhone", at: "2026-01-01T00:00:00.000Z" };
function cookie(c: string, e: number, secret = access.config().secret) {
	const v = Buffer.from(JSON.stringify({ c, e })).toString("base64url");
	return `other=1; mixer_session=${v}.${createHmac("sha256", secret).update(v).digest("base64url")}`;
}
const viaFunnel = (cookie?: string) => req({ host: "mac.example.ts.net", "x-forwarded-for": "203.0.113.7", "tailscale-funnel-request": "?1", ...(cookie ? { cookie } : {}) });

test("passkey：签名对、没过期、passkey 还在 → passkey:<设备>", async () => {
	access.update((c) => { delete c.cloudflare; c.funnel = { hostname: "mac.example.ts.net" }; c.passkeys = [PK]; });
	assert.equal(await access.who(viaFunnel(cookie(PK.id, now() + 3600))), "passkey:iPhone");
});

test("passkey：没有 cookie、改过、签名不对、过期、passkey 删了 → 不认", async () => {
	const ok = cookie(PK.id, now() + 3600);
	const [, v, s] = /mixer_session=([\w-]+)\.([\w-]+)/.exec(ok) ?? [];
	assert.equal(await access.who(viaFunnel()), null);
	// 换成别的 passkey id，签名还是原来的
	assert.equal(await access.who(viaFunnel(`mixer_session=${Buffer.from(JSON.stringify({ c: "cred-2", e: now() + 3600 })).toString("base64url")}.${s}`)), null);
	assert.equal(await access.who(viaFunnel(`mixer_session=${v}.${s[0] === "A" ? "B" : "A"}${s.slice(1)}`)), null);
	assert.equal(await access.who(viaFunnel(cookie(PK.id, now() + 3600, "not-the-secret"))), null);
	assert.equal(await access.who(viaFunnel(cookie(PK.id, now() - 1))), null);
	access.update((c) => { c.passkeys = []; });
	assert.equal(await access.who(viaFunnel(ok)), null);
});

test("Access 和 passkey 都配了：哪个对都行", async () => {
	access.update((c) => { c.cloudflare = { team: TEAM, aud: AUD, emails: [EMAIL] }; c.passkeys = [PK]; });
	assert.equal(await access.who(viaAccess(jwt())), `access:${EMAIL}`);
	assert.equal(await access.who(viaFunnel(cookie(PK.id, now() + 3600))), "passkey:iPhone");
	assert.equal(await access.who(viaAccess(jwt({ email: "someone@example.com" }))), null);
});

test("登录接口限次数：远程每个 IP 一分钟 30 次，本机不限", () => {
	const a = () => req({ host: "mixer.example.com", "cf-connecting-ip": "198.51.100.1" });
	for (let i = 0; i < 30; i++) assert.equal(access.limited(a()), false);
	assert.equal(access.limited(a()), true);
	// 别的 IP 不受影响
	assert.equal(access.limited(req({ host: "mixer.example.com", "cf-connecting-ip": "198.51.100.2" })), false);
	for (let i = 0; i < 40; i++) assert.equal(access.limited(req({ host: "127.0.0.1:4848" })), false);
});
