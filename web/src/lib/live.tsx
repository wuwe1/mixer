// 整个页面共用的实时状态：所有项目和会话（侧栏）、mixer 里的运行、等人确认的请求。
// 会话的「状态」由这三样合起来算：等你确认 > 在跑 > 跑完了没看 / 出错了 > 终端里开着。
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type Approval, type ProjectTree, type Run, type SessionMeta } from "./api";
import { useEvent } from "./events";
import { openSession } from "./route";

export type Status = "waiting" | "running" | "done" | "error" | "terminal" | null;

type Live = {
	tree: ProjectTree[] | null;
	runs: Run[];
	approvals: Approval[];
	/** 会话现在怎样 */
	status: (s: Pick<SessionMeta, "id" | "active" | "unread">) => Status;
	/** 这次运行的会话 id 一出来就打开它（新会话、分叉） */
	follow: (run: Run) => void;
	reload: () => void;
};

const Ctx = createContext<Live | null>(null);
export const useLive = () => {
	const c = useContext(Ctx);
	if (!c) throw new Error("useLive 要在 LiveProvider 里面用");
	return c;
};

export function LiveProvider({ children }: { children: ReactNode }) {
	const [tree, setTree] = useState<ProjectTree[] | null>(null);
	const [runs, setRuns] = useState<Run[]>([]);
	const [approvals, setApprovals] = useState<Approval[]>([]);
	const following = useRef(new Set<string>());

	// 会话文件一跑起来每秒都在变：最多 1.5 秒拉一次
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const loadTree = useCallback(() => {
		if (timer.current) return;
		timer.current = setTimeout(() => {
			timer.current = null;
			api<ProjectTree[]>("/api/tree").then(setTree, () => {});
		}, 1500);
	}, []);
	const loadAll = useCallback(() => {
		api<ProjectTree[]>("/api/tree").then(setTree, () => setTree((t) => t ?? []));
		api<Run[]>("/api/runs").then(setRuns, () => {});
		api<Approval[]>("/api/approvals").then(setApprovals, () => {});
	}, []);
	useEffect(loadAll, [loadAll]);
	useEvent("reconnect", loadAll);
	useEvent("session", loadTree);
	useEvent("state", loadTree);

	useEvent("run", useCallback((r: Run) => {
		setRuns((rs) => [r, ...rs.filter((x) => x.id !== r.id)].sort((a, b) => b.started.localeCompare(a.started)));
		if (r.status === "error" && !r.session) toast.error(`没跑起来：${r.error ?? ""}`.slice(0, 300));
		if (r.session && following.current.has(r.id)) {
			following.current.delete(r.id);
			openSession(r.project, r.session);
		}
		if (r.status !== "running") loadTree();
	}, [loadTree]));
	useEvent("approval", useCallback((a: Approval) => {
		setApprovals((l) => [...l.filter((x) => x.id !== a.id), a]);
		navigator.vibrate?.(80);
	}, []));
	useEvent("approval-done", useCallback((d: { id: string }) => setApprovals((l) => l.filter((a) => a.id !== d.id)), []));

	const value = useMemo<Live>(() => {
		const status = (s: Pick<SessionMeta, "id" | "active" | "unread">): Status => {
			const mine = runs.filter((r) => r.session === s.id);
			if (approvals.some((a) => mine.some((r) => r.id === a.run))) return "waiting";
			if (mine.some((r) => r.status === "running")) return "running";
			if (s.unread) return s.unread;
			if (s.active && mine.length === 0) return "terminal";
			return null;
		};
		const follow = (run: Run) => {
			if (run.session && run.mode !== "resume") openSession(run.project, run.session);
			else following.current.add(run.id);
		};
		return { tree, runs, approvals, status, follow, reload: loadAll };
	}, [tree, runs, approvals, loadAll]);

	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 第一次发东西时请求通知权限：别的会话要你确认、跑完了，就算页面在后台也能知道 */
export function askNotify() {
	if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
}
