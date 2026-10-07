// 一个会话：中间是对话和输入框；右边是面板（宽屏常开，窄屏是从右边拉出来的整屏一页，往左滑打开、往右滑关上）：目录（你的消息）、文件、改动（默认只看这个会话改过的）。
// 顶栏只有一个开关，三个 tab 在面板顶上，写字不用图标；开的是这台设备上次看的那个 tab。
// 打开着的会话跑完了，就算看过了。
import { ArrowDown, ChevronLeft, TriangleAlert, WifiOff, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { spawner, useSpawns, useSubs } from "@/lib/agents";
import { ApiError, api, enc, temporary, type Node, type Session, type SessionMeta } from "@shared/api";
import * as drawer from "@/lib/drawer";
import { useEvent } from "@/lib/events";
import { useLive } from "@/lib/live";
import { clearNotices } from "@/lib/push";
import { go, type Panel, type Route, useWide } from "@/lib/route";
import { keysOf, tree, walk } from "@/lib/thread";
import { useIncremental } from "@/lib/use-incremental";
import { useStream } from "@/lib/use-stream";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { Conversation, type Reveal } from "./conversation";
import { Drawer } from "./drawer";
import { Changes, Files } from "./lazy";
import { Boundary, Placeholder } from "./placeholder";

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
function useStick(scroller: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>, failed: boolean) {
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
	}, [scroller, content, failed]);
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
	const { status, hosts, runs } = useLive();
	const wide = useWide();
	const key = `${project}/${session}`;
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const [reveal, setReveal] = useState<Reveal | null>(null);
	const first = useRef(true);

	// 跑的时候每 0.5 秒就有一次更新，拉增量（lib/use-incremental）。会话页按会话换着挂（app.tsx 的 key），project、session 不会变。
	// 没拿到：已经有内容就接着显示它，没有才换成出错；连不上、502 这种过一会儿自己再拉（1、2、4…30 秒）
	const retry = useRef<{ timer?: ReturnType<typeof setTimeout>; wait: number }>({ wait: 1000 });
	const { data, error, load } = useIncremental<Session>(`/api/sessions/${enc(project)}/${enc(session)}`, {
		init: kept.get(key) ?? null,
		onError: (e) => {
			if (!temporary(e)) return;
			clearTimeout(retry.current.timer);
			retry.current.timer = setTimeout(load, retry.current.wait);
			retry.current.wait = Math.min(retry.current.wait * 2, 30_000);
		},
	});
	// 新会话、分叉刚开始跑，记录文件还没写出来（404）：等着，文件有了会推 session 过来再拉
	const starting = error instanceof ApiError && error.status === 404 && runs.some((x) => x.session === session && x.status === "running");
	// 出错时整页换成「没打开」，滚动的那一层卸掉了；拉到了再挂上：靠它让下面挂在滚动层上的 effect 重新挂
	const failed = !!error && !data && !starting;
	const { away, unseen, toBottom } = useStick(scroller, content, failed);
	useEffect(() => {
		if (!data) return;
		keep(key, data);
		retry.current.wait = 1000;
	}, [key, data]);
	useEffect(() => () => clearTimeout(retry.current.timer), []);

	// 记下看到哪儿：停下来 0.15 秒再记，贴在底部记 null
	useEffect(() => {
		const el = scroller.current;
		const inner = content.current;
		if (!el || !inner) return;
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
	}, [key, failed]);
	useEvent("session", useCallback((e: { project: string; id: string }) => { if (e.project === project && e.id === session) load(); }, [project, session, load]));
	useEvent("hello", load);

	const nodes = data?.nodes;
	// 记录里有的段（消息 id 全局唯一，整个会话的一份就够）：流里的哪几段已经写进去了
	const keys = useMemo(() => keysOf(nodes ?? []), [nodes]);
	const stream = useStream(session, data?.version ?? null);
	const t = useMemo(() => (nodes ? tree(nodes) : null), [nodes]);
	const home = data?.leaf ?? null;
	const w = useMemo(() => (t ? walk(t, r.leaf, home) : null), [t, r.leaf, home]);
	// 状态用侧栏那份（看过之后会更新），还没有就用会话自己带的
	const m = meta ?? data?.meta;
	const st = status(m ?? { id: session, terminal: null, unread: null });
	// 子代理：Agent 调用下面画它在做什么；往上翻着的时候「↓」上带着还在跑的有几个
	const spawning = useMemo(() => !!nodes?.some(spawner), [nodes]);
	const subs = useSubs(project, session, spawning);
	// 终端里开着、Claude 登记着在跑：和 mixer 里在跑一样画 ping 点；闲着的只是开着
	const outside = st === "terminal" && m?.terminal === "busy";
	const busy = st === "running" || st === "waiting" || st === "background" || outside;
	// 在 mixer 里开着 claude 进程：后台子代理在不在跑看它报的后台任务；没有进程（终端里开的、进程退了）才猜
	const jobs = hosts.find((h) => h.session === session)?.tasks ?? null;
	const spawned = useSpawns(w ? w.path : null, subs, busy, jobs);
	const working = spawned ? [...spawned.values()].filter((s) => s.running).length : 0;

	// 开着的会话跑完了（页面在前台）：算看过了；它的通知也收掉
	useEffect(() => {
		const mark = () => {
			if (document.visibilityState !== "visible") return;
			clearNotices(session);
			if (st === "done" || st === "error") api("/api/seen", { project, session }).catch(() => {});
		};
		mark();
		document.addEventListener("visibilitychange", mark);
		return () => document.removeEventListener("visibilitychange", mark);
	}, [st, project, session]);

	// 第一次打开：滚到最后，贴上；切回来的（离开时不在底部、那条还在这条路上）放回原处
	useEffect(() => {
		if (!data || !w || !first.current) return;
		first.current = false;
		const spot = spots.get(key);
		if (spot && w.path.some((n) => n.uuid === spot.uuid)) setReveal({ ...spot, at: Date.now() });
		else requestAnimationFrame(() => toBottom());
	}, [data, w, key, toBottom]);

	// 刚发出去（排上队了，或者开始跑了）：不管刚才在哪，滚到最后贴上，让人看见
	const onSent = useCallback(() => requestAnimationFrame(() => toBottom(true)), [toBottom]);

	const rel = useCallback((abs: string) => (root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null), [root]);
	// 这个会话（连子代理）改过的文件：服务端照工具结果里结构化的那份给，这里只换成仓库里的相对路径
	const changed = data?.touched;
	const touched = useMemo(() => [...new Set((changed ?? []).flatMap((p) => rel(p) ?? []))], [changed, rel]);
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

	if (failed && error)
		return (
			<Placeholder icon={temporary(error) ? WifiOff : TriangleAlert} title="没打开" text={temporary(error) ? `${error.message}，过一会儿自己再试` : error.message}>
				<Button variant="outline" size="sm" onClick={load}>重试</Button>
			</Placeholder>
		);
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
								<Boundary>
									<Conversation project={project} session={session} w={w} t={t} keys={keys} onFile={onFile} chosen={data?.model ?? null} chosenEffort={data?.effort ?? null} stream={stream} status={st} busy={st === "running" || st === "waiting" || outside} scroller={scroller} reveal={reveal} spawned={spawned} />
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
				{w && t && data && <Composer project={project} session={session} w={w} ids={t.ids} version={data.version} status={st} windows={data.windows} chosen={data.model} chosenEffort={data.effort ?? null} run={stream.run} onSent={onSent} />}
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
				// 窄屏的面板是从右边拉出来的整屏一页（往左滑打开、往右滑关上）：左上角回到对话，旁边直接切目录 / 文件 / 改动；上下让开刘海和 Home 条
				<Drawer d={drawer.panel} open={!!narrow} onOpenChange={setOpen} onStart={onStart} onHidden={() => setPeek(null)} label="目录、文件、改动" className="inset-0 bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
					<div className="flex shrink-0 items-center gap-1 border-b p-1.5 pr-2">
						<Button variant="ghost" size="icon" onClick={() => go({ panel: "none" })} aria-label="回到对话">
							<ChevronLeft className="size-4" />
						</Button>
						<span className="ml-auto">
							<PanelTabs panel={panel ?? lastPanel()} counts={counts} />
						</span>
					</div>
					{body}
				</Drawer>
			)}
		</div>
	);
}
