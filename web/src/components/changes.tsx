// 改动：当前分支、未提交的改动（点开看 diff；在会话里时可以只看这个会话改过的文件）、最近的提交（点开看内容）。按容器宽度排，同 files.tsx。
import { ChevronLeft, GitBranch, GitCommitHorizontal, GitCompareArrows } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, enc, type Status } from "@/lib/api";
import { useEvent } from "@/lib/events";
import { since } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Placeholder } from "./placeholder";

const CODE: Record<string, { label: string; cls: string }> = {
	M: { label: "修改", cls: "text-modified" },
	A: { label: "新增", cls: "text-added" },
	D: { label: "删除", cls: "text-removed" },
	R: { label: "重命名", cls: "text-renamed" },
	"?": { label: "新文件", cls: "text-added" },
};
const kind = (code: string) => CODE[code.trim()[0] ?? "M"] ?? CODE.M;

export function Diff({ text }: { text: string }) {
	return (
		<pre className="min-w-max py-2 font-mono text-xs leading-[1.6]">
			{text.split("\n").map((l, i) => (
				<div
					key={i}
					className={cn(
						"px-4",
						l.startsWith("+") && !l.startsWith("+++") && "bg-added/10 text-added",
						l.startsWith("-") && !l.startsWith("---") && "bg-removed/10 text-removed",
						l.startsWith("@@") && "bg-muted text-muted-foreground",
						/^(diff |index |\+\+\+|---)/.test(l) && "text-muted-foreground",
					)}
				>
					{l || " "}
				</div>
			))}
		</pre>
	);
}

export function Changes({ project, touched }: { project: string; touched?: string[] }) {
	const [s, setS] = useState<Status | null>(null);
	const [only, setOnly] = useState(true);
	const [sel, setSel] = useState<{ kind: "file" | "commit"; key: string; title: string } | null>(null);
	const [text, setText] = useState<string | null>(null);
	const load = useCallback(() => { api<Status>(`/api/repo/${enc(project)}/status`).then(setS, () => setS({ git: false })); }, [project]);
	useEffect(() => { setS(null); setSel(null); load(); }, [load]);
	useEvent("session", useCallback((e: { project: string }) => { if (e.project === project) load(); }, [project, load]));
	useEffect(() => {
		if (!sel) return;
		setText(null);
		const url = sel.kind === "file" ? `/api/repo/${enc(project)}/diff?path=${enc(sel.key)}` : `/api/repo/${enc(project)}/commit/${sel.key}`;
		api<{ diff?: string; text?: string }>(url).then((r) => setText(r.diff ?? r.text ?? ""), (e: Error) => setText(e.message));
	}, [project, sel]);

	if (!s) return <div className="flex flex-col gap-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>;
	if (!s.git) return <Placeholder icon={GitBranch} title="不是 git 仓库" text="这个目录不在 git 里，没有改动和提交可看。" />;
	// 改名的那行是「旧 -> 新」，取新的
	const shown = touched && only ? s.changes.filter((c) => touched.includes(c.path.split(" -> ").pop() as string)) : s.changes;
	return (
		<div className="@container/changes flex min-h-0 flex-1">
			<div className={cn("flex w-full shrink-0 flex-col @3xl/changes:w-80 @3xl/changes:border-r", sel && "@max-3xl/changes:hidden")}>
				<ScrollArea className="min-h-0 flex-1">
					<div className="flex flex-col gap-5 p-3">
						<div className="flex items-center gap-2 text-md">
							<GitBranch className="size-3.5 text-muted-foreground" />
							<span className="truncate font-mono text-xs">{s.branch}</span>
						</div>
						<section className="flex flex-col gap-1">
							<div className="flex items-center gap-2 px-1">
								<h3 className="text-2xs font-medium text-muted-foreground">未提交的改动 · {shown.length}</h3>
								{touched && (
									<ToggleGroup type="single" size="sm" value={only ? "mine" : "all"} onValueChange={(v) => v && setOnly(v === "mine")} className="ml-auto">
										<ToggleGroupItem value="mine" className="h-6 px-2 text-2xs">本会话</ToggleGroupItem>
										<ToggleGroupItem value="all" className="h-6 px-2 text-2xs">全部</ToggleGroupItem>
									</ToggleGroup>
								)}
							</div>
							{shown.length === 0 && <p className="px-1 text-md text-muted-foreground">{touched && only && s.changes.length ? `这个会话没有改动文件（项目里另有 ${s.changes.length} 处改动）` : "没有未提交的改动"}</p>}
							{shown.map((c) => {
								const k = kind(c.code);
								return (
									<button key={c.path} type="button" onClick={() => setSel({ kind: "file", key: c.path, title: c.path })} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent", sel?.key === c.path && "bg-accent")}>
										<span className={cn("w-10 shrink-0 text-2xs font-medium", k.cls)}>{k.label}</span>
										<span className="truncate font-mono text-xs">{c.path}</span>
									</button>
								);
							})}
						</section>
						<section className="flex flex-col gap-1">
							<h3 className="px-1 text-2xs font-medium text-muted-foreground">最近的提交</h3>
							{s.log.map((c) => (
								<button key={c.hash} type="button" onClick={() => setSel({ kind: "commit", key: c.hash, title: c.subject })} className={cn("flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent", sel?.key === c.hash && "bg-accent")}>
									<span className="line-clamp-2 text-md leading-snug">{c.subject}</span>
									<span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
										<GitCommitHorizontal className="size-3" />
										<span className="font-mono">{c.hash}</span> · {since(c.when)}
									</span>
								</button>
							))}
						</section>
					</div>
				</ScrollArea>
			</div>
			<div className={cn("flex min-w-0 flex-1 flex-col", !sel && "@max-3xl/changes:hidden")}>
				{sel ? (
					<>
						<div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
							<Button variant="ghost" size="icon-sm" className="@3xl/changes:hidden" onClick={() => setSel(null)} aria-label="返回">
								<ChevronLeft className="size-4" />
							</Button>
							<Badge variant="outline" className="shrink-0">{sel.kind === "file" ? "改动" : "提交"}</Badge>
							<span className="truncate text-xs">{sel.title}</span>
						</div>
						<div className="min-h-0 flex-1 overflow-auto overscroll-contain">{text === null ? <Skeleton className="m-4 h-40" /> : <Diff text={text} />}</div>
					</>
				) : (
					<Placeholder icon={GitCompareArrows} text="选择一个改动或提交" />
				)}
			</div>
		</div>
	);
}
