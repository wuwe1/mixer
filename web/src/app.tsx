// 外框：左边侧栏（项目、会话列表），右边是当前会话的三个页签：对话、文件、改动。
import { Activity, FolderGit2, ListTree, MessageSquare, Search, SquarePen, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
	Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarInset,
	SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, SidebarProvider, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Changes } from "@/components/changes";
import { Conversation } from "@/components/conversation";
import { Files } from "@/components/files";
import { NewSession } from "@/components/new-session";
import { Approvals, RunsSheet, useRuns } from "@/components/runs";
import { api, enc, type Project, type SessionMeta } from "@/lib/api";
import { useEvent, useOnline } from "@/lib/events";
import { go, type Route, useRoute } from "@/lib/route";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";

const short = (p: string | null, id: string) => (p ? p.replace(/^\/Users\/[^/]+/, "~") : id);
const title = (s: SessionMeta) => s.title || s.first || s.id.slice(0, 8);

function useProjects() {
	const [list, setList] = useState<Project[] | null>(null);
	const load = useCallback(() => { api<Project[]>("/api/projects").then(setList, () => setList([])); }, []);
	useEffect(load, [load]);
	// 在新文件夹里开了会话：项目列表里还没有它，重新拉
	useEvent("session", useCallback((e: { project: string }) => { if (list && !list.some((p) => p.id === e.project)) load(); }, [list, load]));
	return list;
}

function useSessions(project: string | null) {
	const [list, setList] = useState<SessionMeta[] | null>(null);
	const load = useCallback(() => { if (project) api<SessionMeta[]>(`/api/projects/${enc(project)}/sessions`).then(setList, () => setList([])); }, [project]);
	useEffect(() => { setList(null); load(); }, [load]);
	useEvent("session", useCallback((e: { project: string }) => { if (e.project === project) load(); }, [project, load]));
	return list;
}

function SessionLink({ s, r }: { s: SessionMeta; r: Route }) {
	const { setOpenMobile } = useSidebar();
	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				isActive={r.session === s.id}
				onClick={() => { go({ session: s.id, tab: "chat", leaf: null, file: null }); setOpenMobile(false); }}
				className="h-auto flex-col items-start gap-0.5 py-2"
			>
				<span className="flex w-full items-center gap-1.5">
					{s.active && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />}
					<span className="truncate font-medium">{title(s)}</span>
				</span>
				<span className="w-full truncate text-[11px] text-muted-foreground">
					{ago(s.mtime)} · {s.prompts} 问{s.branch ? ` · ${s.branch}` : ""}
				</span>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

function NewButton({ openNew }: { openNew: () => void }) {
	const { setOpenMobile } = useSidebar();
	return (
		<Button variant="ghost" size="icon" className="size-7" onClick={() => { setOpenMobile(false); openNew(); }} aria-label="新会话">
			<SquarePen className="size-4" />
		</Button>
	);
}

function Side({ r, projects, runs, openRuns, openNew }: { r: Route; projects: Project[] | null; runs: number; openRuns: () => void; openNew: () => void }) {
	const sessions = useSessions(r.project);
	const [q, setQ] = useState("");
	const cur = projects?.find((p) => p.id === r.project);
	const shown = (sessions ?? []).filter((s) => !q || `${s.title} ${s.first} ${s.last}`.toLowerCase().includes(q.toLowerCase()));
	return (
		<Sidebar>
			<SidebarHeader className="gap-2">
				<div className="flex items-center gap-2 px-1 pt-1">
					<span className="text-[15px] font-semibold tracking-tight">mixer</span>
					<Button variant="ghost" size="sm" className="ml-auto h-7 gap-1.5 px-2 text-xs" onClick={openRuns}>
						<Activity className="size-3.5" />
						运行
						{runs > 0 && <Badge className="h-4 min-w-4 px-1 text-[10px]">{runs}</Badge>}
					</Button>
					<NewButton openNew={openNew} />
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="outline" className="h-9 justify-start gap-2 px-2.5 text-left">
							<FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
							<span className="truncate text-[13px]">{cur ? short(cur.path, cur.id) : "选一个项目"}</span>
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="max-h-[70vh] w-72 overflow-auto">
						<DropdownMenuLabel>项目</DropdownMenuLabel>
						<DropdownMenuSeparator />
						{projects?.map((p) => (
							<DropdownMenuItem key={p.id} onClick={() => go({ project: p.id, session: null, leaf: null, file: null, tab: "chat" })} className="flex-col items-start gap-0">
								<span className="truncate text-[13px]">{short(p.path, p.id)}</span>
								<span className="text-[11px] text-muted-foreground">{p.sessions} 个会话 · {ago(p.mtime)}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
				{r.project && (
					<div className="relative">
						<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<SidebarInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="找会话" className="pl-8" />
					</div>
				)}
			</SidebarHeader>
			<SidebarContent>
				{r.project && (
					<SidebarGroup>
						<SidebarGroupLabel>会话</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{!sessions && [0, 1, 2, 3].map((i) => <SidebarMenuSkeleton key={i} />)}
								{shown.map((s) => <SessionLink key={s.id} s={s} r={r} />)}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				)}
			</SidebarContent>
			<SidebarFooter className="px-3 pb-3 text-[11px] text-muted-foreground">{cur?.path}</SidebarFooter>
		</Sidebar>
	);
}

export function App() {
	const r = useRoute();
	const projects = useProjects();
	const runs = useRuns();
	const online = useOnline();
	const [runsOpen, setRunsOpen] = useState(false);
	const [outline, setOutline] = useState(false);
	const [newOpen, setNewOpen] = useState(false);
	const sessions = useSessions(r.project);
	const cur = useMemo(() => sessions?.find((s) => s.id === r.session), [sessions, r.session]);
	const running = runs.filter((x) => x.status === "running").length;

	// 打开就有东西看：没选项目，选最近的那个
	useEffect(() => { if (!r.project && projects?.length) go({ project: projects[0].id }, true); }, [r.project, projects]);
	useEffect(() => { document.title = cur ? `${title(cur)} · mixer` : "mixer"; }, [cur]);

	return (
		<SidebarProvider className="h-svh">
			<Side r={r} projects={projects} runs={running} openRuns={() => setRunsOpen(true)} openNew={() => setNewOpen(true)} />
			<SidebarInset className="min-w-0 overflow-hidden">
				<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
					<SidebarTrigger className="-ml-1" />
					<Separator orientation="vertical" className="mr-1 h-4" />
					<span className="min-w-0 flex-1 truncate text-sm font-medium">{cur ? title(cur) : r.session ? r.session.slice(0, 8) : "选一个会话"}</span>
					{!online && <WifiOff className="size-4 text-destructive" />}
					{r.session && (
						<Tabs value={r.tab} onValueChange={(v) => go({ tab: v as Route["tab"] })}>
							<TabsList className="h-8">
								<TabsTrigger value="chat" className="px-2.5 text-xs">对话</TabsTrigger>
								<TabsTrigger value="files" className="px-2.5 text-xs">文件</TabsTrigger>
								<TabsTrigger value="changes" className="px-2.5 text-xs">改动</TabsTrigger>
							</TabsList>
						</Tabs>
					)}
					{r.session && r.tab === "chat" && (
						<Button variant="ghost" size="icon" className="size-8 xl:hidden" onClick={() => setOutline(true)} aria-label="问题目录">
							<ListTree className="size-4" />
						</Button>
					)}
				</header>
				<div className={cn("flex min-h-0 flex-1 flex-col")}>
					{!r.project || !r.session ? (
						<Empty className="m-auto">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<MessageSquare />
								</EmptyMedia>
								<EmptyTitle>选一个会话</EmptyTitle>
								<EmptyDescription>左边列着这个项目在 Claude Code 里的所有会话，按最近活动排。也可以在任意文件夹开一个新的。</EmptyDescription>
							</EmptyHeader>
							<Button variant="outline" size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}>
								<SquarePen className="size-3.5" />
								新会话
							</Button>
						</Empty>
					) : r.tab === "files" ? (
						<Files project={r.project} file={r.file} />
					) : r.tab === "changes" ? (
						<Changes project={r.project} />
					) : (
						<Conversation project={r.project} session={r.session} leaf={r.leaf} outlineOpen={outline} setOutlineOpen={setOutline} />
					)}
				</div>
			</SidebarInset>
			<NewSession open={newOpen} onOpenChange={setNewOpen} projects={projects ?? []} />
			<RunsSheet open={runsOpen} onOpenChange={setRunsOpen} runs={runs} />
			<Approvals runs={runs} />
		</SidebarProvider>
	);
}
