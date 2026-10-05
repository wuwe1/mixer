// 改动：当前分支、没提交的改动（点开看 diff；在会话里时可以只看这个会话改过的文件）、最近的提交（点开看内容）。按容器宽度排，同 files.tsx。
import { ChevronLeft, GitBranch, GitCommitHorizontal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, enc, type Status } from "@/lib/api";
import { useEvent } from "@/lib/events";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";

const CODE: Record<string, { label: string; cls: string }> = {
	M: { label: "改", cls: "text-amber-600 dark:text-amber-400" },
	A: { label: "加", cls: "text-emerald-600 dark:text-emerald-400" },
	D: { label: "删", cls: "text-destructive" },
	R: { label: "改名", cls: "text-sky-600 dark:text-sky-400" },
	"?": { label: "新", cls: "text-emerald-600 dark:text-emerald-400" },
};
const kind = (code: string) => CODE[code.trim()[0] ?? "M"] ?? CODE.M;

export function Diff({ text }: { text: string }) {
	return (
		<pre className="min-w-max py-2 font-mono text-[12px] leading-[1.6]">
			{text.split("\n").map((l, i) => (
				<div
					key={i}
					className={cn(
						"px-4",
						l.startsWith("+") && !l.startsWith("+++") && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
						l.startsWith("-") && !l.startsWith("---") && "bg-red-500/10 text-red-700 dark:text-red-300",
						l.startsWith("@@") && "bg-sky-500/10 text-sky-700 dark:text-sky-300",
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
	if (!s.git) return <p className="p-6 text-sm text-muted-foreground">这个目录不是 git 仓库。</p>;
	// 改名的那行是「旧 -> 新」，取新的
	const shown = touched && only ? s.changes.filter((c) => touched.includes(c.path.split(" -> ").pop() as string)) : s.changes;
	return (
		<div className="@container/changes flex min-h-0 flex-1">
			<div className={cn("flex w-full shrink-0 flex-col @3xl/changes:w-80 @3xl/changes:border-r", sel && "@max-3xl/changes:hidden")}>
				<ScrollArea className="min-h-0 flex-1">
					<div className="flex flex-col gap-5 p-3">
						<div className="flex items-center gap-2 text-[13px]">
							<GitBranch className="size-3.5 text-muted-foreground" />
							<span className="truncate font-mono text-xs">{s.branch}</span>
						</div>
						<section className="flex flex-col gap-1">
							<div className="flex items-center gap-2 px-1">
								<h3 className="text-[11px] font-medium text-muted-foreground">没提交的改动 · {shown.length}</h3>
								{touched && (
									<ToggleGroup type="single" size="sm" value={only ? "mine" : "all"} onValueChange={(v) => v && setOnly(v === "mine")} className="ml-auto">
										<ToggleGroupItem value="mine" className="h-6 px-2 text-[11px]">本会话</ToggleGroupItem>
										<ToggleGroupItem value="all" className="h-6 px-2 text-[11px]">全部</ToggleGroupItem>
									</ToggleGroup>
								)}
							</div>
							{shown.length === 0 && <p className="px-1 text-[13px] text-muted-foreground">{touched && only && s.changes.length ? `这个会话没改过文件（项目里另有 ${s.changes.length} 处改动）` : "干净"}</p>}
							{shown.map((c) => {
								const k = kind(c.code);
								return (
									<button key={c.path} type="button" onClick={() => setSel({ kind: "file", key: c.path, title: c.path })} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent", sel?.key === c.path && "bg-accent")}>
										<span className={cn("w-7 shrink-0 text-[11px] font-medium", k.cls)}>{k.label}</span>
										<span className="truncate font-mono text-xs">{c.path}</span>
									</button>
								);
							})}
						</section>
						<section className="flex flex-col gap-1">
							<h3 className="px-1 text-[11px] font-medium text-muted-foreground">最近的提交</h3>
							{s.log.map((c) => (
								<button key={c.hash} type="button" onClick={() => setSel({ kind: "commit", key: c.hash, title: c.subject })} className={cn("flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent", sel?.key === c.hash && "bg-accent")}>
									<span className="line-clamp-2 text-[13px] leading-snug">{c.subject}</span>
									<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
										<GitCommitHorizontal className="size-3" />
										<span className="font-mono">{c.hash}</span> · {ago(c.when)}
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
							<Button variant="ghost" size="icon" className="size-7 @3xl/changes:hidden" onClick={() => setSel(null)} aria-label="返回">
								<ChevronLeft className="size-4" />
							</Button>
							<Badge variant="outline" className="shrink-0">{sel.kind === "file" ? "改动" : "提交"}</Badge>
							<span className="truncate text-xs">{sel.title}</span>
						</div>
						<div className="min-h-0 flex-1 overflow-auto overscroll-contain">{text === null ? <Skeleton className="m-4 h-40" /> : <Diff text={text} />}</div>
					</>
				) : (
					<div className="m-auto text-sm text-muted-foreground">选一个改动或提交</div>
				)}
			</div>
		</div>
	);
}
