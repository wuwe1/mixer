// 地址就是状态：/p/<项目>[/s/<会话>]?panel=outline|files|changes|none&file=<路径>&view=diff&leaf=<节点>
//   panel：右边的面板。不写时，宽屏默认开「目录」，窄屏不开；none 是关掉
//   file / view：面板里看的文件，view=diff 看它的改动；leaf：对话走到哪片叶子（看哪个版本）
import { useEffect, useState } from "react";

export type Panel = "outline" | "files" | "changes";
export type Route = { project: string | null; session: string | null; panel: Panel | "none" | null; file: string | null; view: "diff" | null; leaf: string | null };

function read(): Route {
	const m = /^\/p\/([^/]+)(?:\/s\/([^/]+))?/.exec(location.pathname);
	const q = new URLSearchParams(location.search);
	const panel = q.get("panel");
	return {
		project: m ? decodeURIComponent(m[1]) : null,
		session: m?.[2] ? decodeURIComponent(m[2]) : null,
		panel: panel === "outline" || panel === "files" || panel === "changes" || panel === "none" ? panel : null,
		file: q.get("file"),
		view: q.get("view") === "diff" ? "diff" : null,
		leaf: q.get("leaf"),
	};
}

// 主屏幕 App 打开时回到上次看的地方：iOS 添加到主屏幕记的是当时那个地址，不一定认 manifest 的 start_url。
// 只管冷启动（navigate），刷新（reload，比如有新版本）留在原处
const LAST = "mixer:route";
/** 从主屏幕打开的（没有地址栏） */
export const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
if (standalone && nav?.type === "navigate") {
	const last = localStorage.getItem(LAST);
	if (last && last !== location.pathname + location.search) history.replaceState(null, "", last);
}
const remember = () => localStorage.setItem(LAST, location.pathname + location.search);
remember();

const listeners = new Set<() => void>([remember]);
window.addEventListener("popstate", () => { for (const l of listeners) l(); });

export function go(r: Partial<Route>, replace = false) {
	const cur = read();
	const next = { ...cur, ...r };
	// 换了项目：上一个项目的文件、版本选择都不算数了（这次明确给了的除外）；换了会话：版本选择不算数
	if (next.project !== cur.project) {
		if (!("file" in r)) next.file = null;
		if (!("view" in r)) next.view = null;
	}
	if ((next.project !== cur.project || next.session !== cur.session) && !("leaf" in r)) next.leaf = null;
	let path = next.project ? `/p/${encodeURIComponent(next.project)}` : "/";
	if (next.project && next.session) path += `/s/${encodeURIComponent(next.session)}`;
	const q = new URLSearchParams();
	if (next.panel) q.set("panel", next.panel);
	if (next.file) q.set("file", next.file);
	if (next.view) q.set("view", next.view);
	if (next.leaf) q.set("leaf", next.leaf);
	const url = path + (q.size ? `?${q}` : "");
	if (url === location.pathname + location.search) return;
	history[replace ? "replaceState" : "pushState"](null, "", url);
	for (const l of listeners) l();
}

/** 打开一个会话：面板保持（上一个会话的版本选择 go 会清掉） */
export const openSession = (project: string, session: string) => go({ project, session });
/** 打开项目页：会话页的面板、文件都不带过去 */
export const openProject = (project: string) => go({ project, session: null, panel: null, file: null, view: null });

export function useRoute(): Route {
	const [r, setR] = useState(read);
	useEffect(() => {
		const l = () => setR(read());
		listeners.add(l);
		return () => { listeners.delete(l); };
	}, []);
	return r;
}

const PANEL = "mixer:panel";
/** 这台设备上次看的面板 tab：顶栏的开关打开它 */
export const lastPanel = (): Panel => {
	const v = localStorage.getItem(PANEL);
	return v === "files" || v === "changes" ? v : "outline";
};
/** 打开面板的一个 tab，记下来下次开它 */
export const openPanel = (v: Panel) => {
	try { localStorage.setItem(PANEL, v); } catch {}
	go({ panel: v });
};
/** 现在开着哪个面板：地址里没写时，宽屏开上次看的、窄屏不开 */
export const panelOf = (r: Route, wide: boolean): Panel | null => (r.panel === "none" ? null : (r.panel ?? (wide ? lastPanel() : null)));

/** 宽屏（≥1280px）：右边的面板常开 */
export function useWide() {
	const q = "(min-width: 1280px)";
	const [w, setW] = useState(() => matchMedia(q).matches);
	useEffect(() => {
		const m = matchMedia(q);
		const f = () => setW(m.matches);
		m.addEventListener("change", f);
		return () => m.removeEventListener("change", f);
	}, []);
	return w;
}
