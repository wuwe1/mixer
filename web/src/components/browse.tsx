// 浏览会话：本机所有的会话（按文件夹，文件夹和会话都是新的在上面），点一个就打开它、放进工作区
import { Check, GitFork, MessageSquare } from "lucide-react";
import { useEffect } from "react";
import { toast } from "@/lib/toast";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSidebar } from "@/components/ui/sidebar";
import type { ProjectTree, SessionMeta } from "@shared/api";
import { useLive } from "@/lib/live";
import { match } from "@/lib/match";
import { openSession } from "@/lib/route";
import { since } from "@/lib/time";
import { useApi } from "@/lib/use-api";
import { Loading } from "./placeholder";
import { families, projectName, sessionTitle, StatusIcon } from "./side";

export function Browse({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const { inWorkspace, change, status } = useLive();
	const { setOpenMobile } = useSidebar();
	// 每次打开都重新拿：要扫所有会话，侧栏平时不用它
	const { data: tree, error } = useApi<ProjectTree[]>(open ? "/api/tree" : null);
	useEffect(() => { if (error) toast.error(error.message); }, [error]);
	const pick = (p: ProjectTree, s: SessionMeta) => {
		change({ op: "add", project: p.id, path: p.path, session: s.id });
		openSession(p.id, s.id);
		onOpenChange(false);
		setOpenMobile(false);
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="top-[max(1rem,env(safe-area-inset-top))] translate-y-0 gap-4 sm:top-[12vh] sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>浏览会话</DialogTitle>
					<DialogDescription>点一个会话打开它，同时放进工作区</DialogDescription>
				</DialogHeader>
				{!tree ? (
					<Loading className="h-80" />
				) : (
					<Command className="rounded-lg! border bg-transparent p-0" filter={match}>
						<CommandInput placeholder="搜索会话或文件夹" />
						<CommandList className="max-h-[min(28rem,60svh)]">
							<CommandEmpty className="py-5 text-md text-muted-foreground">没有匹配的会话</CommandEmpty>
							{tree.map((p) => (
								<CommandGroup key={p.id} heading={projectName(p)}>
									{families(p.sessions).flatMap((f) => [[f.head, false] as const, ...f.kids.map((k) => [k, true] as const)]).map(([s, kid]) => (
										<CommandItem key={s.id} value={`${projectName(p)} ${sessionTitle(s)} ${s.first ?? ""} ${s.last ?? ""} ${s.id}`} onSelect={() => pick(p, s)} className={kid ? "pl-6" : undefined}>
											{kid ? <GitFork className="text-muted-foreground" /> : <MessageSquare className="text-muted-foreground" />}
											<span className="min-w-0 flex-1 truncate text-md">{sessionTitle(s)}</span>
											{inWorkspace(s.id) && <Check className="text-muted-foreground" aria-label="已在工作区" />}
											<span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{since(s.mtime)}</span>
											<StatusIcon s={status(s)} />
										</CommandItem>
									))}
								</CommandGroup>
							))}
						</CommandList>
					</Command>
				)}
			</DialogContent>
		</Dialog>
	);
}
