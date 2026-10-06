// 侧栏是工作区：只放人放进来的文件夹和会话（一开始是空的；新会话、分叉、在 mixer 里跑过的自动放进来，别的从「浏览会话」里挑）。
// 文件夹按人拖的顺序，新放进来的在最上面；文件夹里的会话按时间排，新的在上面，分叉出来的挂在原会话下面。
// 每个会话右边一个状态：待确认、运行中、已完成未读、出错未读、终端中打开。文件夹默认展开，收起来的记在这台设备上。
// 长按（手机）、右键（电脑）一行出菜单：会话能移出工作区、删除（问一句，删了能找回）；文件夹能连同里面的会话移出。移出的都能撤销。
import { closestCenter, DndContext, type DragEndEvent, type Modifier, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, Folder, GitFork, GripVertical, Library, MoreHorizontal, SquarePen, WifiOff, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
	Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuAction,
	SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, enc, type Group, type SessionMeta } from "@/lib/api";
import { useOnline } from "@/lib/events";
import { type Status, useLive } from "@/lib/live";
import { go, openSession, type Route } from "@/lib/route";
import { since } from "@/lib/time";
import * as drawer from "@/lib/drawer";
import { cn } from "@/lib/utils";
import { Browse } from "./lazy";
import { UsageFooter } from "./usage";

/** ok / failed 是一步工具调用跑完了：成功、失败 */
type Mark = Status | "ok" | "failed";
const STATUS_LABEL: Record<Exclude<Mark, null>, string> = { waiting: "待确认", running: "运行中", done: "已完成，未读", error: "出错，未读", terminal: "终端中打开", ok: "成功", failed: "失败" };

/**
 * 状态标记，全站一套：点 = 要你注意（琥珀待确认，带一圈扩散；蓝已完成未读；红出错未读）；转圈 = 运行中；灰色空心圈 = 终端中打开。
 * 一步工具调用跑完了：绿点成功、红点失败。
 * 颜色只有这几种意思：琥珀要你确认，红出错，蓝没看过，绿这一步成功了，灰中性
 */
export function StatusIcon({ s, className }: { s: Mark; className?: string }) {
	const icon =
		s === "waiting" ? (
			<span className="relative flex size-2">
				<span className="absolute inset-0 animate-ping rounded-full bg-waiting opacity-60" />
				<span className="relative size-2 rounded-full bg-waiting" />
			</span>
		)
		: s === "running" ? (
			<span className="relative flex size-2">
				<span className="absolute inset-0 animate-ping rounded-full bg-unread opacity-60" />
				<span className="relative size-2 rounded-full bg-unread" />
			</span>
		)
		: s === "done" ? <span className="size-2 rounded-full bg-unread" />
		: s === "error" || s === "failed" ? <span className="size-2 rounded-full bg-destructive" />
		: s === "ok" ? <span className="size-2 rounded-full bg-success" />
		: s === "terminal" ? <span className="size-2 rounded-full border border-muted-foreground" />
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
/** 分叉的一家：原会话在前、分叉出来的挂在下面；一家按最近的修改时间排，新的在上面 */
export function families(sessions: SessionMeta[]): Family[] {
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
const DAY = 86_400_000;

/** Claude Code 7 天内要清理的（它启动时删掉 cleanupPeriodDays 天没动的）：还剩几天，和 cleanupPeriodDays 是几天 */
function expiry(s: SessionMeta) {
	if (!s.expires) return null;
	const at = Date.parse(s.expires);
	const left = Math.floor((at - Date.now()) / DAY);
	if (left >= 7) return null;
	return { text: left <= 0 ? "今天清理" : `${left} 天后清理`, title: `Claude Code 会删掉 ${Math.round((at - Date.parse(s.mtime)) / DAY)} 天没动的会话（cleanupPeriodDays）` };
}

/** 要删的会话（菜单里点了「删除…」，等确认） */
type Doomed = { project: string; s: SessionMeta };

/**
 * 长按（手机）、右键（电脑）出菜单：Radix 的 ContextMenuTrigger 自带 -webkit-touch-callout: none，shadcn 那层加了 select-none，iOS 上长按不选字、不弹系统菜单。
 * 长按出菜单松手时，有的浏览器还会补一个点按（主屏幕 app 里从左边起手的，useSwipe 也会补）：菜单开着时的点按不算。
 * 菜单开着时 onOpenChange 记下
 */
function useMenuOpen() {
	const open = useRef(false);
	return { open, onOpenChange: (o: boolean) => { open.current = o; } };
}

function SessionRow({ s, r, project, kid, onDelete }: { s: SessionMeta; r: Route; project: string; kid?: boolean; onDelete: (d: Doomed) => void }) {
	const { status, change } = useLive();
	const { setOpenMobile } = useSidebar();
	const menu = useMenuOpen();
	const st = status(s);
	const exp = expiry(s);
	return (
		<ContextMenu onOpenChange={menu.onOpenChange}>
			<ContextMenuTrigger asChild>
				<SidebarMenuSubItem className="group/row relative">
					<SidebarMenuSubButton asChild isActive={r.session === s.id} className={cn("h-11 w-full gap-1.5 text-left md:h-8", kid && "pl-5")}>
						<button type="button" onClick={() => { if (menu.open.current) return; openSession(project, s.id); setOpenMobile(false); }}>
							{kid && <GitFork className="size-3! text-muted-foreground" />}
							<span className={cn("min-w-0 flex-1 truncate text-md", st === "done" || st === "error" || st === "waiting" ? "font-medium" : "")}>{sessionTitle(s)}</span>
							{s.agent === "codex" && <span className="shrink-0 text-2xs text-muted-foreground">Codex</span>}
							{/* 右边：时间，最右一格是状态标记（每行都留着这一格，时间才对得齐）。正在发生的（运行中、待确认、终端中打开）时间总是「刚刚」，不写。
							    Claude Code 7 天内要清理的，时间换成「N 天后清理」 */}
							<span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground tabular-nums">
								<span className="md:group-hover/row:invisible" title={exp?.title}>{(!st || st === "done" || st === "error") && (exp?.text ?? since(s.mtime))}</span>
								<StatusIcon s={st} />
							</span>
						</button>
					</SidebarMenuSubButton>
					{/* 电脑上指着这一行时，时间那里换成「移出工作区」；手机上长按出菜单，或在会话顶栏里移 */}
					<Button variant="ghost" size="icon-xs" className="absolute top-1/2 right-5 hidden -translate-y-1/2 text-muted-foreground md:group-hover/row:flex" onClick={() => change({ op: "remove", project, session: s.id })} aria-label="移出工作区" title="移出工作区">
						<X className="size-3.5" />
					</Button>
				</SidebarMenuSubItem>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onSelect={() => change({ op: "remove", project, session: s.id })}>移出工作区</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem variant="destructive" onSelect={() => onDelete({ project, s })}>删除…</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

/** 删掉一个会话：先问一句，说清楚会怎样、怎么找回（Claude 的挪进废纸篓，Codex 的 codex archive）。删的正开着就回到项目页 */
function DeleteSession({ doomed, r, onClose }: { doomed: Doomed | null; r: Route; onClose: () => void }) {
	const [busy, setBusy] = useState(false);
	// 关上的动画里还显示刚才那个
	const last = useRef(doomed);
	if (doomed) last.current = doomed;
	const shown = last.current;
	const remove = async () => {
		if (!doomed) return;
		setBusy(true);
		try {
			await api(`/api/sessions/${enc(doomed.project)}/${enc(doomed.s.id)}/delete`, {});
			toast.success("已删除");
			if (r.session === doomed.s.id) go({ project: doomed.project, session: null, leaf: null });
			onClose();
		} catch (e) {
			// 在跑、排队、待确认、终端里开着：服务端说明原因（409）
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<AlertDialog open={!!doomed} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>删除会话？</AlertDialogTitle>
					<AlertDialogDescription>
						<span className="block font-medium break-all text-foreground">{shown && sessionTitle(shown.s)}</span>
						{shown?.s.agent === "codex" ? "用 codex archive 归档，Codex 里看不到，codex unarchive 能恢复。" : "从 Claude Code 的历史里也会消失（终端里 claude --resume 看不到），记录移到废纸篓，从那里能找回。"}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
					{/* 等删完再关：别让它自己关上 */}
					<AlertDialogAction variant="destructive" disabled={busy} onClick={(e) => { e.preventDefault(); remove(); }}>
						{busy && <Spinner />}删除
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** 文件夹那一行手机上高 44px（好按），右边两个按钮跟着往下挪到中间 */
const ACTION = "peer-data-[size=default]/menu-button:top-3 md:peer-data-[size=default]/menu-button:top-1.5";

/** 工作区里的一个文件夹：按住文件夹图标拖动排序（电脑上指着时变成把手）；里面的会话按时间排，新的在上面 */
function GroupItem({ g, r, open, setOpen, onDelete }: { g: Group; r: Route; open: boolean; setOpen: (o: boolean) => void; onDelete: (d: Doomed) => void }) {
	const { status, change } = useLive();
	const { setOpenMobile } = useSidebar();
	const menu = useMenuOpen();
	const [all, setAll] = useState(false);
	const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: g.id });
	const fams = useMemo(() => families(g.sessions), [g.sessions]);
	const busy = (f: Family) => [f.head, ...f.kids].some((s) => status(s) && status(s) !== "terminal");
	const shown = all ? fams : fams.filter((f, i) => i < SHOWN || busy(f) || [f.head, ...f.kids].some((s) => s.id === r.session));
	const counts = useMemo(() => {
		const c = { waiting: 0, running: 0, done: 0, error: 0 };
		for (const s of g.sessions) {
			const st = status(s);
			if (st === "waiting" || st === "running" || st === "done" || st === "error") c[st]++;
		}
		return c;
	}, [g.sessions, status]);
	return (
		<div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && "relative z-10 rounded-md bg-sidebar opacity-90 shadow-md")}>
			<Collapsible open={open} onOpenChange={setOpen} className="group/collapsible">
				<SidebarMenuItem>
					{/* 菜单只挂在文件夹这一行上：挂在整个 item 上，长按里面的会话两个菜单都会开 */}
					<ContextMenu onOpenChange={menu.onOpenChange}>
						<ContextMenuTrigger asChild>
							<SidebarMenuButton isActive={r.project === g.id && !r.session} onClick={() => { if (menu.open.current) return; go({ project: g.id, session: null, leaf: null }); setOpen(true); setOpenMobile(false); }} className="h-11 gap-2 pr-14 md:h-8">
								<span ref={setActivatorNodeRef} {...listeners} className="-m-1 flex cursor-grab touch-none p-1 active:cursor-grabbing" aria-label="拖动排序">
									<Folder className="size-4 text-muted-foreground md:group-hover/menu-item:hidden" />
									<GripVertical className="hidden size-4 text-muted-foreground md:group-hover/menu-item:block" />
								</span>
								<Tooltip>
									<TooltipTrigger asChild>
										<span className="min-w-0 flex-1 truncate font-medium">{projectName(g)}</span>
									</TooltipTrigger>
									<TooltipContent side="right">{g.path}</TooltipContent>
								</Tooltip>
								{!open && (
									<span className="flex shrink-0 items-center gap-0.5">
										{(["waiting", "running", "error", "done"] as const).map((k) => counts[k] > 0 && <StatusIcon key={k} s={k} />)}
									</span>
								)}
							</SidebarMenuButton>
						</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuItem onSelect={() => change({ op: "remove", project: g.id })}>移出工作区（连同里面的会话）</ContextMenuItem>
						</ContextMenuContent>
					</ContextMenu>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<SidebarMenuAction showOnHover className={cn("right-7", ACTION)} aria-label="更多">
								<MoreHorizontal />
							</SidebarMenuAction>
						</DropdownMenuTrigger>
						<DropdownMenuContent side="right" align="start">
							<DropdownMenuItem onClick={() => change({ op: "remove", project: g.id })}>移出工作区（连同里面的会话）</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<CollapsibleTrigger asChild>
						<SidebarMenuAction className={ACTION} aria-label={open ? "收起" : "展开"}>
							<ChevronRight className="transition-transform group-data-[state=open]/collapsible:rotate-90" />
						</SidebarMenuAction>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<SidebarMenuSub className="mr-0 pr-0">
							{shown.map((f) => (
								<div key={f.head.id} className="contents">
									<SessionRow s={f.head} r={r} project={g.id} onDelete={onDelete} />
									{f.kids.map((k) => <SessionRow key={k.id} s={k} r={r} project={g.id} kid onDelete={onDelete} />)}
								</div>
							))}
							{!all && shown.length < fams.length && (
								<SidebarMenuSubItem>
									<SidebarMenuSubButton asChild className="h-7 w-full text-left text-xs text-muted-foreground">
										<button type="button" onClick={() => setAll(true)}>还有 {fams.length - shown.length} 个</button>
									</SidebarMenuSubButton>
								</SidebarMenuSubItem>
							)}
							{fams.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">还没有会话：点文件夹开一个</p>}
						</SidebarMenuSub>
					</CollapsibleContent>
				</SidebarMenuItem>
			</Collapsible>
		</div>
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
/** 松手时速度超过它（px/ms）就算甩：按甩的方向开或关 */
const FLING = 0.5;
function useSwipe() {
	const { isMobile, openMobile, setOpenMobile } = useSidebar();
	useEffect(() => {
		if (!isMobile) return;
		const standalone = (navigator as { standalone?: boolean }).standalone || matchMedia("(display-mode: standalone)").matches;
		// from：按下时抽屉开到哪（动画途中按住的，停在看到的位置）；pts：最近的手指位置，松手时算速度
		let g: { x: number; y: number; dir: "h" | null; track: boolean; tap: Element | null; from: number; w: number; pts: [number, number][] } | null = null;
		/** 没拖成（竖着滑、反方向、取消）：按下时停住的动画接着走完 */
		const settle = () => drawer.to(openMobile ? 1 : 0);
		const down = (e: TouchEvent) => {
			g = null;
			if (e.touches.length !== 1) return;
			// 开着别的对话框（看大图、分叉、浏览会话、用量）时不管：侧栏自己开着时也是 role="dialog"，要除掉；长按出来的菜单、要确认的对话框开着时也不管
			if (document.querySelector('[role="dialog"]:not([data-mobile]), [role="menu"], [role="alertdialog"]')) return;
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
			g = { x: t.clientX, y: t.clientY, dir: null, track, tap, from: track ? drawer.grab() : 0, w: drawer.width(), pts: [[e.timeStamp, t.clientX]] };
		};
		const move = (e: TouchEvent) => {
			if (!g?.track) return;
			const t = e.touches[0];
			const dx = t.clientX - g.x;
			const dy = t.clientY - g.y;
			if (!g.dir) {
				// 按住不动到菜单出来（长按）再挪手指：是在菜单上，不是开关侧栏
				if (document.querySelector('[role="menu"]')) {
					g.track = false;
					return settle();
				}
				if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
				// 竖着为主，或者横着但不是要的方向：不管这次了
				if (Math.abs(dy) >= Math.abs(dx) || (dx > 0) === openMobile) {
					g.track = false;
					return settle();
				}
				g.dir = "h";
			}
			if (e.cancelable) e.preventDefault();
			// 跟手：抽屉的边贴着手指走
			drawer.drag(g.from + dx / g.w);
			g.pts.push([e.timeStamp, t.clientX]);
			if (g.pts.length > 8) g.pts.shift();
		};
		const up = (e: TouchEvent) => {
			if (!g) return;
			const t = e.changedTouches[0];
			const dx = t.clientX - g.x;
			const dy = t.clientY - g.y;
			const { dir, tap, track, from, w, pts } = g;
			g = null;
			if (tap && !dir && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
				(tap.closest("input, textarea, select, [contenteditable]") as HTMLElement | null)?.focus();
				tap.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
			}
			if (dir) {
				// 甩得够快就按甩的方向，不然看拉开了没有一半
				const [t0, x0] = pts.find(([at]) => e.timeStamp - at <= 100) ?? pts[pts.length - 1];
				const v = e.timeStamp > t0 ? (t.clientX - x0) / (e.timeStamp - t0) : 0;
				const open = v > FLING ? true : v < -FLING ? false : from + dx / w > 0.5;
				drawer.to(open ? 1 : 0);
				if (open !== openMobile) setOpenMobile(open);
			} else if (track) settle();
		};
		const cancel = () => {
			if (g?.track) settle();
			g = null;
		};
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

/** 拖动只上下走 */
const vertical: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export function AppSidebar({ r, openNew }: { r: Route; openNew: () => void }) {
	useSwipe();
	const { workspace, change } = useLive();
	const online = useOnline();
	const { setOpenMobile } = useSidebar();
	const [manual, setManual] = useOpenState();
	const [browse, setBrowse] = useState(false);
	const [doomed, setDoomed] = useState<Doomed | null>(null);
	// 动了 6px 才算拖：点文件夹图标还是打开项目
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
	const ids = useMemo(() => (workspace ?? []).map((g) => g.id), [workspace]);
	const dropped = (e: DragEndEvent) => {
		if (!e.over || e.active.id === e.over.id) return;
		change({ op: "order", order: arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))) });
	};
	const startNew = () => { setOpenMobile(false); openNew(); };

	return (
		<Sidebar>
			<SidebarHeader className="gap-2">
				<div className="flex items-center gap-1 px-1 pt-1">
					<span className="text-lg font-semibold tracking-tight">mixer</span>
					{!online && <WifiOff className="ml-1.5 size-3.5 text-destructive" aria-label="无法连接服务" />}
					{/* 不用 Tooltip：手机上抽屉一打开焦点落在它上面，提示会自己弹出来 */}
					<Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => setBrowse(true)} aria-label="浏览会话" title="浏览会话">
						<Library className="size-4" />
					</Button>
					<Button variant="ghost" size="icon-sm" onClick={startNew} aria-label="新会话" title="新会话">
						<SquarePen className="size-4" />
					</Button>
				</div>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupContent>
						<SidebarMenu>
							{!workspace && [0, 1, 2, 3, 4].map((i) => <SidebarMenuSkeleton key={i} showIcon />)}
							<DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[vertical]} onDragEnd={dropped}>
								<SortableContext items={ids} strategy={verticalListSortingStrategy}>
									{workspace?.map((g) => <GroupItem key={g.id} g={g} r={r} open={manual[g.id] ?? true} setOpen={(o) => setManual(g.id, o)} onDelete={setDoomed} />)}
								</SortableContext>
							</DndContext>
						</SidebarMenu>
						{workspace?.length === 0 && (
							<Empty className="px-2 py-10">
								<EmptyHeader>
									<EmptyTitle className="text-sm">工作区是空的</EmptyTitle>
									<EmptyDescription className="text-xs">选一个文件夹开新会话，或者把已有的会话放进来</EmptyDescription>
								</EmptyHeader>
								<EmptyContent className="flex-row justify-center gap-2">
									<Button variant="outline" size="sm" className="gap-1.5" onClick={startNew}><SquarePen className="size-3.5" />新会话</Button>
									<Button variant="outline" size="sm" className="gap-1.5" onClick={() => setBrowse(true)}><Library className="size-3.5" />浏览会话</Button>
								</EmptyContent>
							</Empty>
						)}
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
			<UsageFooter />
			<Browse open={browse} onOpenChange={setBrowse} />
			<DeleteSession doomed={doomed} r={r} onClose={() => setDoomed(null)} />
		</Sidebar>
	);
}
