// 运行：所有在 mixer 里启动过的运行（状态、停止、跳到会话）；确认请求：Claude 要执行命令、改文件时弹出来，点允许或拒绝。
import { Check, CircleStop, ShieldQuestion, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, type Approval, type Run } from "@/lib/api";
import { useEvent } from "@/lib/events";
import { go } from "@/lib/route";
import { clock } from "@/lib/time";

const STATUS: Record<Run["status"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
	running: { label: "在跑", variant: "default" },
	done: { label: "完成", variant: "secondary" },
	error: { label: "出错", variant: "destructive" },
	stopped: { label: "停了", variant: "outline" },
};
const MODE: Record<Run["mode"], string> = { new: "新会话", resume: "续接", fork: "分叉", "fork-at": "从中间分叉" };

export function useRuns() {
	const [runs, setRuns] = useState<Run[]>([]);
	const load = useCallback(() => { api<Run[]>("/api/runs").then(setRuns, () => {}); }, []);
	useEffect(load, [load]);
	useEvent("reconnect", load);
	useEvent("run", useCallback((r: Run) => setRuns((rs) => [r, ...rs.filter((x) => x.id !== r.id)].sort((a, b) => b.started.localeCompare(a.started))), []));
	return runs;
}

export function RunsSheet({ open, onOpenChange, runs }: { open: boolean; onOpenChange: (o: boolean) => void; runs: Run[] }) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-[92vw] p-0 sm:max-w-md">
				<SheetHeader className="border-b">
					<SheetTitle>运行</SheetTitle>
					<SheetDescription>在 mixer 里启动的 claude，按开始时间排。</SheetDescription>
				</SheetHeader>
				<ScrollArea className="min-h-0 flex-1">
					<div className="flex flex-col gap-2 p-3">
						{runs.length === 0 && <p className="p-3 text-sm text-muted-foreground">还没有。打开一个会话，在底部输入框里续接或分叉。</p>}
						{runs.map((r) => (
							<div key={r.id} className="flex flex-col gap-2 rounded-lg border p-3">
								<div className="flex items-center gap-2">
									<Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
									<span className="text-xs text-muted-foreground">{MODE[r.mode]} · {clock(r.started)}</span>
									{r.status === "running" && (
										<Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 px-2 text-xs" onClick={() => api(`/api/runs/${r.id}/stop`, {})}>
											<CircleStop className="size-3.5" />
											停止
										</Button>
									)}
								</div>
								<p className="line-clamp-3 text-[13px] leading-snug">{r.prompt}</p>
								{r.error && <p className="line-clamp-4 font-mono text-[11px] text-destructive">{r.error}</p>}
								{r.session && (
									<Button variant="link" size="sm" className="h-auto self-start p-0 text-xs" onClick={() => { onOpenChange(false); go({ project: r.project, session: r.session, tab: "chat", leaf: null }); }}>
										打开会话 {r.session.slice(0, 8)}
									</Button>
								)}
							</div>
						))}
					</div>
				</ScrollArea>
			</SheetContent>
		</Sheet>
	);
}

/** 一行说清 Claude 想做什么；仓库里的路径写成相对路径 */
function what(a: Approval, cwd?: string): string {
	const i = a.input as Record<string, unknown>;
	const s = String(i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.query ?? "");
	return (cwd && s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s).slice(0, 300);
}

export function Approvals({ runs }: { runs: Run[] }) {
	const [list, setList] = useState<Approval[]>([]);
	useEffect(() => { api<Approval[]>("/api/approvals").then(setList, () => {}); }, []);
	useEvent("approval", useCallback((a: Approval) => {
		setList((l) => [...l, a]);
		if ("Notification" in window && Notification.permission === "granted") new Notification("Claude 要你确认", { body: `${a.tool}：${what(a)}` });
		navigator.vibrate?.(80);
	}, []));
	useEvent("approval-done", useCallback((d: { id: string }) => setList((l) => l.filter((a) => a.id !== d.id)), []));
	const answer = async (a: Approval, allow: boolean) => {
		try {
			await api(`/api/approvals/${a.id}`, { allow });
			setList((l) => l.filter((x) => x.id !== a.id));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	};
	if (list.length === 0) return null;
	return (
		<div className="fixed inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:w-[26rem]">
			{list.map((a) => { const r = runs.find((x) => x.id === a.run); return (
				<Card key={a.id} className="gap-3 py-4 shadow-lg ring-1 ring-ring/20">
					<CardHeader className="px-4">
						<CardTitle className="flex items-center gap-2 text-sm">
							<ShieldQuestion className="size-4 text-primary" />
							Claude 想用 {a.tool.replace(/^mcp__[^_]+__/, "")}
						</CardTitle>
						{r && (
							<button
								type="button"
								disabled={!r.session}
								onClick={() => r.session && go({ project: r.project, session: r.session, tab: "chat", leaf: null })}
								className="truncate text-left text-[11px] text-muted-foreground enabled:hover:text-foreground"
							>
								{r.cwd.split("/").pop()} · {r.prompt}
							</button>
						)}
					</CardHeader>
					<CardContent className="flex flex-col gap-2 px-4">
						{what(a, r?.cwd) && <pre className="max-h-32 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[12px] whitespace-pre-wrap break-all">{what(a, r?.cwd)}</pre>}
						<Collapsible>
							<CollapsibleTrigger className="text-[11px] text-muted-foreground underline-offset-4 hover:underline">完整参数</CollapsibleTrigger>
							<CollapsibleContent>
								<pre className="mt-1 max-h-48 overflow-auto rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap break-all">{JSON.stringify(a.input, null, 2)}</pre>
							</CollapsibleContent>
						</Collapsible>
					</CardContent>
					<CardFooter className="gap-2 px-4">
						<Button variant="outline" className="flex-1 gap-1.5" onClick={() => answer(a, false)}>
							<X className="size-4" />
							拒绝
						</Button>
						<Button className="flex-1 gap-1.5" onClick={() => answer(a, true)}>
							<Check className="size-4" />
							允许
						</Button>
					</CardFooter>
				</Card>
			); })}
		</div>
	);
}
