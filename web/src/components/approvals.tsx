// 确认请求：Claude 要执行命令、改文件时问你。当前会话的请求出现在对话里（前面就是 Claude 的思路）；别的会话的浮在右下角，带「查看」。
import { Check, ChevronRight, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api, type Approval } from "@shared/api";
import { useLive } from "@/lib/live";
import { openSession } from "@/lib/route";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./message";
import { sessionTitle } from "./side";

/** 一行说清 Claude 想做什么；仓库里的路径写成相对路径 */
export function what(a: Approval, cwd?: string): string {
	const i = a.input as Record<string, unknown>;
	const s = String(i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.query ?? "");
	return (cwd && s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s).slice(0, 300);
}

export function ApprovalCard({ a, elsewhere, className }: { a: Approval; elsewhere?: string; className?: string }) {
	const w = what(a, a.cwd);
	// 点了就先按住两个按钮，免得点两下；答上了不等服务推来 approval-done，先收起来
	const [state, setState] = useState<"busy" | "done" | null>(null);
	const answer = async (allow: boolean) => {
		if (state) return;
		setState("busy");
		try {
			await api(`/api/approvals/${a.id}`, { allow });
			setState("done");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
			setState(null);
		}
	};
	if (state === "done") return null;
	return (
		<Card className={cn("gap-3 py-4 ring-waiting/50", className)}>
			<CardHeader className="px-4">
				<CardTitle className="flex items-center gap-2 text-sm">
					<ShieldQuestion className="size-4 text-waiting" />
					Claude 请求使用 {a.tool.replace(/^mcp__[^_]+__/, "")}
				</CardTitle>
				{a.agent && <div className="truncate text-2xs text-muted-foreground">子代理{a.agent.description ? `「${a.agent.description}」` : ""}在问</div>}
				{elsewhere && (
					<button type="button" onClick={() => openSession(a.project, a.session)} className="truncate text-left text-2xs text-muted-foreground hover:text-foreground">
						{elsewhere} · 查看
					</button>
				)}
			</CardHeader>
			<CardContent className="flex flex-col gap-2 px-4">
				{w && <CodeBlock className="max-h-32">{w}</CodeBlock>}
				<Collapsible>
					<CollapsibleTrigger className="group/args flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground">
						<ChevronRight className="size-3 transition-transform group-data-[state=open]/args:rotate-90" />
						完整参数
					</CollapsibleTrigger>
					<CollapsibleContent>
						<CodeBlock className="mt-1 max-h-48">{JSON.stringify(a.input, null, 2)}</CodeBlock>
					</CollapsibleContent>
				</Collapsible>
			</CardContent>
			<CardFooter className="gap-2 px-4">
				<Button variant="outline" className="flex-1 gap-1.5" disabled={!!state} onClick={() => answer(false)}>
					<X className="size-4" />
					拒绝
				</Button>
				<Button className="flex-1 gap-1.5" disabled={!!state} onClick={() => answer(true)}>
					<Check className="size-4" />
					允许
				</Button>
			</CardFooter>
		</Card>
	);
}

/** 别的会话的确认请求：浮在右下角；新来的发一条系统通知 */
export function FloatingApprovals({ current }: { current: string | null }) {
	const { approvals, workspace } = useLive();
	// 和侧栏一样的标题，前面带上文件夹名
	const title = (sid: string) => {
		for (const p of workspace ?? []) {
			const s = p.sessions.find((x) => x.id === sid);
			if (s) return `${p.path?.split("/").pop() ?? p.id} · ${sessionTitle(s)}`;
		}
		return sid.slice(0, 8);
	};
	const list = approvals.filter((a) => a.session !== current);
	if (list.length === 0) return null;
	return (
		<div className="fixed inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:w-104">
			{list.map((a) => <ApprovalCard key={a.id} a={a} elsewhere={title(a.session)} className="shadow-lg" />)}
		</div>
	);
}
