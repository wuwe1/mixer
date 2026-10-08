// 推送通知（Web Push）：手机锁着屏、主屏幕 app 在后台也能知道「有确认要你点」「跑完了」「出错了」。
// 页面第一次发送时要通知权限，同意了就在 Service Worker（web/public/sw.js）里订阅，订阅交给这里存进 data/push.json（不进 git）；
// VAPID 密钥第一次要时生成，也存在那里。推送经过 Apple / Google 的推送服务，不用从外面连进来。
// 有页面正看着（在前台、有焦点，45 秒内报过）就不推：页面上已经看得见了。iOS 要求每条推送都弹出来，不能推了再不显示，所以在这边拦。
// 同一个会话的通知用同一个 tag：新的盖掉旧的，不攒一堆。带上角标数（待确认 + 工作区里跑完没看的）。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";
import { type Approval, type Run, sessionTitle } from "../shared/api.ts";
import { DATA } from "./env.ts";
import { httpError, say } from "./log.ts";
import * as runs from "./runs.ts";
import * as sessions from "./sessions.ts";
import * as state from "./state.ts";

type Sub = { endpoint: string; keys: { p256dh: string; auth: string }; subject: string; at: string };
type Store = { vapid: { publicKey: string; privateKey: string } | null; subs: Sub[] };
/** 推过去的：sw.js 照它弹通知、点了打开那个会话 */
export type Message = { title: string; body: string; tag: string; project: string; session: string; badge: number };

const FILE = join(DATA, "push.json");
let store: Store = { vapid: null, subs: [] };
try { store = { ...store, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch {}

function save() {
	mkdirSync(dirname(FILE), { recursive: true });
	writeFileSync(`${FILE}.tmp`, JSON.stringify(store, null, "\t"), { mode: 0o600 });
	renameSync(`${FILE}.tmp`, FILE);
}

/** 页面订阅要的公钥（第一次要时生成） */
export function key() {
	if (!store.vapid) {
		store.vapid = webpush.generateVAPIDKeys();
		save();
	}
	return store.vapid.publicKey;
}

/**
 * 存下一个订阅（PushSubscription.toJSON()）。同一个 endpoint 换掉旧的。
 * subject：VAPID 要的联系方式，用订阅那个页面的 https 地址（Apple 认 https: / mailto:），本机的没有就写个 mailto
 */
export function subscribe(s: unknown, origin: string | null) {
	const o = (s ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	if (typeof o.endpoint !== "string" || !o.endpoint.startsWith("https://") || typeof o.keys?.p256dh !== "string" || typeof o.keys?.auth !== "string") throw httpError(400, "订阅不对");
	const sub: Sub = { endpoint: o.endpoint, keys: { p256dh: o.keys.p256dh, auth: o.keys.auth }, subject: origin?.startsWith("https://") ? origin : "mailto:mixer@localhost", at: new Date().toISOString() };
	store.subs = [...store.subs.filter((x) => x.endpoint !== sub.endpoint), sub];
	save();
}

export function unsubscribe(endpoint: string) {
	const n = store.subs.length;
	store.subs = store.subs.filter((x) => x.endpoint !== endpoint);
	if (store.subs.length !== n) save();
}

/** 哪些页面正看着：页面 id → 到什么时候算（页面在前台时每 30 秒报一次，45 秒没报就不算了） */
const watching = new Map<string, number>();
export function presence(id: string, here: boolean) {
	if (here) watching.set(id, Date.now() + 45_000);
	else watching.delete(id);
}
const watched = () => [...watching.values()].some((t) => t > Date.now());

type Send = (sub: Sub, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
let send: Send = (sub, payload, options) => webpush.sendNotification(sub, payload, options);
/** 测试用：换掉真的发送 */
export const sender = (f: Send) => { send = f; };

/** 推给所有订阅。推送服务说订阅没了（404、410）就删掉 */
export async function notify(m: Message) {
	if (watched() || !store.vapid || !store.subs.length) return;
	const vapid = store.vapid;
	await Promise.all(store.subs.map(async (s) => {
		try {
			await send(s, JSON.stringify(m), { TTL: 3600, urgency: "high", vapidDetails: { subject: s.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } });
		} catch (e) {
			const code = (e as { statusCode?: number }).statusCode;
			if (code === 404 || code === 410) unsubscribe(s.endpoint);
			else say(`推送失败（${code ?? "?"}）：${e instanceof Error ? e.message : String(e)}`);
		}
	}));
}

/** 角标：待确认的 + 工作区里跑完没看的 */
function badge() {
	const ws = state.workspace()?.sessions ?? {};
	return runs.pending().length + state.unreadSessions().filter((id) => ws[id]).length;
}

async function title(project: string, session: string) {
	const m = await sessions.row(project, session).catch(() => null);
	return m ? sessionTitle(m) : "新会话";
}

/** 这次运行最后一条回复的开头（通知里一两行） */
async function lastReply(project: string, session: string) {
	const file = sessions.locate(project, session);
	if (!file) return null;
	const nodes = (await sessions.parse(file).catch(() => null))?.nodes ?? [];
	for (let i = nodes.length - 1; i >= 0; i--) {
		const n = nodes[i];
		if (n.k === "assistant" && n.text.trim()) return n.text.trim();
	}
	return null;
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 确认卡片上那一行：命令、文件、地址…… */
function what(a: Approval) {
	const i = a.input;
	if (a.tool === "ExitPlanMode") return "计划写好了，等你看";
	const s = [i.command, i.file_path, i.path, i.url, i.pattern, i.query].find((x) => typeof x === "string");
	return `${a.tool}${s ? `：${s}` : ""}`;
}

/** 推过的运行（结束时 run 事件会来两次：结束一次，算出 version 再一次） */
const told = new Set<string>();

/** runs.ts 推给页面的事件，顺带看要不要推通知：来了确认请求；一次运行跑完、出错（点了停止的不推） */
export async function watch(type: string, data: unknown) {
	try {
		if (type === "approval") {
			const a = data as Approval;
			await notify({ title: `待确认 · ${await title(a.project, a.session)}`, body: clip(what(a)), tag: `s:${a.session}`, project: a.project, session: a.session, badge: badge() });
		}
		if (type === "run") {
			const r = data as Run;
			if (r.status === "running" || r.status === "stopped" || told.has(r.id)) return;
			told.add(r.id);
			setTimeout(() => told.delete(r.id), 3600_000).unref();
			const name = await title(r.project, r.session);
			const body = r.status === "error" ? r.error || "出错了" : (await lastReply(r.project, r.session)) || "跑完了";
			await notify({ title: `${r.status === "error" ? "出错了" : "跑完了"} · ${name}`, body: clip((body.split("\n").find((l) => l.trim()) ?? body).replace(/^#+\s*|\*\*/g, "")), tag: `s:${r.session}`, project: r.project, session: r.session, badge: badge() });
		}
	} catch (e) {
		say(`推送通知出错：${e instanceof Error ? e.message : String(e)}`);
	}
}
