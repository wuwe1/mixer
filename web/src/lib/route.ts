// 地址就是状态：/p/<项目>/s/<会话>?tab=chat|files|changes&file=<路径>&leaf=<节点>
import { useEffect, useState } from "react";

export type Route = { project: string | null; session: string | null; tab: "chat" | "files" | "changes"; file: string | null; leaf: string | null };

function read(): Route {
	const m = /^\/p\/([^/]+)(?:\/s\/([^/]+))?/.exec(location.pathname);
	const q = new URLSearchParams(location.search);
	const tab = q.get("tab");
	return {
		project: m ? decodeURIComponent(m[1]) : null,
		session: m?.[2] ? decodeURIComponent(m[2]) : null,
		tab: tab === "files" || tab === "changes" ? tab : "chat",
		file: q.get("file"),
		leaf: q.get("leaf"),
	};
}

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => { for (const l of listeners) l(); });

export function go(r: Partial<Route>, replace = false) {
	const next = { ...read(), ...r };
	let path = next.project ? `/p/${encodeURIComponent(next.project)}` : "/";
	if (next.project && next.session) path += `/s/${encodeURIComponent(next.session)}`;
	const q = new URLSearchParams();
	if (next.tab !== "chat") q.set("tab", next.tab);
	if (next.file) q.set("file", next.file);
	if (next.leaf) q.set("leaf", next.leaf);
	const url = path + (q.size ? `?${q}` : "");
	if (url === location.pathname + location.search) return;
	history[replace ? "replaceState" : "pushState"](null, "", url);
	for (const l of listeners) l();
}

export function useRoute(): Route {
	const [r, setR] = useState(read);
	useEffect(() => {
		const l = () => setR(read());
		listeners.add(l);
		return () => { listeners.delete(l); };
	}, []);
	return r;
}
