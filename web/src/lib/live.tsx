// 整个页面共用的实时状态：工作区（侧栏里放的文件夹和会话）、mixer 里的运行、等人确认的请求、排着队的话。
// 会话的「状态」由这三样合起来算：等你确认 > 在跑 > 跑完了没看 / 出错了 > 终端里开着。
import { createContext, type Dispatch, type ReactNode, type SetStateAction, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type Approval, type Group, type Queued, type Run, type SessionMeta } from "./api";
import { useEvent } from "./events";
import { openSession } from "./route";

export type Status = "waiting" | "running" | "done" | "error" | "terminal" | null;

/** 工作区的改动：放进来（不给 session 就只放文件夹）、移出去（不给 session 就是整个文件夹）、文件夹的新顺序 */
export type WorkspaceOp = { op: "add"; project: string; path: string | null; session?: string } | { op: "remove"; project: string; session?: string } | { op: "order"; order: string[] };

type Live = {
	workspace: Group[] | null;
	/** 这个会话在不在工作区里 */
	inWorkspace: (session: string) => boolean;
	/** 改工作区：先改本地（拖完马上就是新顺序），再告诉服务端；失败了重新拉 */
	change: (op: WorkspaceOp) => Promise<void>;
	runs: Run[];
	approvals: Approval[];
	queue: Queued[];
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

/**
 * 拉回来的和现在的一样就不换：换了就是新对象，整个页面跟着重画（跑的时候每 1.5 秒拉一次工作区）。
 * 按 JSON 文本比，和现在的状态比（不是和上次拉回来的比：本地先改过的，失败了重新拉要能改回来）
 */
const keep = <T,>(set: Dispatch<SetStateAction<T>>) => (v: T) => set((old) => (JSON.stringify(old) === JSON.stringify(v) ? old : v));

export function LiveProvider({ children }: { children: ReactNode }) {
	const [workspace, setWorkspace] = useState<Group[] | null>(null);
	const [runs, setRuns] = useState<Run[]>([]);
	const [approvals, setApprovals] = useState<Approval[]>([]);
	const [queue, setQueue] = useState<Queued[]>([]);
	const following = useRef(new Set<string>());
	const [putWorkspace, putRuns, putApprovals, putQueue] = useMemo(() => [keep(setWorkspace), keep(setRuns), keep(setApprovals), keep(setQueue)] as const, []);

	// 会话文件一跑起来每秒都在变：最多 1.5 秒拉一次。pulled：拉过几次（拉回来没变也算，下面「终端中打开」到点了要接着看）
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [pulled, setPulled] = useState(0);
	const loadWorkspace = useCallback(() => {
		if (timer.current) return;
		timer.current = setTimeout(() => {
			timer.current = null;
			api<Group[]>("/api/workspace").then((w) => { putWorkspace(w); setPulled((n) => n + 1); }, () => {});
		}, 1500);
	}, [putWorkspace]);
	const loadAll = useCallback(() => {
		api<Group[]>("/api/workspace").then(putWorkspace, () => setWorkspace((w) => w ?? []));
		api<Run[]>("/api/runs").then(putRuns, () => {});
		api<Approval[]>("/api/approvals").then(putApprovals, () => {});
		api<Queued[]>("/api/queue").then(putQueue, () => {});
	}, [putWorkspace, putRuns, putApprovals, putQueue]);
	useEffect(loadAll, [loadAll]);
	useEvent("reconnect", loadAll);
	useEvent("session", loadWorkspace);
	// 「终端中打开」是服务端按最近 90 秒有没有写入算的：最早过期的那个到点了再拉一次，不然没有新写入时一直挂着
	useEffect(() => {
		const left = (workspace ?? []).flatMap((p) => p.sessions).filter((s) => s.active).map((s) => Date.parse(s.mtime) + 90_000 - Date.now());
		if (!left.length) return;
		const t = setTimeout(loadWorkspace, Math.max(0, Math.min(...left)) + 1000);
		return () => clearTimeout(t);
	}, [workspace, pulled, loadWorkspace]);
	useEvent("state", loadWorkspace);
	useEvent("workspace", useCallback(() => { api<Group[]>("/api/workspace").then(putWorkspace, () => {}); }, [putWorkspace]));

	useEvent("run", useCallback((r: Run) => {
		setRuns((rs) => [r, ...rs.filter((x) => x.id !== r.id)].sort((a, b) => b.started.localeCompare(a.started)));
		if (r.status === "error" && !r.session) toast.error(`启动失败：${r.error ?? ""}`.slice(0, 300));
		if (r.session && following.current.has(r.id)) {
			following.current.delete(r.id);
			openSession(r.project, r.session);
		}
		if (r.status !== "running") loadWorkspace();
	}, [loadWorkspace]));
	useEvent("approval", useCallback((a: Approval) => {
		setApprovals((l) => [...l.filter((x) => x.id !== a.id), a]);
		navigator.vibrate?.(80);
	}, []));
	useEvent("queue", putQueue);
	useEvent("queue-error", useCallback((e: { error: string }) => toast.error(`排队消息发送失败：${e.error}`.slice(0, 300)), []));
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
		const ids = new Set((workspace ?? []).flatMap((g) => g.sessions.map((s) => s.id)));
		const change = async (op: WorkspaceOp) => {
			if (op.op === "order") setWorkspace((w) => w && op.order.flatMap((id) => w.filter((g) => g.id === id)));
			if (op.op === "remove") setWorkspace((w) => w && (op.session ? w.map((g) => (g.id === op.project ? { ...g, sessions: g.sessions.filter((s) => s.id !== op.session) } : g)) : w.filter((g) => g.id !== op.project)));
			try {
				await api("/api/workspace", op);
			} catch (e) {
				toast.error(e instanceof Error ? e.message : String(e));
				loadAll();
			}
		};
		return { workspace, inWorkspace: (s: string) => ids.has(s), change, runs, approvals, queue, status, follow, reload: loadAll };
	}, [workspace, runs, approvals, queue, loadAll]);

	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 第一次发东西时请求通知权限：别的会话要你确认、跑完了，就算页面在后台也能知道 */
export function askNotify() {
	if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
}
