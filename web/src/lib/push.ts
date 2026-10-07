// 推送通知的页面这边（服务端是 server/push.ts，弹通知的是 public/sw.js）：
// - 起来时注册 Service Worker；已经给过通知权限的，确认订阅还在、交给服务端（换了服务端的密钥就重新订阅）
// - 第一次发送时（点按里，iOS 只在点按里给要权限）要通知权限，同意了就订阅
// - 页面在前台、有焦点时每 30 秒报一声「看着呢」，服务端这时不推（页面上已经看得见了）；放到后台、失焦马上报「走了」
// - 主屏幕图标的角标：待确认 + 工作区里跑完没看的；看着一个会话时收掉它的通知
// iOS 只有添加到主屏幕的 app 里才有推送（Safari 里没有 PushManager），没有的地方什么都不做
import { useEffect } from "react";
import { api } from "@shared/api";
import { openSession } from "./route";
import { toast } from "./toast";

const able = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** base64url 的公钥 → applicationServerKey */
const bytes = (b64: string) => {
	const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64.length / 4) * 4, "="));
	return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const same = (a: ArrayBuffer | null, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

/** 订阅（已经订过、公钥对得上就用原来的），交给服务端 */
async function subscribe() {
	const reg = await navigator.serviceWorker.ready;
	const key = bytes((await api<{ key: string }>("/api/push/key")).key);
	let sub = await reg.pushManager.getSubscription();
	if (sub && !same(sub.options.applicationServerKey, key)) {
		await sub.unsubscribe();
		sub = null;
	}
	sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	await api("/api/push/subscribe", { subscription: sub.toJSON() });
}

/** 页面起来时：注册 Service Worker，听它让打开的会话；给过权限的确认订阅还在 */
export function startPush() {
	if (!able()) return;
	navigator.serviceWorker.register("/sw.js").catch(() => {});
	navigator.serviceWorker.addEventListener("message", (e) => {
		const d = e.data as { type?: string; project?: string; session?: string } | null;
		if (d?.type === "open" && d.project && d.session) openSession(d.project, d.session);
	});
	if (Notification.permission === "granted") subscribe().catch(() => {});
}

/** 第一次发东西时（在点按里同步调）：要通知权限，同意了就订阅 */
export function askPush() {
	if (!able() || Notification.permission !== "default") return;
	Notification.requestPermission().then((p) => {
		if (p !== "granted") return;
		subscribe().then(() => toast("通知已打开：有确认要你点、跑完了、出错了，锁着屏也会提醒"), (e: Error) => toast.error(`通知没打开：${e.message}`));
	}, () => {});
}

/** 这个页面在报「看着呢」时用的 id */
const PAGE = crypto.randomUUID();
const here = () => document.visibilityState === "visible" && document.hasFocus();
/** 报一声；走的时候页面可能马上被挂起，用 keepalive */
const report = (h: boolean) => fetch("/api/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: PAGE, here: h }), keepalive: true }).catch(() => {});

/** 整页装一次：在前台、有焦点时报「看着呢」，每 30 秒一次；走了马上报 */
export function usePresence() {
	useEffect(() => {
		let last: boolean | null = null;
		const tell = (force = false) => {
			const h = here();
			if (h === last && !force) return;
			last = h;
			report(h);
		};
		const change = () => tell();
		document.addEventListener("visibilitychange", change);
		window.addEventListener("focus", change);
		window.addEventListener("blur", change);
		const gone = () => report(false);
		window.addEventListener("pagehide", gone);
		const timer = setInterval(() => { if (here()) tell(true); }, 30_000);
		tell(true);
		return () => {
			document.removeEventListener("visibilitychange", change);
			window.removeEventListener("focus", change);
			window.removeEventListener("blur", change);
			window.removeEventListener("pagehide", gone);
			clearInterval(timer);
		};
	}, []);
}

/** 主屏幕图标的角标 */
export function useBadge(n: number) {
	useEffect(() => {
		if (!("setAppBadge" in navigator)) return;
		(n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
	}, [n]);
}

/** 正看着这个会话：收掉它的通知（已经看到了） */
export function clearNotices(session: string) {
	if (!able()) return;
	navigator.serviceWorker.ready.then((r) => r.getNotifications({ tag: `s:${session}` })).then((l) => l.forEach((n) => n.close()), () => {});
}
