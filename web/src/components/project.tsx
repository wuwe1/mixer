// 项目页：在这个项目里开新会话；下面看它的文件和改动。
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ProjectTree } from "@/lib/api";
import { go, type Route } from "@/lib/route";
import { Changes } from "./changes";
import { Files } from "./files";
import { StartBox } from "./new-session";
import { projectName } from "./side";

export function ProjectHome({ p, r }: { p: Pick<ProjectTree, "id" | "path">; r: Route }) {
	const tab = r.panel === "changes" ? "changes" : "files";
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 border-b">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6 md:py-10">
					<div className="flex flex-col gap-0.5">
						<h1 className="text-lg font-semibold tracking-tight">{projectName(p)}</h1>
						<p className="truncate font-mono text-xs text-muted-foreground">{p.path}</p>
					</div>
					<StartBox target={{ project: p.id }} lead="新会话：" />
				</div>
			</div>
			<Tabs value={tab} onValueChange={(v) => go({ panel: v as "files" | "changes", file: null, view: null }, true)} className="flex min-h-0 flex-1 flex-col gap-0">
				<div className="flex h-11 shrink-0 items-center border-b px-3">
					<TabsList className="h-8">
						<TabsTrigger value="files" className="px-3 text-xs">文件</TabsTrigger>
						<TabsTrigger value="changes" className="px-3 text-xs">改动</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent value="files" className="flex min-h-0 flex-1">
					<Files project={p.id} file={r.file} view={r.view} />
				</TabsContent>
				<TabsContent value="changes" className="flex min-h-0 flex-1">
					<Changes project={p.id} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
