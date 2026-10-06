// 一个会话：中间是对话和输入框；右边是面板（宽屏常开，窄屏是从右边拉出来的整屏一页，往左滑打开、往右滑关上）：目录（你的消息）、文件、改动（默认只看这个会话改过的）。
// 顶栏只有一个开关，三个 tab 在面板顶上，写字不用图标；开的是这台设备上次看的那个 tab。
// 打开着的会话跑完了，就算看过了。
import { ArrowDown, ChevronLeft, X } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { spawner, spawns, useSubs } from "@/lib/agents";
import { api, enc, type Node, type Session, type SessionMeta, type ToolNode } from "@/lib/api";
import * as drawer from "@/lib/drawer";
import { useEvent } from "@/lib/events";
import { useLive } from "@/lib/live";
import { go, type Panel, type Route, useWide } from "@/lib/route";
import { keysOf, merge, tree, walk } from "@/lib/thread";
import { useStream } from "@/lib/use-stream";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { Conversation, type Reveal } from "./conversation";
import { Changes, Files } from "./lazy";
import { edited } from "./message";
import { Boundary } from "./placeholder";

const PANELS: { v: Panel; label: string }[] = [
	{ v: "outline", label: "目录" },
	{ v: "files", label: "文件" },
	{ v: "changes", label: "改动" },
];

const LAST = "mixer:panel";
/** 这台设备上次看的 tab：顶栏的开关打开它 */
export const lastPanel = (): Panel => {
	const v = localStorage.getItem(LAST);
	return v === "files" || v === "changes" ? v : "outline";
};
export const openPanel = (v: Panel) => {
	try { localStorage.setItem(LAST, v); } catch {}
	go({ panel: v });
};

/** 现在开着哪个面板：地址里没写时，宽屏开上次看的、窄屏不开 */
export const panelOf = (r: Route, wide: boolean): Panel | null => (r.panel === "none" ? null : (r.panel ?? (wide ? lastPanel() : null)));

/**
 * 窄屏的面板：从右边拉出来的整屏一页，一直挂在页面上，位置由 lib/drawer 管（拖的时候跟手）。
 * 不用 Sheet：它关着时会卸掉，拖的时候没东西可动。onHidden：关到底、藏起来了，里面的东西可以卸了
 */
function PanelDrawer({ open, onHidden, children }: { open: boolean; onHidden: () => void; children: ReactNode }) {
	const el = useRef<HTMLDivElement>(null);
	const ov = useRef<HTMLDivElement>(null);
	const hidden = useRef(onHidden);
	hidden.current = onHidden;
	useLayoutEffect(() => (el.current && ov.current ? drawer.panel.attach(el.current, ov.current, () => hidden.current()) : undefined), []);
	useEffect(() => drawer.panel.to(open ? 1 : 0), [open]);
	useEffect(() => {
		if (!open) return;
		const esc = (e: KeyboardEvent) => { if (e.key === "Escape") go({ panel: "none" }); };
		document.addEventListener("keydown", esc);
		return () => document.removeEventListener("keydown", esc);
	}, [open]);
	return createPortal(
		<>
			<div ref={ov} aria-hidden className="fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs" onClick={() => go({ panel: "none" })} />
			<div ref={el} role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label="目录、文件、改动" data-drawer="right" className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-lg">
				{children}
			</div>
		</>,
		document.body,
	);
}

/** 面板顶上的三个 tab：目录带你的消息条数，改动带这个会话改过几个文件 */
function PanelTabs({ panel, counts }: { panel: Panel; counts: Partial<Record<Panel, { n: number; hint: string }>> }) {
	return (
		<ToggleGroup type="single" size="sm" value={panel} onValueChange={(v) => v && openPanel(v as Panel)}>
			{PANELS.map(({ v, label }) => {
				const c = counts[v];
				return (
					<ToggleGroupItem key={v} value={v} className="gap-1 px-2.5 text-muted-foreground aria-checked:bg-muted aria-checked:text-foreground" title={c?.hint}>
						{label}
						{!!c?.n && <span className="text-muted-foreground tabular-nums">{c.n}</span>}
					</ToggleGroupItem>
				);
			})}
		</ToggleGroup>
	);
}

/**
 * 贴底：停在底部附近时，新内容长出来就跟着滚到底；往上翻离开了就不跟，滚回底部又贴上。
 * 手指按着的时候不动它，免得和手抢。离开底部之后有了新内容，「↓」上带个蓝点（没看过）
 */
function useStick(scroller: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>) {
	const stick = useRef(true);
	const touching = useRef(false);
	const [away, setAway] = useState(false);
	const [unseen, setUnseen] = useState(false);
	const toBottom = useCallback((smooth = false) => {
		const el = scroller.current;
		if (!el) return;
		stick.current = true;
		setAway(false);
		setUnseen(false);
		el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
	}, [scroller]);
	useEffect(() => {
		const el = scroller.current;
		const inner = content.current;
		if (!el || !inner) return;
		// 看得见的区域下面还有多高：只有它变高了才算有新内容（往上接更早的对话不算）
		const below = () => el.scrollHeight - el.scrollTop - el.clientHeight;
		let last = below();
		const onScroll = () => {
			last = below();
			const near = last < 48;
			stick.current = near;
			setAway(!near);
			if (near) setUnseen(false);
		};
		const follow = () => { if (stick.current && !touching.current) el.scrollTop = el.scrollHeight; };
		const grown = new ResizeObserver(() => {
			if (stick.current) return follow();
			const b = below();
			if (b > last + 1) setUnseen(true);
			last = b;
		});
		// 输入框变高、键盘弹起，看得见的区域变小了：贴着的也要跟着
		const resized = new ResizeObserver(follow);
		grown.observe(inner);
		resized.observe(el);
		const down = () => { touching.current = true; };
		const up = () => { touching.current = false; };
		el.addEventListener("scroll", onScroll, { passive: true });
		el.addEventListener("touchstart", down, { passive: true });
		el.addEventListener("touchend", up, { passive: true });
		el.addEventListener("touchcancel", up, { passive: true });
		return () => {
			grown.disconnect();
			resized.disconnect();
			el.removeEventListener("scroll", onScroll);
			el.removeEventListener("touchstart", down);
			el.removeEventListener("touchend", up);
			el.removeEventListener("touchcancel", up);
		};
	}, [scroller, content]);
	return { away, unseen, toBottom };
}

// 切走再切回来不从空白开始：先画上次拿到的，再带着它的 version 去拉增量。
// 失效全靠服务端的「epoch:rev」：同一个 epoch 里节点只增不删；文件重写、服务重启、缓存被挤掉都换 epoch，对不上就给全部、整份换掉。
// 只在内存里，留最近用的 12 个；还记着离开时看到哪儿（贴在底部，或者最上面那条和它离顶部多远）
const KEEP = 12;
const kept = new Map<string, Session>();
const spots = new Map<string, { uuid: string; offset: number } | null>();
function keep(key: string, s: Session) {
	kept.delete(key);
	kept.set(key, s);
	for (const k of kept.keys()) {
		if (kept.size <= KEEP) break;
		kept.delete(k);
		spots.delete(k);
	}
}

export function SessionView({ project, root, session, r, meta }: { project: string; root: string | null; session: string; r: Route; meta: SessionMeta | undefined }) {
	const { status, queue, runs } = useLive();
	const wide = useWide();
	const [data, setData] = useState<Session | null>(() => kept.get(`${project}/${session}`) ?? null);
	const cur = useRef<Session | null>(data);
	const [error, setError] = useState<string | null>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const { away, unseen, toBottom } = useStick(scroller, content);
	const [reveal, setReveal] = useState<Reveal | null>(null);
	const first = useRef(true);

	// 跑的时候每 0.5 秒就有一次更新：上一次还没拉回来就先记下，回来了再拉一次（网慢也不会堆一串请求、旧的盖掉新的）。
	// 拿到过就只要之后变了的
	const pulling = useRef<{ key: string; again: boolean } | null>(null);
	const load = useCallback(() => {
		const key = `${project}/${session}`;
		if (pulling.current?.key === key) return void (pulling.current.again = true);
		pulling.current = { key, again: false };
		const done = () => {
			const p = pulling.current;
			if (p?.key !== key) return;
			pulling.current = null;
			if (p.again) load();
		};
		const since = cur.current ? `?since=${enc(cur.current.version)}` : "";
		api<Session>(`/api/sessions/${enc(project)}/${enc(session)}${since}`).then(
			(d) => {
				if (pulling.current?.key === key) {
					cur.current = merge(cur.current, d);
					keep(key, cur.current);
					setData(cur.current);
					setError(null);
				}
				done();
			},
			(e: Error) => { if (pulling.current?.key === key) setError(e.message); done(); },
		);
	}, [project, session]);
	useEffect(() => {
		cur.current = kept.get(`${project}/${session}`) ?? null;
		setData(cur.current);
		setError(null);
		first.current = true;
		load();
	}, [project, session, load]);

	// 记下看到哪儿：停下来 0.15 秒再记，贴在底部记 null
	useEffect(() => {
		const el = scroller.current;
		const inner = content.current;
		if (!el || !inner) return;
		const key = `${project}/${session}`;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const save = () => {
			if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) return void spots.set(key, null);
			const top = el.getBoundingClientRect().top;
			for (const n of inner.querySelectorAll<HTMLElement>('[id^="n-"]')) {
				const box = n.getBoundingClientRect();
				if (box.bottom > top) return void spots.set(key, { uuid: n.id.slice(2), offset: box.top - top });
			}
		};
		const onScroll = () => {
			clearTimeout(timer);
			timer = setTimeout(save, 150);
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			clearTimeout(timer);
			el.removeEventListener("scroll", onScroll);
		};
	}, [project, session]);
	useEvent("session", useCallback((e: { project: string; id: string }) => { if (e.project === project && e.id === session) load(); }, [project, session, load]));
	useEvent("reconnect", load);

	const nodes = data?.nodes;
	const stream = useStream(session, useMemo(() => keysOf(nodes ?? []), [nodes]));
	const t = useMemo(() => (nodes ? tree(nodes) : null), [nodes]);
	const w = useMemo(() => (t ? walk(t, r.leaf) : null), [t, r.leaf]);
	// 状态用侧栏那份（看过之后会更新），还没有就用会话自己带的
	const st = status(meta ?? data?.meta ?? { id: session, active: false, unread: null });
	const codex = (meta ?? data?.meta)?.agent === "codex";
	// 子代理（Codex 没有）：Agent 调用下面画它在做什么；往上翻着的时候「↓」上带着还在跑的有几个
	const spawning = useMemo(() => !codex && !!nodes?.some(spawner), [codex, nodes]);
	const subs = useSubs(project, session, spawning);
	const busy = st === "running" || st === "waiting" || st === "background" || st === "terminal";
	const spawned = useMemo(() => (w && !codex ? spawns(w.path, subs, busy) : null), [w, codex, subs, busy]);
	const working = spawned ? [...spawned.values()].filter((s) => s.running).length : 0;

	// 开着的会话跑完了（页面在前台）：算看过了
	useEffect(() => {
		const mark = () => { if ((st === "done" || st === "error") && document.visibilityState === "visible") api("/api/seen", { project, session }).catch(() => {}); };
		mark();
		document.addEventListener("visibilitychange", mark);
		return () => document.removeEventListener("visibilitychange", mark);
	}, [st, project, session]);

	// 第一次打开：滚到最后，贴上；切回来的（离开时不在底部、那条还在这条路上）放回原处
	useEffect(() => {
		if (!data || !w || !first.current) return;
		first.current = false;
		const spot = spots.get(`${project}/${session}`);
		if (spot && w.path.some((n) => n.uuid === spot.uuid)) setReveal({ ...spot, at: Date.now() });
		else requestAnimationFrame(() => toBottom());
	}, [data, w, project, session, toBottom]);

	// 刚发出去的话（排上队了，或者开始跑了）：不管刚才在哪，滚到最后贴上，让人看见
	const queued = queue.filter((q) => q.session === session).length;
	const running = runs.find((x) => x.session === session && x.status === "running")?.id;
	const seen = useRef({ queued, running });
	useEffect(() => {
		const before = seen.current;
		seen.current = { queued, running };
		if (queued > before.queued || (running && running !== before.running)) requestAnimationFrame(() => toBottom(true));
	}, [queued, running, toBottom]);

	const rel = useCallback((abs: string) => (root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null), [root]);
	const touched = useMemo(() => {
		const set = new Set<string>();
		for (const n of nodes ?? []) {
			const p = n.k === "tool" ? edited(n as ToolNode) : null;
			const r2 = p ? rel(p) : null;
			if (r2) set.add(r2);
		}
		return [...set];
	}, [nodes, rel]);
	const onFile = useCallback((abs: string, diff: boolean) => {
		const p = rel(abs);
		if (!p) return void toast(`不在这个项目里：${abs}`);
		go({ panel: "files", file: p, view: diff ? "diff" : null });
	}, [rel]);

	// 窄屏：拖开时先画上次看的 tab（peek），关到底、藏起来之后才卸掉里面的东西
	const narrow = wide ? null : panelOf(r, wide);
	const [peek, setPeek] = useState<Panel | null>(null);
	useEffect(() => { if (narrow) setPeek(narrow); }, [narrow]);
	const onStart = useCallback(() => setPeek(lastPanel()), []);
	const setOpen = useCallback((o: boolean) => (o ? openPanel(lastPanel()) : go({ panel: "none" })), []);
	drawer.useSwipe(drawer.panel, { on: !wide, open: !!narrow, setOpen, onStart });

	if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
	const panel = wide ? panelOf(r, wide) : (narrow ?? peek);
	const prompts = w?.path.filter((n): n is Extract<Node, { k: "user" }> => n.k === "user") ?? [];
	const jump = (uuid: string) => {
		if (!wide) go({ panel: "none" });
		setReveal({ uuid, at: Date.now() });
	};

	const body =
		panel === "outline" ? (
			<ScrollArea className="min-h-0 flex-1">
				<nav className="flex flex-col gap-0.5 p-2">
					{prompts.map((p, i) => (
						<button key={p.uuid} type="button" onClick={() => jump(p.uuid)} className="flex gap-2.5 rounded-md px-2 py-1.5 text-left text-md transition-colors hover:bg-accent">
							<span className="w-5 shrink-0 pt-px text-right text-2xs text-muted-foreground tabular-nums">{i + 1}</span>
							<span className="line-clamp-2 min-w-0 flex-1 leading-snug">{p.text || "（图片）"}</span>
						</button>
					))}
				</nav>
			</ScrollArea>
		) : panel === "files" ? (
			<Files project={project} file={r.file} view={r.view} />
		) : panel === "changes" ? (
			<Changes project={project} touched={touched} />
		) : null;
	const counts = { outline: { n: prompts.length, hint: `你的 ${prompts.length} 条消息` }, changes: { n: touched.length, hint: `这个会话改过 ${touched.length} 个文件` } };

	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="relative flex min-h-0 flex-1 flex-col">
					{/* 原生滚动：shadcn 的 ScrollArea 里面是 display:table，长代码会把整栏撑宽 */}
					<div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
						<div ref={content} className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6 md:px-6">
							{t && w ? (
								<Boundary key={session}>
									<Conversation project={project} session={session} w={w} t={t} onFile={onFile} chosen={data?.model ?? null} stream={stream} status={st} scroller={scroller} reveal={reveal} kind={codex ? "codex" : "claude"} spawned={spawned} />
								</Boundary>
							) : (
								[0, 1, 2, 3].map((i) => <Skeleton key={i} className={cn("h-16", i % 2 ? "w-3/4" : "ml-auto w-2/3")} />)
							)}
						</div>
					</div>
					{away && (
						<Button variant="outline" size="icon" className="absolute right-4 bottom-3 rounded-full shadow-md" onClick={() => toBottom(true)} aria-label="回到最新" title={working ? `回到最新 · ${working} 个子代理在跑` : "回到最新"}>
							<ArrowDown className="size-4" />
							{unseen && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-unread" />}
							{/* 还在跑的子代理有几个：灰的小数字，不抢眼 */}
							{working > 0 && <span className="absolute -top-1 -left-1 flex h-4 min-w-4 items-center justify-center rounded-full border bg-background px-1 text-2xs leading-none tabular-nums text-muted-foreground">{working}</span>}
						</Button>
					)}
				</div>
				{w && data && <Composer project={project} session={session} w={w} status={st} windows={data.windows} chosen={data.model} run={stream.run} agent={codex ? "codex" : "claude"} />}
			</div>

			{wide && panel && (
				<aside className={cn("flex shrink-0 flex-col border-l", panel === "outline" ? "w-72" : "w-[min(44rem,45vw)]")}>
					<div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-1.5">
						<PanelTabs panel={panel} counts={counts} />
						<Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => go({ panel: "none" })} aria-label="关掉面板">
							<X className="size-3.5" />
						</Button>
					</div>
					{body}
				</aside>
			)}
			{!wide && (
				// 窄屏的面板是整屏的一页：左上角回到对话，旁边直接切目录 / 文件 / 改动；上下让开刘海和 Home 条
				<PanelDrawer open={!!narrow} onHidden={() => setPeek(null)}>
					<div className="flex shrink-0 items-center gap-1 border-b p-1.5 pr-2">
						<Button variant="ghost" size="icon" onClick={() => go({ panel: "none" })} aria-label="回到对话">
							<ChevronLeft className="size-4" />
						</Button>
						<span className="ml-auto">
							<PanelTabs panel={panel ?? lastPanel()} counts={counts} />
						</span>
					</div>
					{body}
				</PanelDrawer>
			)}
		</div>
	);
}
