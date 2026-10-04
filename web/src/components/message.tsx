// 一条一条消息怎么画：你的话（右边的气泡）、Claude 的话（Markdown）、连在一起的工具调用和思考（收成一组，点开看）、事件（分隔线）。
import { Bot, Brain, ChevronRight, FileText, Globe, GitFork, Pencil, Search, SquareTerminal, Wrench, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api, enc, type Node, type ToolNode } from "@/lib/api";
import { clock } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";

const ICON: Record<string, typeof Wrench> = {
	Bash: SquareTerminal, Read: FileText, Write: Pencil, Edit: Pencil, MultiEdit: Pencil, NotebookEdit: Pencil, Grep: Search, Glob: Search,
	WebSearch: Globe, WebFetch: Globe, Agent: Bot, Task: Bot,
};
const toolIcon = (name: string) => ICON[name] ?? (name.startsWith("mcp__") ? Globe : Wrench);
const toolName = (name: string) => name.replace(/^mcp__[^_]+__/, "");

export function UserMessage({ n, project, session, onFork }: { n: Extract<Node, { k: "user" }>; project: string; session: string; onFork?: (n: Extract<Node, { k: "user" }>) => void }) {
	return (
		<div id={`n-${n.uuid}`} className="group flex scroll-mt-24 flex-col items-end gap-1.5">
			<div className="max-w-[88%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap break-words text-secondary-foreground">
				{n.text || (n.images ? "" : "（空）")}
				{n.images > 0 && (
					<div className="mt-2 flex flex-wrap gap-2">
						{Array.from({ length: n.images }, (_, i) => (
							<a key={i} href={`/api/sessions/${enc(project)}/${enc(session)}/image/${n.uuid}/${i}`} target="_blank" rel="noreferrer">
								<img src={`/api/sessions/${enc(project)}/${enc(session)}/image/${n.uuid}/${i}`} alt="" loading="lazy" className="max-h-48 rounded-lg border object-cover" />
							</a>
						))}
					</div>
				)}
			</div>
			<div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
				{n.queued && <Badge variant="outline" className="h-4 px-1.5 text-[10px]">中途发的</Badge>}
				<span className="tabular-nums">{clock(n.ts)}</span>
				{onFork && (
					<Button variant="ghost" size="sm" onClick={() => onFork(n)} className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100">
						<GitFork className="size-3" />
						从这里分叉
					</Button>
				)}
			</div>
		</div>
	);
}

export function AssistantMessage({ n }: { n: Extract<Node, { k: "assistant" }> }) {
	return (
		<div id={`n-${n.uuid}`} className="scroll-mt-24">
			<Markdown text={n.text} />
		</div>
	);
}

export function EventLine({ n }: { n: Extract<Node, { k: "event" }> }) {
	return (
		<div id={`n-${n.uuid}`} className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
			<span className="h-px flex-1 bg-border" />
			<span className="max-w-[80%] text-center">{n.kind === "summary" ? `离开时的小结：${n.text}` : n.text}</span>
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}

/** 连在一起的工具调用、思考：收成一组，默认只显示一行概览 */
export function Steps({ nodes, project, session, agent, onAgent }: { nodes: Node[]; project: string; session: string; agent?: string; onAgent?: (id: string) => void }) {
	const tools = nodes.filter((n): n is ToolNode => n.k === "tool");
	const errors = tools.filter((t) => t.result?.error).length;
	const names = [...new Set(tools.map((t) => toolName(t.name)))];
	return (
		<Collapsible id={`n-${nodes[0].uuid}`} className="scroll-mt-24">
			<CollapsibleTrigger className="group/steps flex w-full items-center gap-2 rounded-md py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
				<ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/steps:rotate-90" />
				<span className="flex -space-x-1">
					{names.slice(0, 5).map((nm) => {
						const I = toolIcon(nm);
						return (
							<span key={nm} className="flex size-5 items-center justify-center rounded-full border bg-background">
								<I className="size-3" />
							</span>
						);
					})}
				</span>
				<span>
					{tools.length ? `${tools.length} 次工具调用` : "思考"}
					{tools.length > 0 && <span className="ml-1.5 opacity-70">{names.slice(0, 4).join("、")}{names.length > 4 ? "…" : ""}</span>}
				</span>
				{errors > 0 && <span className="flex items-center gap-1 text-destructive"><TriangleAlert className="size-3" />{errors}</span>}
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-1 flex flex-col gap-1 border-l pl-4 ml-1.5">
				{nodes.map((n) =>
					n.k === "tool" ? (
						<ToolCall key={n.uuid} t={n} project={project} session={session} agent={agent} onAgent={onAgent} />
					) : n.k === "thinking" ? (
						<Collapsible key={n.uuid}>
							<CollapsibleTrigger className="flex items-center gap-2 py-1 text-xs text-muted-foreground hover:text-foreground">
								<Brain className="size-3.5" />
								思考
							</CollapsibleTrigger>
							<CollapsibleContent className="pb-2 pl-5 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{n.text}</CollapsibleContent>
						</Collapsible>
					) : null,
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}

function ToolCall({ t, project, session, agent, onAgent }: { t: ToolNode; project: string; session: string; agent?: string; onAgent?: (id: string) => void }) {
	const I = toolIcon(t.name);
	const [full, setFull] = useState<string | null>(null);
	const more = async () => {
		const r = await api<{ text: string }>(`/api/sessions/${enc(project)}/${enc(session)}/result/${t.id}${agent ? `?agent=${agent}` : ""}`);
		setFull(r.text);
	};
	return (
		<Collapsible>
			<div className="flex items-center gap-2">
				<CollapsibleTrigger className="group/tool flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-[13px] hover:text-foreground">
					<I className={cn("size-3.5 shrink-0", t.result?.error ? "text-destructive" : "text-muted-foreground")} />
					<span className="shrink-0 font-medium">{toolName(t.name)}</span>
					<span className="truncate font-mono text-xs text-muted-foreground">{t.summary}</span>
				</CollapsibleTrigger>
				{t.agent && onAgent && (
					<Button variant="outline" size="sm" className="h-6 shrink-0 gap-1 px-2 text-[11px]" onClick={() => onAgent(t.agent as string)}>
						<Bot className="size-3" />
						子 agent 对话
					</Button>
				)}
			</div>
			<CollapsibleContent className="mb-2 flex flex-col gap-2 pl-5">
				<pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all">{t.input}</pre>
				{t.result && (
					<div className="flex flex-col gap-1">
						<pre className={cn("max-h-96 overflow-auto rounded-md border p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all", t.result.error ? "border-destructive/40 bg-destructive/5" : "bg-background")}>
							{full ?? t.result.text}
						</pre>
						{t.result.cut && full === null && (
							<Button variant="ghost" size="sm" className="h-6 self-start px-2 text-[11px]" onClick={more}>
								结果太长，只显示了开头：看完整的
							</Button>
						)}
					</div>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}
