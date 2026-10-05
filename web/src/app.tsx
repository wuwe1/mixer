// 外框：左边侧栏（项目 → 会话，带状态）；右边是当前的页面：会话、项目页（开新会话、看文件和改动），或者什么都没选。
// 开 agent 只有两种办法：选一个文件夹开新会话（侧栏的新会话、项目页的输入框），或者从一个会话分叉。
import { ChevronRight, FolderTree, GitCompareArrows, GitFork, ListTree, MessageSquare, Pin, PinOff, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FloatingApprovals } from "@/components/approvals";
import { NewSession, ProjectHome } from "@/components/lazy";
import { PANELS, panelOf, SessionView } from "@/components/session";
import { AppSidebar, projectName, sessionTitle, StatusIcon, statusLabel } from "@/components/side";
import { useLive } from "@/lib/live";
import { go, openSession, type Panel, type Route, useRoute, useWide } from "@/lib/route";

const PANEL_ICON: Record<Panel, typeof ListTree> = { outline: ListTree, files: FolderTree, changes: GitCompareArrows };

export function App() {
	const r = useRoute();
	const { workspace, status, inWorkspace, change } = useLive();
	const wide = useWide();
	const [newOpen, setNewOpen] = useState(false);
	const p = workspace?.find((x) => x.id === r.project);
	const meta = p?.sessions.find((s) => s.id === r.session);
	const st = meta ? status(meta) : null;
	const parent = meta?.parent ? p?.sessions.find((s) => s.id === meta.parent) : undefined;
	const title = meta ? sessionTitle(meta) : r.session ? r.session.slice(0, 8) : p ? projectName(p) : "mixer";

	useEffect(() => { document.title = r.project ? `${title} · mixer` : "mixer"; }, [title, r.project]);

	return (
		<SidebarProvider className="h-svh">
			<AppSidebar r={r} openNew={() => setNewOpen(true)} />
			<SidebarInset className="min-w-0 overflow-hidden">
				<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
					<SidebarTrigger className="-ml-1" />
					<Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
					<div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
						{p && r.session && (
							<>
								<button type="button" onClick={() => go({ session: null, leaf: null, panel: null, file: null, view: null })} className="hidden shrink-0 text-muted-foreground hover:text-foreground sm:inline">
									{projectName(p)}
								</button>
								<ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground sm:block" />
							</>
						)}
						{st && <StatusIcon s={st} />}
						<span className="truncate font-medium">{title}</span>
						{st && <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">{statusLabel(st)}</span>}
						{p && parent && (
							<button type="button" onClick={() => openSession(p.id, parent.id)} className="hidden min-w-0 shrink items-center gap-1 text-xs text-muted-foreground hover:text-foreground lg:flex">
								<GitFork className="size-3 shrink-0" />
								<span className="truncate">分叉自 {sessionTitle(parent)}</span>
							</button>
						)}
					</div>
					{/* 这个会话在不在侧栏（工作区）里：手机上没有指着才出现的按钮，在这里放进、移出 */}
					{r.project && r.session && (
						<Button
							variant="ghost"
							size="icon"
							className="text-muted-foreground"
							onClick={() => change(inWorkspace(r.session as string) ? { op: "remove", project: r.project as string, session: r.session as string } : { op: "add", project: r.project as string, path: p?.path ?? null, session: r.session as string })}
							aria-label={inWorkspace(r.session) ? "移出工作区" : "放进工作区"}
							title={inWorkspace(r.session) ? "移出工作区" : "放进工作区"}
						>
							{inWorkspace(r.session) ? <PinOff className="size-4" /> : <Pin className="size-4" />}
						</Button>
					)}
					{r.session && (
						<ToggleGroup type="single" size="sm" value={panelOf(r, wide) ?? ""} onValueChange={(v) => go({ panel: (v || "none") as Route["panel"] })}>
							{PANELS.map(({ v, label }) => {
								const I = PANEL_ICON[v];
								return (
									<Tooltip key={v}>
										<TooltipTrigger asChild>
											<ToggleGroupItem value={v} className="size-8 px-0 aria-checked:bg-muted" aria-label={label}>
												<I className="size-4" />
											</ToggleGroupItem>
										</TooltipTrigger>
										<TooltipContent>{label}</TooltipContent>
									</Tooltip>
								);
							})}
						</ToggleGroup>
					)}
				</header>
				<div className="flex min-h-0 flex-1 flex-col">
					{r.project && r.session ? (
						<SessionView key={`${r.project}/${r.session}`} project={r.project} root={p?.path ?? null} session={r.session} r={r} meta={meta} />
					) : r.project ? (
						<ProjectHome key={r.project} p={p ?? { id: r.project, path: null }} r={r} />
					) : (
						<Empty className="m-auto">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<MessageSquare />
								</EmptyMedia>
								<EmptyTitle>选择一个会话，或新建会话</EmptyTitle>
								<EmptyDescription>左边是你的工作区：放进来的文件夹和会话，右边的标记是它现在的状态。已有的会话从「浏览会话」里挑。</EmptyDescription>
							</EmptyHeader>
							<Button variant="outline" size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}>
								<SquarePen className="size-3.5" />
								新会话
							</Button>
						</Empty>
					)}
				</div>
			</SidebarInset>
			<NewSession open={newOpen} onOpenChange={setNewOpen} />
			<FloatingApprovals current={r.session} />
		</SidebarProvider>
	);
}
