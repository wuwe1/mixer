// 一条一条消息怎么画：你的消息（右边的气泡）、Claude 的回复（Markdown）、连在一起的工具调用和思考（收成一组，点开看）、
// 事件：小结、上下文压缩、系统提示是分隔线；后台任务的通知是一行；子代理的回报是一张卡片。都和人、Claude 说的话分开。
// 每条消息、每组工具调用后面常驻几个图标按钮：复制、从这里分叉（回复、工具调用）、编辑并分叉（你的消息）。图片点了在当前页面放大。
import { Bell, Bot, Brain, Check, ChevronRight, CircleCheck, CircleX, Copy, FileDiff, FileText, Globe, GitFork, Info, Layers, Pencil, Search, SquareTerminal, Wrench, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api, enc, type Node, type ToolNode } from "@/lib/api";
import { clock } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Images } from "./lightbox";
import { Markdown } from "./markdown";

const ICON: Record<string, typeof Wrench> = {
	Bash: SquareTerminal, Read: FileText, Write: Pencil, Edit: Pencil, MultiEdit: Pencil, NotebookEdit: Pencil, Grep: Search, Glob: Search,
	WebSearch: Globe, WebFetch: Globe, Agent: Bot, Task: Bot,
};
const toolIcon = (name: string) => ICON[name] ?? (name.startsWith("mcp__") ? Globe : Wrench);
const toolName = (name: string) => name.replace(/^mcp__[^_]+__/, "");

/** 消息后面的小图标按钮 */
function Action({ icon: I, label, onClick }: { icon: typeof Wrench; label: string; onClick: () => void }) {
	return (
		<Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" onClick={onClick} aria-label={label} title={label}>
			<I className="size-3.5" />
		</Button>
	);
}

/** 复制：成功了图标变成对勾，一会儿变回来 */
function CopyAction({ text }: { text: string }) {
	const [done, setDone] = useState(false);
	const copy = () =>
		navigator.clipboard.writeText(text).then(
			() => { setDone(true); setTimeout(() => setDone(false), 1500); },
			() => toast.error("复制失败"),
		);
	return <Action icon={done ? Check : Copy} label={done ? "已复制" : "复制"} onClick={copy} />;
}

export function UserMessage({ n, project, session, onFork }: { n: Extract<Node, { k: "user" }>; project: string; session: string; onFork?: (n: Extract<Node, { k: "user" }>) => void }) {
	return (
		<div id={`n-${n.uuid}`} tabIndex={-1} className="group flex scroll-mt-24 flex-col items-end gap-1.5 outline-none">
			<div className="max-w-[88%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-secondary-foreground">
				{n.text || (n.images ? "" : "（空）")}
				{n.images > 0 && <Images className="mt-2" srcs={Array.from({ length: n.images }, (_, i) => `/api/sessions/${enc(project)}/${enc(session)}/image/${n.uuid}/${i}`)} />}
			</div>
			<div className="flex items-center gap-2 px-1 text-2xs text-muted-foreground">
				{n.queued && <Badge variant="outline" className="h-4 px-1.5 text-2xs" title="Claude 运行中发送，排队后插入">排队</Badge>}
				<span className="tabular-nums">{clock(n.ts)}</span>
				<span className="flex items-center">
					<CopyAction text={n.text} />
					{onFork && <Action icon={Pencil} label="编辑并分叉" onClick={() => onFork(n)} />}
				</span>
			</div>
		</div>
	);
}

export function AssistantMessage({ n, onFork }: { n: Extract<Node, { k: "assistant" }>; onFork?: (n: Extract<Node, { k: "assistant" }>) => void }) {
	return (
		<div id={`n-${n.uuid}`} tabIndex={-1} className="group flex scroll-mt-24 flex-col gap-1 outline-none">
			<Markdown text={n.text} />
			<div className="-my-1 flex items-center self-end">
				<CopyAction text={n.text} />
				{onFork && <Action icon={GitFork} label="从这里分叉" onClick={() => onFork(n)} />}
			</div>
		</div>
	);
}

type Ev = Extract<Node, { k: "event" }>;
const TASK_STATUS: Record<string, string> = { completed: "完成", failed: "失败", killed: "已停止" };

const AgentButton = ({ id, onAgent, className }: { id?: string; onAgent?: (id: string) => void; className?: string }) =>
	id && onAgent ? (
		<Button variant="outline" size="sm" className={cn("h-6 shrink-0 gap-1 px-2 text-2xs", className)} onClick={() => onAgent(id)}>
			<Bot className="size-3" />
			子代理对话
		</Button>
	) : null;

/** 事件：小结、上下文压缩、系统提示画成分隔线（压缩的能点开看摘要）；后台任务、子代理回报单独画 */
export function EventLine({ n, onAgent }: { n: Ev; onAgent?: (id: string) => void }) {
	if (n.kind === "task") return <TaskNotice n={n} onAgent={onAgent} />;
	if (n.kind === "agent") return <AgentReport n={n} onAgent={onAgent} />;
	const I = n.kind === "compact" ? Layers : n.kind === "info" ? Info : null;
	const line = (
		<>
			<span className="h-px flex-1 bg-border" />
			<span className="flex max-w-[80%] items-center gap-1.5 text-center">
				{I && <I className="size-3.5 shrink-0" />}
				<span>{n.kind === "summary" ? `小结：${n.text}` : n.text}</span>
				{n.detail && <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/ev:rotate-90" />}
			</span>
			<span className="h-px flex-1 bg-border" />
		</>
	);
	if (!n.detail) return <div id={`n-${n.uuid}`} className="flex items-center gap-3 py-1 text-xs text-muted-foreground">{line}</div>;
	return (
		<Collapsible id={`n-${n.uuid}`} className="group/ev">
			<CollapsibleTrigger className="flex w-full items-center gap-3 py-1 text-xs text-muted-foreground hover:text-foreground" title="点开看摘要">{line}</CollapsibleTrigger>
			<CollapsibleContent className="mt-2 max-h-96 overflow-auto rounded-lg border bg-muted/30 p-3">
				<Markdown text={n.detail} />
			</CollapsibleContent>
		</Collapsible>
	);
}

/** 后台任务（子代理、后台命令）的通知：一行，点开看结果 */
function TaskNotice({ n, onAgent }: { n: Ev; onAgent?: (id: string) => void }) {
	const ok = n.status === "completed";
	const bad = n.status === "failed" || n.status === "killed";
	const I = ok ? CircleCheck : bad ? CircleX : Bell;
	return (
		<Collapsible id={`n-${n.uuid}`} className="group/ev">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<CollapsibleTrigger disabled={!n.detail} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left enabled:hover:text-foreground">
					<I className={cn("size-3.5 shrink-0", bad && "text-destructive")} />
					<span className="shrink-0 font-medium">后台任务{n.status ? ` · ${TASK_STATUS[n.status] ?? n.status}` : ""}</span>
					<span className="truncate">{n.text}</span>
					{n.detail && <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/ev:rotate-90" />}
				</CollapsibleTrigger>
				<AgentButton id={n.agent} onAgent={onAgent} />
			</div>
			{n.detail && (
				<CollapsibleContent className="mt-1 ml-5.5 max-h-96 overflow-auto rounded-lg border bg-muted/30 p-3">
					<Markdown text={n.detail} />
				</CollapsibleContent>
			)}
		</Collapsible>
	);
}

/** 子代理发回来的回报：一张卡片，标明是子代理说的；长的先收着 */
function AgentReport({ n, onAgent }: { n: Ev; onAgent?: (id: string) => void }) {
	const long = n.text.length > 600 || n.text.split("\n").length > 12;
	const [open, setOpen] = useState(false);
	return (
		<div id={`n-${n.uuid}`} className="overflow-hidden rounded-xl border bg-card">
			<div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
				<Bot className="size-3.5" />
				<span className="font-medium">子代理回报</span>
				<span className="tabular-nums">{clock(n.ts)}</span>
				<AgentButton id={n.agent} onAgent={onAgent} className="ml-auto" />
			</div>
			<div className={cn("relative px-3 py-2", long && !open && "max-h-48 overflow-hidden")}>
				<Markdown text={n.text} />
				{long && !open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-card" />}
			</div>
			{long && (
				<button type="button" onClick={() => setOpen((o) => !o)} className="w-full border-t px-3 py-1.5 text-left text-2xs text-muted-foreground hover:text-foreground">
					{open ? "收起" : "展开全部"}
				</button>
			)}
		</div>
	);
}

/** 连在一起的工具调用、思考：收成一组，默认只显示一行概览 */
type OnFile = (path: string, diff: boolean) => void;

/** 工具结果里的图片（读图片文件、截图） */
const resultImages = (t: ToolNode, project: string, session: string, agent?: string) =>
	Array.from({ length: t.result?.images ?? 0 }, (_, i) => `/api/sessions/${enc(project)}/${enc(session)}/image/${t.id}/${i}${agent ? `?agent=${agent}` : ""}`);

export function Steps({ nodes, project, session, agent, onAgent, onFile, onFork }: { nodes: Node[]; project: string; session: string; agent?: string; onAgent?: (id: string) => void; onFile?: OnFile; onFork?: (nodes: Node[]) => void }) {
	const tools = nodes.filter((n): n is ToolNode => n.k === "tool");
	const errors = tools.filter((t) => t.result?.error).length;
	const names = [...new Set(tools.map((t) => toolName(t.name)))];
	const imgs = tools.flatMap((t) => resultImages(t, project, session, agent));
	return (
		<Collapsible id={`n-${nodes[0].uuid}`} className="group/stepbox scroll-mt-24">
			<div className="flex items-center gap-1">
			<CollapsibleTrigger className="group/steps flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
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
			{onFork && <Action icon={GitFork} label="从这里分叉" onClick={() => onFork(nodes)} />}
			</div>
			{/* 收着的时候图片也露出来；展开了就跟着各自的工具调用 */}
			{imgs.length > 0 && <Images srcs={imgs} className="mt-1 mb-1 pl-5.5 group-data-[state=open]/stepbox:hidden" />}
			<CollapsibleContent className="mt-1 flex flex-col gap-1 border-l pl-4 ml-1.5">
				{nodes.map((n) =>
					n.k === "tool" ? (
						<ToolCall key={n.uuid} t={n} project={project} session={session} agent={agent} onAgent={onAgent} onFile={onFile} />
					) : n.k === "thinking" ? (
						<Collapsible key={n.uuid}>
							<CollapsibleTrigger className="flex items-center gap-2 py-1 text-xs text-muted-foreground hover:text-foreground">
								<Brain className="size-3.5" />
								思考
							</CollapsibleTrigger>
							<CollapsibleContent className="pb-2 pl-5 text-md leading-relaxed whitespace-pre-wrap text-muted-foreground">{n.text}</CollapsibleContent>
						</Collapsible>
					) : null,
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}

/** 改文件的工具：它碰的文件能在右边的面板里打开 */
const EDITS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const filePath = (t: ToolNode) => {
	if (!EDITS.has(t.name) && t.name !== "Read") return null;
	const m = /"(?:file_path|notebook_path)": "((?:[^"\\]|\\.)*)"/.exec(t.input);
	if (!m) return null;
	try { return JSON.parse(`"${m[1]}"`) as string; } catch { return null; }
};
export const edited = (t: ToolNode) => (EDITS.has(t.name) ? filePath(t) : null);

function ToolCall({ t, project, session, agent, onAgent, onFile }: { t: ToolNode; project: string; session: string; agent?: string; onAgent?: (id: string) => void; onFile?: OnFile }) {
	const I = toolIcon(t.name);
	const file = onFile ? filePath(t) : null;
	const [full, setFull] = useState<string | null>(null);
	const imgs = resultImages(t, project, session, agent);
	// 只有图片的结果（读一张图）：文字部分就是「[图片]」，不用再显示
	const onlyImages = imgs.length > 0 && !t.result?.text.replace(/\[图片\]/g, "").trim();
	const more = async () => {
		const r = await api<{ text: string }>(`/api/sessions/${enc(project)}/${enc(session)}/result/${t.id}${agent ? `?agent=${agent}` : ""}`);
		setFull(r.text);
	};
	return (
		<Collapsible>
			<div className="flex items-center gap-2">
				<CollapsibleTrigger className="group/tool flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-md hover:text-foreground">
					<I className={cn("size-3.5 shrink-0", t.result?.error ? "text-destructive" : "text-muted-foreground")} />
					<span className="shrink-0 font-medium">{toolName(t.name)}</span>
					<span className="truncate font-mono text-xs text-muted-foreground">{t.summary}</span>
				</CollapsibleTrigger>
				{file && onFile && (
					<Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" onClick={() => onFile(file, EDITS.has(t.name))} aria-label={EDITS.has(t.name) ? "查看改动" : "查看文件"} title={EDITS.has(t.name) ? "在右边看这个文件的改动" : "在右边打开这个文件"}>
						{EDITS.has(t.name) ? <FileDiff className="size-3.5" /> : <FileText className="size-3.5" />}
					</Button>
				)}
				{t.agent && onAgent && (
					<Button variant="outline" size="xs" className="shrink-0 text-2xs" onClick={() => onAgent(t.agent as string)}>
						<Bot className="size-3" />
						子代理对话
					</Button>
				)}
			</div>
			{imgs.length > 0 && <Images srcs={imgs} className="mb-2 pl-5.5" />}
			<CollapsibleContent className="mb-2 flex flex-col gap-2 pl-5">
				<pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all">{t.input}</pre>
				{t.result && !onlyImages && (
					<div className="flex flex-col gap-1">
						<pre className={cn("max-h-96 overflow-auto rounded-md border p-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all", t.result.error ? "border-destructive/40 bg-destructive/5" : "bg-background")}>
							{full ?? t.result.text}
						</pre>
						{t.result.cut && full === null && (
							<Button variant="ghost" size="xs" className="self-start text-2xs" onClick={more}>
								显示完整结果
							</Button>
						)}
					</div>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}
