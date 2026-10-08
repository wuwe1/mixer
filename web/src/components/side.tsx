// 侧栏是工作区：只放人放进来的文件夹和会话（一开始是空的；新会话、分叉、在 mixer 里跑过的自动放进来，别的从「浏览会话」里挑）。
// 文件夹按人拖的顺序，新放进来的在最上面；文件夹里的会话按时间排，新的在上面，分叉出来的挂在原会话下面。
// 每个会话右边一个状态：待确认、运行中、已完成未读、出错未读、终端中打开。文件夹默认展开，收起来的记在这台设备上。
// 长按（手机）、右键（电脑）一行出菜单：会话能移出工作区、删除（问一句，删了能找回）；文件夹能连同里面的会话移出。移出的都能撤销。
import { closestCenter, DndContext, type DragEndEvent, type Modifier, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Folder, GitFork, GripVertical, Library, MoreHorizontal, SquarePen, WifiOff, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
	Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuAction,
	SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, enc, type Group, type SessionMeta, sessionTitle } from "@shared/api";
import { useOnline } from "@/lib/events";
import { type Status, useLive } from "@/lib/live";
import { openProject, openSession, type Route } from "@/lib/route";
import { since } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Browse } from "./lazy";
import { Chevron, Placeholder } from "./placeholder";
import { UsageFooter } from "./usage";

/** ok / failed 是一步工具调用跑完了：成功、失败 */
type Mark = Status | "ok" | "failed";
const STATUS_LABEL: Record<Exclude<Mark, null>, string> = { waiting: "待确认", running: "运行中", background: "后台任务在跑", done: "已完成，未读", error: "出错，未读", terminal: "终端中打开", ok: "成功", failed: "失败" };

/**
 * 状态标记，全站一套：点 = 要你注意（琥珀待确认，带一圈扩散；蓝已完成未读；红出错未读）；带扩散的蓝点 = 运行中；
 * 带扩散的蓝色空心圈 = 后台任务在跑（Claude 闲着，跑完了会叫醒它）；灰色空心圈 = 终端中打开。
 * 一步工具调用跑完了：绿点成功、红点失败。
 * 颜色只有这几种意思：琥珀要你确认，红出错，蓝没看过，绿这一步成功了，灰中性
 */
export function StatusIcon({ s, className }: { s: Mark; className?: string }) {
	const icon =
		s === "waiting" ? <Ping dot="bg-waiting" />
		: s === "running" ? <Ping dot="bg-unread" />
		: s === "background" ? <Ping dot="border border-unread" />
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
/** 带一圈扩散的点：dot 是点的样子（实心的底色，或者空心的边框），扩散的那圈照它画 */
function Ping({ dot }: { dot: string }) {
	return (
		<span className="relative flex size-2">
			<span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", dot)} />
			<span className={cn("relative size-2 rounded-full", dot)} />
		</span>
	);
}

export const statusLabel = (s: Status) => (s ? STATUS_LABEL[s] : null);

export const projectName = (p: { path: string | null; id: string }) => p.path?.split("/").pop() || p.id;

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
/**
 * 分叉的一家：原会话在前、分叉出来的挂在下面；一家按最近的修改时间排，新的在上面。
 * parent 是直接分叉自的那个（分叉的分叉指向中间那个；只有终端里 --fork-session 出来、靠猜的 Claude 会话指向一家最早的那个）：
 * 顺着 parent 往上走到这些会话里最上面的那个，挂在它下面
 */
export function families(sessions: SessionMeta[]): Family[] {
	const byId = new Map(sessions.map((s) => [s.id, s]));
	// parent 绕成圈的（不该有）：自己单独成一家
	const top = (s: SessionMeta) => {
		const seen = new Set([s.id]);
		let t = s;
		for (let p = t.parent ? byId.get(t.parent) : undefined; p; p = t.parent ? byId.get(t.parent) : undefined) {
			if (seen.has(p.id)) return s;
			seen.add(p.id);
			t = p;
		}
		return t;
	};
	const map = new Map<string, Family>();
	const kids: [string, SessionMeta][] = [];
	for (const s of sessions) {
		const t = top(s);
		if (t === s) map.set(s.id, { head: s, kids: [], latest: s.mtime });
		else kids.push([t.id, s]);
	}
	for (const [t, s] of kids) {
		const f = map.get(t);
		if (!f) continue;
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
 * 长按出菜单松手时，有的浏览器还会补一个点按（主屏幕 app 里从边上起手的，lib/drawer 的 guardEdges 也会补）：菜单开着时的点按不算。
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
							{/* 右边：时间，最右一格是状态标记（每行都留着这一格，时间才对得齐）。正在发生的（运行中、待确认、后台任务）时间总是「刚刚」，不写；终端中打开可能闲着好几天，照写。
							    Claude Code 7 天内要清理的，时间换成「N 天后清理」 */}
							<span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground tabular-nums">
								<span className="md:group-hover/row:invisible" title={exp?.title}>{(!st || st === "done" || st === "error" || st === "terminal") && (exp?.text ?? since(s.mtime))}</span>
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

/** 删掉一个会话：先问一句，说清楚会怎样、怎么找回（挪进废纸篓）。删的正开着就回到项目页 */
function DeleteSession({ doomed, r, onClose }: { doomed: Doomed | null; r: Route; onClose: () => void }) {
	const [deleting, setDeleting] = useState(false);
	// 关上的动画里还显示刚才那个
	const last = useRef(doomed);
	if (doomed) last.current = doomed;
	const shown = last.current;
	const remove = async () => {
		if (!doomed) return;
		setDeleting(true);
		try {
			await api(`/api/sessions/${enc(doomed.project)}/${enc(doomed.s.id)}/delete`, {});
			toast("已删除");
			if (r.session === doomed.s.id) openProject(doomed.project);
			onClose();
		} catch (e) {
			// 在跑、排队、待确认、终端里开着：服务端说明原因（409）
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			setDeleting(false);
		}
	};
	return (
		<AlertDialog open={!!doomed} onOpenChange={(o) => { if (!o && !deleting) onClose(); }}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>删除会话？</AlertDialogTitle>
					<AlertDialogDescription>
						<span className="block font-medium break-all text-foreground">{shown && sessionTitle(shown.s)}</span>
						从 Claude Code 的历史里也会消失（终端里 claude --resume 看不到），记录移到废纸篓，从那里能找回。
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
					{/* 等删完再关：别让它自己关上 */}
					<AlertDialogAction variant="destructive" disabled={deleting} onClick={(e) => { e.preventDefault(); remove(); }}>
						{deleting && <Spinner />}删除
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
	// 有事的一家（待确认、在跑、后台任务、跑完没看）：不在前 SHOWN 个里也露出来；只是终端里开着的不算
	const notable = (f: Family) => [f.head, ...f.kids].some((s) => status(s) && status(s) !== "terminal");
	const shown = all ? fams : fams.filter((f, i) => i < SHOWN || notable(f) || [f.head, ...f.kids].some((s) => s.id === r.session));
	const counts = useMemo(() => {
		const c = { waiting: 0, running: 0, background: 0, done: 0, error: 0 };
		for (const s of g.sessions) {
			const st = status(s);
			if (st === "waiting" || st === "running" || st === "background" || st === "done" || st === "error") c[st]++;
		}
		return c;
	}, [g.sessions, status]);
	return (
		<div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && "relative z-10 rounded-md bg-sidebar opacity-90 shadow-md")}>
			<Collapsible open={open} onOpenChange={setOpen}>
				<SidebarMenuItem>
					{/* 菜单只挂在文件夹这一行上：挂在整个 item 上，长按里面的会话两个菜单都会开 */}
					<ContextMenu onOpenChange={menu.onOpenChange}>
						<ContextMenuTrigger asChild>
							<SidebarMenuButton isActive={r.project === g.id && !r.session} onClick={() => { if (menu.open.current) return; openProject(g.id); setOpen(true); setOpenMobile(false); }} className="h-11 gap-2 pr-14 md:h-8">
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
										{(["waiting", "running", "background", "error", "done"] as const).map((k) => counts[k] > 0 && <StatusIcon key={k} s={k} />)}
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
							<Chevron open={open} className="text-current" />
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
									<SidebarMenuSubButton asChild className="h-11 w-full text-left text-xs text-muted-foreground md:h-8">
										<button type="button" onClick={() => setAll(true)}>还有 {fams.length - shown.length} 个</button>
									</SidebarMenuSubButton>
								</SidebarMenuSubItem>
							)}
							{fams.length === 0 && <Placeholder text="还没有会话：点文件夹开一个" className="px-2 py-3" />}
						</SidebarMenuSub>
					</CollapsibleContent>
				</SidebarMenuItem>
			</Collapsible>
		</div>
	);
}

/** 拖动只上下走 */
const vertical: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export function AppSidebar({ r, openNew }: { r: Route; openNew: () => void }) {
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
							<Placeholder title="工作区是空的" text="选一个文件夹开新会话，或者把已有的会话放进来" className="px-2 py-10">
								<div className="flex justify-center gap-2">
									<Button variant="outline" size="sm" className="gap-1.5" onClick={startNew}><SquarePen className="size-3.5" />新会话</Button>
									<Button variant="outline" size="sm" className="gap-1.5" onClick={() => setBrowse(true)}><Library className="size-3.5" />浏览会话</Button>
								</div>
							</Placeholder>
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
