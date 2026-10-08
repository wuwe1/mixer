// 整个页面共用的实时状态：工作区（侧栏里放的文件夹和会话）、mixer 里的运行、等人确认的请求、排着队的话，订阅用量。
// 会话的「状态」由这几样合起来算：等你确认 > 在跑 > 后台任务在跑（Claude 闲着，跑完了会叫醒它）> 跑完了没看 / 出错了 > 终端里开着。
// 都从 SSE 连上时的 hello 来（第一次、每次重连），之后按推来的事件改：工作区变了推来整份（workspace），侧栏的一行变了推那一行（session）。
import { createContext, type Dispatch, type ReactNode, type SetStateAction, useCallback, useContext, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { api, type Approval, type Group, type Hello, type Host, type Queued, type Run, type SessionMeta } from "@shared/api";
import { useEvent } from "./events";
import { openSession } from "./route";
import type { Account } from "@shared/usage";

export type Status = "waiting" | "running" | "background" | "done" | "error" | "terminal" | null;

/** 工作区的改动：放进来（不给 session 就只放文件夹；sessions 是撤销移出文件夹时一起放回去的）、移出去（不给 session 就是整个文件夹）、文件夹的新顺序 */
export type WorkspaceOp = { op: "add"; project: string; path: string | null; session?: string; sessions?: string[] } | { op: "remove"; project: string; session?: string } | { op: "order"; order: string[] };

type Live = {
	workspace: Group[] | null;
	/** 这个会话在不在工作区里 */
	inWorkspace: (session: string) => boolean;
	/** 改工作区：先改本地（拖完马上就是新顺序），再告诉服务端；失败了拉一次服务端的改回来。移出去的给一个「撤销」 */
	change: (op: WorkspaceOp) => Promise<void>;
	runs: Run[];
	/** mixer 开着的 claude 进程（各带着后台任务） */
	hosts: Host[];
	approvals: Approval[];
	queue: Queued[];
	/** 用量：各个账号（Claude、pi）用了多少 */
	usage: Account[];
	/** 会话现在怎样 */
	status: (s: Pick<SessionMeta, "id" | "terminal" | "unread">) => Status;
	/** 这次运行的会话 id 一出来就打开它（新会话、分叉） */
	follow: (run: Run) => void;
	/** 来过几次 hello（0：还没连上，运行、队列还不作数） */
	synced: number;
};

const Ctx = createContext<Live | null>(null);
export const useLive = () => {
	const c = useContext(Ctx);
	if (!c) throw new Error("useLive 要在 LiveProvider 里面用");
	return c;
};

/**
 * 推来的和现在的一样就不换：换了就是新对象，整个页面跟着重画。
 * 按 JSON 文本比，和现在的状态比（不是和上次推来的比：本地先改过的，失败了拉回来要能改回来）
 */
const keep = <T,>(set: Dispatch<SetStateAction<T>>) => (v: T) => set((old) => (JSON.stringify(old) === JSON.stringify(v) ? old : v));

export function LiveProvider({ children }: { children: ReactNode }) {
	const [workspace, setWorkspace] = useState<Group[] | null>(null);
	const [runs, setRuns] = useState<Run[]>([]);
	const [hosts, setHosts] = useState<Host[]>([]);
	const [approvals, setApprovals] = useState<Approval[]>([]);
	const [queue, setQueue] = useState<Queued[]>([]);
	const [usage, setUsage] = useState<Account[]>([]);
	/** 这个页面开的新会话、分叉（follow 过的）：一开始就出错、什么都没写出来时说一声 */
	const mine = useRef(new Set<string>());
	const runsRef = useRef(runs);
	runsRef.current = runs;
	const [synced, setSynced] = useState(0);
	const [putWorkspace, putRuns, putApprovals, putQueue] = useMemo(() => [keep(setWorkspace), keep(setRuns), keep(setApprovals), keep(setQueue)] as const, []);

	// 工作区里的会话变了（文件写了、跑完了、看过了）：通知里带着侧栏那一行，就地换掉。跑的时候 0.5 秒一次，攒着 1.5 秒换一回（整页跟着重画）。
	// 不在本地工作区里的不管（刚放进来的有 workspace 事件带着整份）
	const rows = useRef(new Map<string, SessionMeta>());
	const flush = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEvent("session", useCallback((e: { project: string; id: string; meta?: SessionMeta }) => {
		if (!e.meta) return;
		rows.current.set(e.id, e.meta);
		flush.current ??= setTimeout(() => {
			flush.current = null;
			const got = rows.current;
			rows.current = new Map();
			setWorkspace((w) => {
				if (!w) return w;
				let changed = false;
				const next = w.map((g) => {
					if (!g.sessions.some((s) => got.has(s.id))) return g;
					return { ...g, sessions: g.sessions.map((s) => {
						const m = got.get(s.id);
						if (!m) return s;
						if (JSON.stringify(m) === JSON.stringify(s)) return s;
						changed = true;
						return m;
					}) };
				});
				return changed ? next : w;
			});
		}, 1500);
	}, []));
	// 连上了（第一次、重连）：整个换成 hello 里的。断线前攒着还没换的侧栏行作废，不然过一会儿旧的盖掉 hello 里的
	useEvent("hello", useCallback((h: Hello) => {
		setSynced((n) => n + 1);
		if (flush.current) clearTimeout(flush.current);
		flush.current = null;
		rows.current = new Map();
		if (h.workspace) putWorkspace(h.workspace);
		else setWorkspace((w) => w ?? []);
		putRuns(h.runs);
		setHosts(h.hosts ?? []);
		putApprovals(h.approvals);
		putQueue(h.queue);
		setUsage(h.usage ?? []);
	}, [putWorkspace, putRuns, putApprovals, putQueue]));
	// 工作区变了（放进来、移出去、换顺序、删了会话）：推来的就是整份。之前攒着的侧栏行比它旧，作废
	useEvent("workspace", useCallback((w: Group[]) => {
		rows.current = new Map();
		putWorkspace(w);
	}, [putWorkspace]));

	useEvent("run", useCallback((r: Run) => {
		setRuns((rs) => [r, ...rs.filter((x) => x.id !== r.id)].sort((a, b) => b.started.localeCompare(a.started)));
		if (mine.current.has(r.id) && r.status !== "running") {
			if (failed(r)) toast.error(`启动失败：${r.error ?? ""}`.slice(0, 300));
			if (r.version !== undefined) mine.current.delete(r.id);
		}
	}, []));
	// 进程变了（开始、结束一轮，后台任务多了少了）：整个换掉；gone 是退出了
	useEvent("host", useCallback((h: Host | { id: string; gone: true }) => setHosts((l) => ("gone" in h ? l.filter((x) => x.id !== h.id) : [...l.filter((x) => x.id !== h.id), h])), []));
	useEvent("approval", useCallback((a: Approval) => {
		setApprovals((l) => [...l.filter((x) => x.id !== a.id), a]);
		navigator.vibrate?.(80);
	}, []));
	useEvent("queue", putQueue);
	useEvent("usage", setUsage);
	useEvent("queue-error", useCallback((e: { error: string }) => toast.error(`排队消息发送失败：${e.error}`.slice(0, 300)), []));
	useEvent("approval-done", useCallback((d: { id: string }) => setApprovals((l) => l.filter((a) => a.id !== d.id)), []));

	const value = useMemo<Live>(() => {
		const status = (s: Pick<SessionMeta, "id" | "terminal" | "unread">): Status => {
			if (approvals.some((a) => a.session === s.id)) return "waiting";
			const mine = runs.filter((r) => r.session === s.id);
			if (mine.some((r) => r.status === "running")) return "running";
			if (hosts.some((h) => h.session === s.id && h.tasks.length)) return "background";
			if (s.unread) return s.unread;
			// 在 mixer 外面开着（服务端照 Claude Code 自己记的算，开了关了都推过来）
			if (s.terminal) return "terminal";
			return null;
		};
		/** 新会话、分叉：马上打开（会话 id 起进程前就定了）。推送可能比请求的回复先到：已经出错结束了的当场说 */
		const follow = (run: Run) => {
			const now = runsRef.current.find((x) => x.id === run.id) ?? run;
			if (failed(now)) return void toast.error(`启动失败：${now.error ?? ""}`.slice(0, 300));
			if (now.version === undefined) mine.current.add(run.id);
			openSession(run.project, run.session);
		};
		const ids = new Set((workspace ?? []).flatMap((g) => g.sessions.map((s) => s.id)));
		const change = async (op: WorkspaceOp) => {
			if (op.op === "order") setWorkspace((w) => w && op.order.flatMap((id) => w.filter((g) => g.id === id)));
			if (op.op === "remove") setWorkspace((w) => w && (op.session ? w.map((g) => (g.id === op.project ? { ...g, sessions: g.sessions.filter((s) => s.id !== op.session) } : g)) : w.filter((g) => g.id !== op.project)));
			// 移出之前的样子：撤销时放回去。整个文件夹的连同里面的会话一起放回、回到原来的位置（放进来的文件夹在最上面，再排一次）
			const g = op.op === "remove" ? workspace?.find((x) => x.id === op.project) : undefined;
			const order = (workspace ?? []).map((x) => x.id);
			try {
				await api("/api/workspace", op);
			} catch (e) {
				toast.error(e instanceof Error ? e.message : String(e));
				// 本地先改了的改回来：照服务端的那份（这期间别处推来的也在里面）
				api<Group[]>("/api/workspace").then(putWorkspace, () => {});
				return;
			}
			if (!g || op.op !== "remove") return;
			const undo = async () => {
				if (op.session) return change({ op: "add", project: g.id, path: g.path, session: op.session });
				await change({ op: "add", project: g.id, path: g.path, sessions: g.sessions.map((s) => s.id) });
				await change({ op: "order", order });
			};
			toast("已移出工作区", { action: { label: "撤销", onClick: () => void undo() } });
		};
		return { workspace, inWorkspace: (s: string) => ids.has(s), change, runs, hosts, approvals, queue, usage, status, follow, synced };
	}, [workspace, runs, hosts, approvals, queue, usage, putWorkspace, synced]);

	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 新会话、分叉一开始就出错了：会话记录都没写出来（服务端给的 version 是 null） */
const failed = (r: Run) => r.status === "error" && r.version === null;

