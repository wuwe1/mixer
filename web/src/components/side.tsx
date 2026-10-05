// 侧栏：项目 → 会话。每个会话前面一个状态：等你确认、在跑、跑完了没看、出错了、终端里开着。分叉出来的会话挂在原会话下面。
// 有状态的项目自动展开；其余的照人上次的开合（存在这台设备上）。
import { ChevronRight, CircleAlert, CircleX, Folder, GitFork, Loader2, Search, SquarePen, SquareTerminal, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
	Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuAction,
	SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProjectTree, SessionMeta } from "@/lib/api";
import { useOnline } from "@/lib/events";
import { type Status, useLive } from "@/lib/live";
import { go, openSession, type Route } from "@/lib/route";
import { since } from "@/lib/time";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<Exclude<Status, null>, string> = { waiting: "等你确认", running: "在跑", done: "跑完了，还没看", error: "出错了，还没看", terminal: "终端里开着" };

export function StatusIcon({ s, className }: { s: Status; className?: string }) {
	const icon =
		s === "waiting" ? <CircleAlert className="size-3.5 text-amber-500" />
		: s === "running" ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
		: s === "done" ? <span className="size-2 rounded-full bg-primary" />
		: s === "error" ? <CircleX className="size-3.5 text-destructive" />
		: s === "terminal" ? <SquareTerminal className="size-3.5 text-muted-foreground" />
		: null;
	return (
		<span className={cn("flex size-4 shrink-0 items-center justify-center", className)} title={s ? STATUS_LABEL[s] : undefined}>
			{icon}
		</span>
	);
}
export const statusLabel = (s: Status) => (s ? STATUS_LABEL[s] : null);

export const projectName = (p: { path: string | null; id: string }) => p.path?.split("/").pop() || p.id;
/** 分叉出来的会话：标题用分叉后问的第一句（前面的都是原会话的） */
export const sessionTitle = (s: SessionMeta) => (s.parent ? s.fresh || s.last || s.title : s.title || s.first) || s.id.slice(0, 8);

const OPEN_KEY = "mixer.open";
function useOpenState() {
	const [open, setOpen] = useState<Record<string, boolean>>(() => {
		try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}"); } catch { return {}; }
	});
	const set = (id: string, o: boolean) => {
		setOpen((m) => {
			const n = { ...m, [id]: o };
			try { localStorage.setItem(OPEN_KEY, JSON.stringify(n)); } catch {}
			return n;
		});
	};
	return [open, set] as const;
}

type Family = { head: SessionMeta; kids: SessionMeta[]; latest: string };
function families(sessions: SessionMeta[]): Family[] {
	const ids = new Set(sessions.map((s) => s.id));
	const map = new Map<string, Family>();
	for (const s of sessions) if (!s.parent || !ids.has(s.parent)) map.set(s.id, { head: s, kids: [], latest: s.mtime });
	for (const s of sessions) {
		const f = s.parent ? map.get(s.parent) : undefined;
		if (!f || f.head.id === s.id) continue;
		f.kids.push(s);
		if (s.mtime > f.latest) f.latest = s.mtime;
	}
	for (const f of map.values()) f.kids.sort((a, b) => b.mtime.localeCompare(a.mtime));
	return [...map.values()].sort((a, b) => b.latest.localeCompare(a.latest));
}

const SHOWN = 5;
const SHOWN_PROJECTS = 10;

function SessionRow({ s, r, kid }: { s: SessionMeta; r: Route; kid?: boolean }) {
	const { status } = useLive();
	const { setOpenMobile } = useSidebar();
	const st = status(s);
	return (
		<SidebarMenuSubItem>
			<SidebarMenuSubButton asChild isActive={r.session === s.id} className={cn("h-8 w-full gap-1.5 text-left", kid && "pl-5")}>
				<button type="button" onClick={() => { openSession(r.project as string, s.id); setOpenMobile(false); }}>
					{st ? <StatusIcon s={st} /> : kid ? <GitFork className="size-3! text-muted-foreground" /> : <StatusIcon s={null} />}
					<span className={cn("min-w-0 flex-1 truncate text-[13px]", st === "done" || st === "error" || st === "waiting" ? "font-medium" : "")}>{sessionTitle(s)}</span>
					<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{since(s.mtime)}</span>
				</button>
			</SidebarMenuSubButton>
		</SidebarMenuSubItem>
	);
}

function ProjectItem({ p, r, open, setOpen, q }: { p: ProjectTree; r: Route; open: boolean; setOpen: (o: boolean) => void; q: string }) {
	const { status } = useLive();
	const { setOpenMobile } = useSidebar();
	const [all, setAll] = useState(false);
	const fams = useMemo(() => families(p.sessions), [p.sessions]);
	const busy = (f: Family) => [f.head, ...f.kids].some((s) => status(s) && status(s) !== "terminal");
	const shown = q ? fams : all ? fams : fams.filter((f, i) => i < SHOWN || busy(f) || [f.head, ...f.kids].some((s) => s.id === r.session));
	const counts = useMemo(() => {
		const c = { waiting: 0, running: 0, unread: 0 };
		for (const s of p.sessions) {
			const st = status(s);
			if (st === "waiting") c.waiting++;
			else if (st === "running") c.running++;
			else if (st === "done" || st === "error") c.unread++;
		}
		return c;
	}, [p.sessions, status]);
	// 会话行的点击用的是这个项目
	const row = { ...r, project: p.id };
	return (
		<Collapsible open={open} onOpenChange={setOpen} className="group/collapsible">
			<SidebarMenuItem>
				<SidebarMenuButton isActive={r.project === p.id && !r.session} onClick={() => { go({ project: p.id, session: null, leaf: null }); setOpen(true); setOpenMobile(false); }} className="gap-2">
					<Folder className="text-muted-foreground" />
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="min-w-0 flex-1 truncate font-medium">{projectName(p)}</span>
						</TooltipTrigger>
						<TooltipContent side="right">{p.path}</TooltipContent>
					</Tooltip>
					{!open && (
						<span className="flex shrink-0 items-center gap-1.5">
							{counts.waiting > 0 && <StatusIcon s="waiting" />}
							{counts.running > 0 && <StatusIcon s="running" />}
							{counts.unread > 0 && <StatusIcon s="done" />}
						</span>
					)}
				</SidebarMenuButton>
				<CollapsibleTrigger asChild>
					<SidebarMenuAction aria-label={open ? "收起" : "展开"}>
						<ChevronRight className="transition-transform group-data-[state=open]/collapsible:rotate-90" />
					</SidebarMenuAction>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<SidebarMenuSub className="mr-0 pr-0">
						{shown.map((f) => (
							<div key={f.head.id} className="contents">
								<SessionRow s={f.head} r={row} />
								{f.kids.map((k) => <SessionRow key={k.id} s={k} r={row} kid />)}
							</div>
						))}
						{!q && !all && shown.length < fams.length && (
							<SidebarMenuSubItem>
								<SidebarMenuSubButton asChild className="h-7 w-full text-left text-xs text-muted-foreground">
									<button type="button" onClick={() => setAll(true)}>还有 {fams.length - shown.length} 个</button>
								</SidebarMenuSubButton>
							</SidebarMenuSubItem>
						)}
					</SidebarMenuSub>
				</CollapsibleContent>
			</SidebarMenuItem>
		</Collapsible>
	);
}

/**
 * 手机上横着滑开关侧栏：往右滑打开，往左滑关上。
 * iOS 从屏幕最左边往右滑是「返回上一页」，Safari 里和加到主屏幕的 app 里都有，滑快了系统会抢先：
 * - Safari 里离左边 EDGE 以内起手的不管，留给返回
 * - 主屏幕 app 里没有地址栏、用不着它：这一条里一按下就拦掉，系统就不返回了，从边上滑也能开侧栏。
 *   拦了 touchstart 浏览器就不再发 click，手指没动的点按自己补一个
 * 手指一动就定方向：横着的（而且是要开 / 关的方向）就拦下这次滑动，底下的内容不跟着上下滚；竖着的就放手，照常滚。
 */
const EDGE = 24;
function useSwipe() {
	const { isMobile, openMobile, setOpenMobile } = useSidebar();
	useEffect(() => {
		if (!isMobile) return;
		const standalone = (navigator as { standalone?: boolean }).standalone || matchMedia("(display-mode: standalone)").matches;
		let g: { x: number; y: number; dir: "h" | null; track: boolean; tap: Element | null } | null = null;
		const down = (e: TouchEvent) => {
			g = null;
			if (e.touches.length !== 1) return;
			const t = e.touches[0];
			const edge = t.clientX < EDGE;
			let tap: Element | null = null;
			if (edge && standalone && e.cancelable) {
				e.preventDefault();
				tap = e.target as Element;
			}
			let track = openMobile || standalone || !edge;
			// 在往右滚过的代码、表格上横滑，是在滚它
			if (track && !openMobile) for (let el = e.target as Element | null; el; el = el.parentElement) if (el.scrollLeft > 0) track = false;
			g = { x: t.clientX, y: t.clientY, dir: null, track, tap };
		};
		const move = (e: TouchEvent) => {
			if (!g?.track) return;
			const t = e.touches[0];
			const dx = t.clientX - g.x;
			const dy = t.clientY - g.y;
			if (!g.dir) {
				if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
				// 竖着为主，或者横着但不是要的方向：不管这次了
				if (Math.abs(dy) >= Math.abs(dx) || (dx > 0) === openMobile) return void (g.track = false);
				g.dir = "h";
			}
			if (e.cancelable) e.preventDefault();
		};
		const up = (e: TouchEvent) => {
			if (!g) return;
			const t = e.changedTouches[0];
			const dx = t.clientX - g.x;
			const dy = t.clientY - g.y;
			const { dir, tap } = g;
			g = null;
			if (tap && !dir && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
				(tap.closest("input, textarea, select, [contenteditable]") as HTMLElement | null)?.focus();
				tap.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
			}
			if (dir && Math.abs(dx) >= 50) setOpenMobile(dx > 0);
		};
		const cancel = () => { g = null; };
		document.addEventListener("touchstart", down, { passive: false });
		document.addEventListener("touchmove", move, { passive: false });
		document.addEventListener("touchend", up, { passive: true });
		document.addEventListener("touchcancel", cancel, { passive: true });
		return () => {
			document.removeEventListener("touchstart", down);
			document.removeEventListener("touchmove", move);
			document.removeEventListener("touchend", up);
			document.removeEventListener("touchcancel", cancel);
		};
	}, [isMobile, openMobile, setOpenMobile]);
}

export function AppSidebar({ r, openNew }: { r: Route; openNew: () => void }) {
	useSwipe();
	const { tree, status } = useLive();
	const online = useOnline();
	const { setOpenMobile } = useSidebar();
	const [q, setQ] = useState("");
	const [manual, setManual] = useOpenState();
	const [more, setMore] = useState(false);

	const projects = useMemo(() => {
		if (!tree) return null;
		const needle = q.trim().toLowerCase();
		if (!needle) return tree;
		return tree
			.map((p) => ({ ...p, sessions: p.sessions.filter((s) => `${s.title} ${s.first} ${s.last}`.toLowerCase().includes(needle)) }))
			.filter((p) => p.sessions.length > 0 || projectName(p).toLowerCase().includes(needle));
	}, [tree, q]);

	const live = (p: ProjectTree) => p.sessions.some((s) => { const st = status(s); return st !== null && st !== "terminal"; });
	const isOpen = (p: ProjectTree) => !!q || (manual[p.id] ?? (p.id === r.project || live(p)));
	const shown = !projects ? [] : q || more ? projects : projects.filter((p, i) => i < SHOWN_PROJECTS || p.id === r.project || live(p));

	return (
		<Sidebar>
			<SidebarHeader className="gap-2">
				<div className="flex items-center gap-1 px-1 pt-1">
					<span className="text-[15px] font-semibold tracking-tight">mixer</span>
					{!online && <WifiOff className="ml-1.5 size-3.5 text-destructive" aria-label="连不上服务" />}
					{/* 不用 Tooltip：手机上抽屉一打开焦点落在它上面，提示会自己弹出来 */}
					<Button variant="ghost" size="icon" className="ml-auto size-7" onClick={() => { setOpenMobile(false); openNew(); }} aria-label="新会话" title="新会话">
						<SquarePen className="size-4" />
					</Button>
				</div>
				<div className="relative">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<SidebarInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="找会话" className="pl-8" />
				</div>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupContent>
						<SidebarMenu>
							{!projects && [0, 1, 2, 3, 4].map((i) => <SidebarMenuSkeleton key={i} showIcon />)}
							{shown.map((p) => <ProjectItem key={p.id} p={p} r={r} q={q} open={isOpen(p)} setOpen={(o) => setManual(p.id, o)} />)}
							{projects && !q && !more && shown.length < projects.length && (
								<SidebarMenuItem>
									<SidebarMenuButton className="text-xs text-muted-foreground" onClick={() => setMore(true)}>
										还有 {projects.length - shown.length} 个项目
									</SidebarMenuButton>
								</SidebarMenuItem>
							)}
							{projects?.length === 0 && <p className="px-2 py-4 text-[13px] text-muted-foreground">{q ? "没找到" : "还没有会话"}</p>}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
		</Sidebar>
	);
}
