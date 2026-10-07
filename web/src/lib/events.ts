// 服务推来的事件（SSE）：运行的输出、运行状态、确认请求、排队、会话文件有变化、子代理在做什么。整个页面共用一条连接。
// 连接要自己看着：EventSource 遇到不是 200 的回应（服务自动重启时隧道回 502）就彻底关了、不再重连；
// 手机上切到后台再回来，连接常常已经断了却没报错。所以：关了就退避着重连；回到前台、页面从缓存里恢复、网络回来了都重连；
// 服务每 25 秒发一个 ping，页面在前台时 60 秒什么都没收到也重连。连上了一律当成重连（reconnect，看着的会话拉增量）。
// 服务每次连上先推 hello：这时的运行、确认请求、排队、用量、工作区、正在写的那几段，各处拿它整个换掉（不另外拉：拉回来的可能比推来的旧）。
// 服务每次连上、每次重新打包后推 build（页面的版本）：和这个页面不一样就提示刷新，在后台的回到前台时直接刷新。
import { useEffect, useState } from "react";
import { toast } from "@/lib/toast";

type Handler = (data: any) => void; // biome-ignore lint: 各种事件的数据不一样
const handlers = new Map<string, Set<Handler>>();
const TYPES = ["hello", "run", "run-event", "approval", "approval-done", "queue", "queue-error", "session", "state", "usage", "workspace", "agent"];
let es: EventSource | null = null;
let up = true;
const upListeners = new Set<(u: boolean) => void>();
/** 断了之后多久再连：1 秒起，每次翻倍，最多 30 秒；连上了回到 1 秒 */
let wait = 1000;
let retry: ReturnType<typeof setTimeout> | null = null;
/** 最近一次收到东西（包括 ping） */
let heard = Date.now();
let watching = false;

const setUp = (u: boolean) => {
	up = u;
	for (const l of upListeners) l(u);
};

function connect() {
	watch();
	if (es) return;
	heard = Date.now();
	es = new EventSource("/api/events");
	for (const type of TYPES) {
		es.addEventListener(type, (m) => {
			heard = Date.now();
			for (const h of handlers.get(type) ?? []) h(JSON.parse((m as MessageEvent).data));
		});
	}
	es.addEventListener("ping", () => { heard = Date.now(); });
	es.addEventListener("build", (m) => { heard = Date.now(); built(JSON.parse((m as MessageEvent).data)); });
	es.onopen = () => {
		heard = Date.now();
		wait = 1000;
		setUp(true);
		for (const h of handlers.get("reconnect") ?? []) h(null);
	};
	es.onerror = () => {
		setUp(false);
		// 还在 CONNECTING 是浏览器自己在重连；CLOSED 是它放弃了，自己来
		if (es?.readyState === EventSource.CLOSED) later();
	};
}

/** 扔掉现在的连接，马上重连 */
function reset() {
	if (retry) clearTimeout(retry);
	retry = null;
	es?.close();
	es = null;
	connect();
}

function later() {
	if (retry) return;
	retry = setTimeout(() => { retry = null; reset(); }, wait);
	wait = Math.min(wait * 2, 30_000);
}

/** 第一次连的时候装上：回到前台、从缓存恢复、网络回来、太久没动静，都重连 */
function watch() {
	if (watching) return;
	watching = true;
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		if (stale && !document.querySelector('[role="dialog"]')) return location.reload();
		if (stale) notify();
		reset();
	});
	window.addEventListener("pageshow", (e) => { if (e.persisted) reset(); });
	window.addEventListener("online", reset);
	setInterval(() => {
		if (document.visibilityState === "visible" && !retry && Date.now() - heard > 60_000) reset();
	}, 10_000);
}

/** 这个页面是哪次打包的：index.html 里入口脚本的地址（带内容哈希）。开发服务下不比 */
const script = import.meta.env.DEV ? null : document.querySelector<HTMLScriptElement>('script[type="module"][src]');
const mine = script ? new URL(script.src, location.href).pathname : null;
/** 服务上已经是新版本了；told：提示过的版本，同一个版本只提示一次 */
let stale: string | null = null;
let told: string | null = null;

function built(d: { version?: string } | null) {
	if (!mine || !d?.version || d.version === mine) return;
	stale = d.version;
	// 在后台：回到前台时直接刷新（输入框的草稿、发件箱都存在 localStorage 里，刷新不丢）
	if (document.visibilityState === "visible") notify();
}

function notify() {
	if (!stale || told === stale) return;
	told = stale;
	toast("有新版本", { duration: Number.POSITIVE_INFINITY, action: { label: "刷新", onClick: () => location.reload() } });
}

export function useEvent(type: string, h: Handler) {
	useEffect(() => {
		connect();
		const set = handlers.get(type) ?? new Set();
		handlers.set(type, set);
		set.add(h);
		return () => { set.delete(h); };
	}, [type, h]);
}

export function useOnline() {
	const [u, setU] = useState(up);
	useEffect(() => { connect(); upListeners.add(setU); return () => { upListeners.delete(setU); }; }, []);
	return u;
}
