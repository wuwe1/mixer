// 服务推来的事件（SSE）：运行的输出、运行状态、确认请求、排队、会话文件有变化。整个页面共用一条连接。
import { useEffect, useState } from "react";

type Handler = (data: any) => void; // biome-ignore lint: 各种事件的数据不一样
const handlers = new Map<string, Set<Handler>>();
let es: EventSource | null = null;
let up = true;
const upListeners = new Set<(u: boolean) => void>();

function connect() {
	if (es) return;
	es = new EventSource("/api/events");
	for (const type of ["run", "run-event", "approval", "approval-done", "queue", "queue-error", "session", "state"]) {
		es.addEventListener(type, (m) => { for (const h of handlers.get(type) ?? []) h(JSON.parse((m as MessageEvent).data)); });
	}
	es.onopen = () => { up = true; for (const l of upListeners) l(true); for (const h of handlers.get("reconnect") ?? []) h(null); };
	es.onerror = () => { up = false; for (const l of upListeners) l(false); };
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
