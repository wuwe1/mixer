// 确认请求：Claude 要执行命令、改文件时问你。当前会话的挂在输入框上面（composer.tsx），别的会话的：电脑上浮在右下角，手机上收成顶上一条，点开再看。
// 三种样子：一般的工具（命令、文件，允许 / 拒绝）；计划写好了（ExitPlanMode：计划照 Markdown 画，按计划执行 / 接着计划）；
// Claude 问你（AskUserQuestion：每个选项一个按钮，也能自己写）。拒绝都能附一句说明，Claude 看得到
import { Check, ListChecks, MessageCircleQuestion, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, type Approval, sessionTitle } from "@shared/api";
import { useLive } from "@/lib/live";
import { openSession, useWide } from "@/lib/route";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { CodeBlock } from "./message";
import { Chevron } from "./placeholder";
import { Popsheet } from "./popsheet";

/** 一行说清 Claude 想做什么；仓库里的路径写成相对路径 */
export function what(a: Approval, cwd?: string): string {
	const i = a.input;
	const s = String(i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.query ?? "");
	return (cwd && s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s).slice(0, 300);
}

type Answer = { allow: boolean; message?: string; answers?: Record<string, string> };
type Question = { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };

export function ApprovalCard({ a, elsewhere, className }: { a: Approval; elsewhere?: string; className?: string }) {
	// 点了就先按住按钮，免得点两下；答上了不等服务推来 approval-done，先收起来
	const [state, setState] = useState<"busy" | "done" | null>(null);
	// 拒绝时附的说明：null 是没打开
	const [why, setWhy] = useState<string | null>(null);
	const [args, setArgs] = useState(false);
	const answer = async (d: Answer) => {
		if (state) return;
		setState("busy");
		try {
			await api(`/api/approvals/${a.id}`, d);
			setState("done");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
			setState(null);
		}
	};
	if (state === "done") return null;
	const plan = a.tool === "ExitPlanMode";
	const ask = a.tool === "AskUserQuestion";
	const w = what(a, a.cwd);
	const Icon = plan ? ListChecks : ask ? MessageCircleQuestion : ShieldQuestion;
	return (
		<Card className={cn("gap-3 py-4 ring-waiting/50", className)}>
			<CardHeader className="px-4">
				<CardTitle className="flex items-center gap-2 text-sm">
					<Icon className="size-4 text-waiting" />
					{plan ? "计划写好了，等你看" : ask ? "Claude 问你" : `Claude 请求使用 ${a.tool.replace(/^mcp__[^_]+__/, "")}`}
				</CardTitle>
				{a.agent && <div className="truncate text-2xs text-muted-foreground">子代理{a.agent.description ? `「${a.agent.description}」` : ""}在问</div>}
				{elsewhere && (
					<button type="button" onClick={() => openSession(a.project, a.session)} className="-mx-1 truncate rounded px-1 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
						{elsewhere} · 查看
					</button>
				)}
			</CardHeader>
			<CardContent className="flex flex-col gap-2 px-4">
				{plan ? (
					<div className="max-h-[40svh] overflow-y-auto rounded-md border px-3 py-2 text-sm">
						<Markdown text={String(a.input.plan ?? "")} />
					</div>
				) : ask ? (
					<Questions qs={Array.isArray(a.input.questions) ? (a.input.questions as Question[]) : []} busy={!!state} onAnswer={(answers) => answer({ allow: true, answers })} />
				) : (
					<>
						{w && <CodeBlock className="max-h-32">{w}</CodeBlock>}
						<button type="button" onClick={() => setArgs((o) => !o)} className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground">
							<Chevron open={args} />
							完整参数
						</button>
						{args && <CodeBlock className="max-h-48">{JSON.stringify(a.input, null, 2)}</CodeBlock>}
					</>
				)}
				{why !== null && (
					<Input
						autoFocus
						value={why}
						onChange={(e) => setWhy(e.target.value)}
						onKeyDown={(e) => { if (e.key === "Enter") answer({ allow: false, message: why.trim() || undefined }); }}
						placeholder={plan ? "哪里要改（可以不写）" : "告诉 Claude 为什么、该怎么做（可以不写）"}
					/>
				)}
			</CardContent>
			<CardFooter className="gap-2 px-4">
				{why !== null ? (
					<>
						<Button variant="outline" className="flex-1" disabled={!!state} onClick={() => setWhy(null)}>
							算了
						</Button>
						<Button variant="outline" className="flex-1 gap-1.5" disabled={!!state} onClick={() => answer({ allow: false, message: why.trim() || undefined })}>
							<X className="size-4" />
							{plan ? "接着计划" : ask ? "不回答" : "拒绝"}
						</Button>
					</>
				) : (
					<>
						<Button variant="outline" className="flex-1 gap-1.5" disabled={!!state} onClick={() => setWhy("")}>
							<X className="size-4" />
							{plan ? "接着计划…" : ask ? "不回答…" : "拒绝…"}
						</Button>
						{!ask && (
							<Button className="flex-1 gap-1.5" disabled={!!state} onClick={() => answer({ allow: true })}>
								<Check className="size-4" />
								{plan ? "按计划执行" : "允许"}
							</Button>
						)}
					</>
				)}
			</CardFooter>
		</Card>
	);
}

/** AskUserQuestion：每个问题一组选项（多选的能选几个），也能自己写；都答了才能交 */
function Questions({ qs, busy, onAnswer }: { qs: Question[]; busy: boolean; onAnswer: (answers: Record<string, string>) => void }) {
	const [picked, setPicked] = useState<Record<string, string[]>>({});
	const [other, setOther] = useState<Record<string, string>>({});
	const value = (q: Question) => other[q.question]?.trim() || (picked[q.question] ?? []).join(", ");
	const pick = (q: Question, label: string) => {
		setOther((o) => ({ ...o, [q.question]: "" }));
		setPicked((p) => {
			const now = p[q.question] ?? [];
			const next = q.multiSelect ? (now.includes(label) ? now.filter((x) => x !== label) : [...now, label]) : [label];
			return { ...p, [q.question]: next };
		});
	};
	const done = qs.length > 0 && qs.every((q) => value(q));
	return (
		<div className="flex flex-col gap-4">
			{qs.map((q) => (
				<div key={q.question} className="flex flex-col gap-2">
					<div className="text-sm">
						{q.question}
						{q.multiSelect && <span className="ml-1 text-2xs text-muted-foreground">可以选几个</span>}
					</div>
					{(q.options ?? []).map((o) => {
						const on = (picked[q.question] ?? []).includes(o.label) && !other[q.question]?.trim();
						return (
							<Button key={o.label} variant={on ? "default" : "outline"} className="h-auto min-h-11 flex-col items-start gap-0.5 py-2 text-left whitespace-normal" disabled={busy} onClick={() => pick(q, o.label)}>
								<span>{o.label}</span>
								{o.description && <span className={cn("text-xs font-normal", on ? "opacity-80" : "text-muted-foreground")}>{o.description}</span>}
							</Button>
						);
					})}
					<Input value={other[q.question] ?? ""} onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))} placeholder="都不是：自己写" disabled={busy} />
				</div>
			))}
			<Button className="gap-1.5" disabled={busy || !done} onClick={() => onAnswer(Object.fromEntries(qs.map((q) => [q.question, value(q)])))}>
				<Check className="size-4" />
				回答
			</Button>
		</div>
	);
}

/** 别的会话的确认请求：电脑上浮在右下角；手机上收成顶上一条（不挡输入框），点开从下面出来 */
export function FloatingApprovals({ current }: { current: string | null }) {
	const { approvals, workspace } = useLive();
	const wide = useWide();
	const [open, setOpen] = useState(false);
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
	const cards = list.map((a) => <ApprovalCard key={a.id} a={a} elsewhere={title(a.session)} className={wide ? "shadow-lg" : undefined} />);
	if (wide) return <div className="fixed right-4 bottom-4 z-50 flex max-h-[80svh] w-104 flex-col gap-2 overflow-y-auto">{cards}</div>;
	return (
		<Popsheet
			open={open}
			onOpenChange={setOpen}
			title={`别的会话待确认 · ${list.length}`}
			trigger={
				<button type="button" className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+3.5rem)] z-40 flex h-11 items-center gap-2 rounded-full border border-waiting/50 bg-background/95 px-4 text-md shadow-md backdrop-blur">
					<span className="size-2 shrink-0 rounded-full bg-waiting" />
					<span className="min-w-0 flex-1 truncate text-left">{list.length > 1 ? `${list.length} 个确认在等你` : title(list[0].session)}</span>
					<span className="shrink-0 text-xs text-muted-foreground">待确认 ›</span>
				</button>
			}
		>
			<div className="flex flex-col gap-3 pb-2">{cards}</div>
		</Popsheet>
	);
}
