// 一条一条消息怎么画：你的消息（右边的气泡）、Claude 的回复（Markdown）、连在一起的工具调用和思考（收成一组，点开看）、
// 事件：小结、上下文压缩、系统提示是分隔线；后台任务的通知是一行；子代理的回报是一张卡片。都和人、Claude 说的话分开。
// 每条消息、每组工具调用后面几个图标按钮：复制、从这里分叉（回复、工具调用）、编辑并分叉（你的消息）。平时收着，指着、点一下那条才出现，
// 最后一条回复的常驻；手机上工具组的分叉常驻（点工具组是展开）。图片点了在当前页面放大。
import { Bell, Bot, Brain, Check, ChevronRight, CircleCheck, CircleStop, CircleX, Copy, FileDiff, FileText, Globe, GitFork, Info, Layers, Pencil, Search, SquareTerminal, Wrench, TriangleAlert } from "lucide-react";
import { type ComponentProps, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import type { Spawn } from "@/lib/agents";
import { api, enc, type Node, type ToolNode } from "@shared/api";
import { exposed, type Line, type Now, type Row, toolName } from "@/lib/steps";
import { clock, took } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Images } from "./lightbox";
import { Markdown } from "./markdown";
import { StatusIcon } from "./side";

const ICON: Record<string, typeof Wrench> = {
	Bash: SquareTerminal, Read: FileText, Write: Pencil, Edit: Pencil, MultiEdit: Pencil, NotebookEdit: Pencil, Grep: Search, Glob: Search,
	WebSearch: Globe, WebFetch: Globe, Agent: Bot, Task: Bot,
};
const toolIcon = (name: string) => ICON[name] ?? (name.startsWith("mcp__") ? Globe : Wrench);

/** 从 since（毫秒）到现在多久：12 秒、2:13；每秒走一下 */
export function Elapsed({ since, className }: { since: number; className?: string }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	return <span className={cn("tabular-nums", className)}>{took(now - since)}</span>;
}

export type { Now };

/** 指着、点一下（消息自己能拿焦点）才出现；藏起来时不占地方，时间贴着右边 */
const reveal = "hidden group-hover:flex group-focus-within:flex";

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

/** 你的消息的气泡（带图）；queued：排着队、还没发出，虚线框 */
export function Bubble({ text, srcs, queued }: { text: string; srcs: string[]; queued?: boolean }) {
	return (
		<div className={cn("max-w-[88%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-secondary-foreground", queued && "border border-dashed bg-secondary/50")}>
			{text || (srcs.length ? "" : "（空）")}
			{srcs.length > 0 && <Images className={text.trim() ? "mt-2" : undefined} srcs={srcs} />}
		</div>
	);
}

/** 你的消息带的图：第几张一个地址 */
export const userImages = (project: string, session: string, n: Extract<Node, { k: "user" }>) => Array.from({ length: n.images }, (_, i) => `/api/sessions/${enc(project)}/${enc(session)}/image/${n.uuid}/${i}`);

export const UserMessage = memo(function UserMessage({ n, project, session, onFork }: { n: Extract<Node, { k: "user" }>; project: string; session: string; onFork?: (n: Extract<Node, { k: "user" }>) => void }) {
	return (
		<div id={`n-${n.uuid}`} tabIndex={-1} className="group flex scroll-mt-24 flex-col items-end gap-1.5 outline-none">
			<Bubble text={n.text} srcs={userImages(project, session, n)} />
			<div className="flex items-center gap-2 px-1 text-2xs text-muted-foreground">
				{n.queued && <Badge variant="outline" className="h-4 px-1.5 text-2xs" title="运行中发的，插进了这次运行">中途插入</Badge>}
				<span className="tabular-nums">{clock(n.ts)}</span>
				<span className={cn("items-center", reveal)}>
					<CopyAction text={n.text} />
					{onFork && <Action icon={Pencil} label="编辑并分叉" onClick={() => onFork(n)} />}
				</span>
			</div>
		</div>
	);
});

/** spent：从你发出这一轮的消息到这条回复用了多久（毫秒）；还在写的不显示。last：对话最后一条，复制、分叉常驻 */
export const AssistantMessage = memo(function AssistantMessage({ n, spent, onFork, last }: { n: Extract<Node, { k: "assistant" }>; spent?: number; onFork?: (n: Extract<Node, { k: "assistant" }>) => void; last?: boolean }) {
	return (
		<div id={`n-${n.uuid}`} tabIndex={-1} className="group flex scroll-mt-24 flex-col gap-1 outline-none">
			<Markdown text={n.text} />
			<div className="-my-1 flex items-center self-end">
				{spent !== undefined && <span className="px-1 text-2xs tabular-nums text-muted-foreground" title="从你发出消息到这条回复">{took(spent)}</span>}
				<span className={cn("items-center", last ? "flex" : reveal)}>
					<CopyAction text={n.text} />
					{onFork && <Action icon={GitFork} label="从这里分叉" onClick={() => onFork(n)} />}
				</span>
			</div>
		</div>
	);
});

type Ev = Extract<Node, { k: "event" }>;
const TASK_STATUS: Record<string, string> = { completed: "完成", failed: "失败", killed: "已停止" };

/** 打开子代理的对话：一律这个按钮（或者点那一行） */
const AgentButton = ({ id, onAgent, className }: { id?: string | null; onAgent?: (id: string) => void; className?: string }) =>
	id && onAgent ? (
		<Button variant="outline" size="xs" className={cn("shrink-0", className)} onClick={() => onAgent(id)}>
			<Bot className="size-3" />
			子代理对话
		</Button>
	) : null;

/** 事件：小结、上下文压缩、系统提示画成分隔线（压缩的能点开看摘要）；后台任务、子代理回报单独画 */
export const EventLine = memo(function EventLine({ n, onAgent }: { n: Ev; onAgent?: (id: string) => void }) {
	if (n.kind === "task") return <TaskNotice n={n} onAgent={onAgent} />;
	if (n.kind === "agent") return <AgentReport n={n} onAgent={onAgent} />;
	if (n.kind === "error")
		return (
			<div id={`n-${n.uuid}`} className="flex items-start gap-2 rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
				<TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
				<span className="min-w-0 flex-1 break-words">出错了：{n.text}</span>
			</div>
		);
	if (n.kind === "retry")
		return (
			<div id={`n-${n.uuid}`} className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
				<Spinner />
				<span className="min-w-0 flex-1 break-words">{n.text}</span>
			</div>
		);
	const I = n.kind === "compact" ? Layers : n.kind === "info" ? Info : null;
	const line = (
		<>
			<span className="h-px flex-1 bg-border" />
			<span className="flex max-w-[80%] items-center gap-1.5 text-center">
				{n.detail && <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/ev:rotate-90" />}
				{I && <I className="size-3.5 shrink-0" />}
				<span>{n.kind === "summary" ? `小结：${n.text}` : n.text}</span>
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
});

/** 后台任务（子代理、后台命令）的通知：一行，点开看结果。› 在最左边，没有结果的留着空位，图标和工具组的对齐 */
function TaskNotice({ n, onAgent }: { n: Ev; onAgent?: (id: string) => void }) {
	// 红只给出错的；人停掉的（killed）是灰的
	const failed = n.status === "failed";
	const I = n.status === "completed" ? CircleCheck : failed ? CircleX : n.status === "killed" ? CircleStop : Bell;
	return (
		<Collapsible id={`n-${n.uuid}`} className="group/ev">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<CollapsibleTrigger disabled={!n.detail} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left enabled:hover:text-foreground">
					<ChevronRight className={cn("size-3.5 shrink-0 transition-transform group-data-[state=open]/ev:rotate-90", !n.detail && "invisible")} />
					<I className={cn("size-3.5 shrink-0", failed && "text-destructive")} />
					<span className="shrink-0 font-medium">后台任务{n.status ? ` · ${TASK_STATUS[n.status] ?? n.status}` : ""}</span>
					<span className="truncate">{n.text}</span>
				</CollapsibleTrigger>
				<AgentButton id={n.agent} onAgent={onAgent} />
			</div>
			{n.detail && (
				<CollapsibleContent className="mt-1 ml-11 max-h-96 overflow-auto rounded-lg border bg-muted/30 p-3">
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

/**
 * React 的 key。正在写的那段（uuid 是 live:…）写进记录后 uuid 就变了，「消息 id : 第几段」不变：按它认，
 * 换成记录里的那段时不会重新挂载，点开的不会收起、代码高亮不重来，往上翻着看的位置也不跳
 */
export const stable = (n: Node) => ("key" in n && n.key) || n.uuid;

/** spawns：组里有 Agent 调用时才给（别的组不跟着子代理的事件重画），开出来的子代理怎么样了（lib/agents.ts） */
type StepsProps = { nodes: Node[]; project: string; session: string; agent?: string; onAgent?: (id: string) => void; onFile?: OnFile; onFork?: (nodes: Node[]) => void; now?: Now | null; spawns?: Map<string, Spawn> };
/** nodes 每次都是重新拼的数组：按里面的节点比；别的按引用比 */
const sameSteps = (a: StepsProps, b: StepsProps) => {
	const { nodes: an, ...ar } = a;
	const { nodes: bn, ...br } = b;
	const ra = ar as Record<string, unknown>;
	const rb = br as Record<string, unknown>;
	return an.length === bn.length && an.every((n, i) => n === bn[i]) && Object.keys({ ...ra, ...rb }).every((k) => ra[k] === rb[k]);
};
export const Steps = memo(function Steps({ nodes, project, session, agent, onAgent, onFile, onFork, now, spawns }: StepsProps) {
	const bare = !nodes.some((n) => n.k === "tool");
	const imgs = nodes.flatMap((n) => (n.k === "tool" ? resultImages(n, project, session, agent) : []));
	// 收着时露出什么（lib/steps.ts）：在跑的那一步、在跑的子代理，不然最后一步；跑完了最后一步当标题，展开了换回「N 次工具调用」
	const { head, count, names, errors, rows } = exposed(nodes, now, spawns);
	const label = (
		<span className={cn(head.k === "step" && "hidden group-data-[state=open]/stepbox:inline")}>
			{count ? `${count} 次工具调用` : "思考"}
			{count > 0 && <span className="ml-1.5 opacity-70">{names.slice(0, 4).join("、")}{names.length > 4 ? "…" : ""}</span>}
		</span>
	);
	return (
		<Collapsible id={`n-${nodes[0].uuid}`} className="group/stepbox scroll-mt-24">
			<div className="flex items-center gap-1">
			<CollapsibleTrigger className="group/steps flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
				<ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/steps:rotate-90" />
				{head.k === "thinking" ? (
					<>
						<StatusIcon s="running" className="size-3.5" />
						<span className="shrink-0">思考</span>
						<span className="min-w-0 truncate opacity-70 group-data-[state=open]/stepbox:hidden">{head.text}</span>
						<Elapsed since={head.since} className="ml-auto shrink-0 text-2xs" />
					</>
				) : head.k === "step" ? (
					<>
						<LineView l={head.line} className="text-foreground group-data-[state=open]/stepbox:hidden" />
						{label}
						{count > 1 && <span className="shrink-0 tabular-nums opacity-70 group-data-[state=open]/stepbox:hidden">{count} 次</span>}
					</>
				) : (
					label
				)}
				{errors > 0 && <span className="flex shrink-0 items-center gap-1 text-destructive"><TriangleAlert className="size-3" />{errors}</span>}
			</CollapsibleTrigger>
			{head.k === "step" && <AgentButton id={head.line.agent} onAgent={onAgent} />}
			{onFork && (
				<span className="md:invisible md:group-hover/stepbox:visible md:group-focus-within/stepbox:visible">
					<Action icon={GitFork} label="从这里分叉" onClick={() => onFork(nodes)} />
				</span>
			)}
			</div>
			{rows.map((r) => <RowView key={r.key} r={r} onAgent={onAgent} />)}
			{/* 收着的时候图片也露出来；展开了就跟着各自的工具调用 */}
			{imgs.length > 0 && <Images srcs={imgs} className="mt-1 mb-1 pl-5.5 group-data-[state=open]/stepbox:hidden" />}
			<CollapsibleContent className="mt-1 flex flex-col gap-1 border-l pl-4 ml-1.5">
				{nodes.map((n) =>
					n.k === "tool" ? (
						<ToolCall key={stable(n)} t={n} project={project} session={session} agent={agent} onAgent={onAgent} onFile={onFile} since={now?.node === n ? now.since : undefined} spawn={spawns?.get(n.id)} />
					) : n.k === "thinking" ? (
						<Thought key={stable(n)} n={n} project={project} session={session} agent={agent} live={now?.node === n} bare={bare} />
					) : null,
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}, sameSteps);

const LineView = ({ l, className }: { l: Line; className?: string }) => (
	<StepLine mark={<StatusIcon s={l.mark} className="size-3.5" />} name={l.name} summary={l.summary} mono={l.mono} since={l.since} className={className} />
);

/**
 * 收着的组标题下面露出来的一行（展开了藏起来）。在跑的子代理：开它的那个调用（ping 点、耗时），下面一行它在做什么；
 * 最后一步：在跑是蓝点带耗时，跑完了留着，成功绿点、失败红点（跑完的子代理也留着这一行）。点了看子代理的对话
 */
function RowView({ r, onAgent }: { r: Row; onAgent?: (id: string) => void }) {
	if (r.k === "more") return <div className="py-1 pl-5.5 text-xs text-muted-foreground group-data-[state=open]/stepbox:hidden">还有 {r.n} 个</div>;
	const id = r.agent;
	const sub = r.k === "sub";
	return (
		<button type="button" disabled={!id || !onAgent} onClick={() => id && onAgent?.(id)} className={cn("w-full py-1 pl-5.5 text-left group-data-[state=open]/stepbox:hidden", sub ? "flex min-w-0 flex-col" : "block")} title={sub || id ? "看子代理的对话" : undefined}>
			<LineView l={r} />
			{sub && r.latest && <span className="block truncate pl-5.5 text-xs text-muted-foreground">{r.latest}</span>}
		</button>
	);
}

/** 一步（工具调用、思考）一行：标记或图标、名字、摘要（工具的是等宽小字）；在跑的带耗时 */
function StepLine({ mark, name, summary, mono = true, since, className }: { mark: ReactNode; name: string; summary: string; mono?: boolean; since?: number; className?: string }) {
	return (
		<span className={cn("flex min-w-0 items-center gap-2 text-md", className)}>
			{mark}
			<span className="shrink-0 font-medium">{name}</span>
			<span className={cn("truncate text-muted-foreground", mono && "font-mono text-xs")}>{summary}</span>
			{since !== undefined && <Elapsed since={since} className="ml-auto shrink-0 pl-2 text-2xs text-muted-foreground" />}
		</span>
	);
}

/** 代码、命令、输出：一律 12px、代码的行高；调用处只给 max-h-* 和出错的红 */
export function CodeBlock({ className, ...p }: ComponentProps<"pre">) {
	return <pre {...p} className={cn("overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-xs leading-code whitespace-pre-wrap break-all", className)} />;
}

/** 拿过的思考全文：「会话/uuid」→ 全文。记录只往后加，拿过的不会变 */
const thoughts = new Map<string, string>();

/**
 * 组里的一段思考：点开了就是要看，全文直接显示（收着时标题上已经滚着最新一句）。
 * 记录里的只有开头（cut）：组展开时才挂上，这时再拿全文，拿到之前先显示开头。
 * 正在写的那段写进记录后换成了开头：流里看到的全文先留着，不缩回去。
 * 只有思考的一组，标题就是「思考」、ping 点也在标题上：这里只放文字
 */
function Thought({ n, project, session, agent, live, bare }: { n: Extract<Node, { k: "thinking" }>; project: string; session: string; agent?: string; live: boolean; bare: boolean }) {
	const at = `${session}/${n.uuid}`;
	const [full, setFull] = useState(() => thoughts.get(at) ?? null);
	const seen = useRef(n.text);
	if (!n.cut) seen.current = n.text;
	useEffect(() => {
		if (!n.cut) return;
		const hit = thoughts.get(at);
		if (hit !== undefined) return void setFull(hit);
		let gone = false;
		api<{ text: string }>(`/api/sessions/${enc(project)}/${enc(session)}/thinking/${n.uuid}${agent ? `?agent=${agent}` : ""}`).then((r) => {
			thoughts.set(at, r.text);
			if (!gone) setFull(r.text);
		}, () => {});
		return () => { gone = true; };
	}, [n.cut, n.uuid, at, project, session, agent]);
	const text = n.cut ? (full ?? seen.current) : n.text;
	const body = <span className="min-w-0 whitespace-pre-wrap break-words">{text.trim() || "思考"}</span>;
	if (bare) return <div className="py-1 text-md leading-relaxed text-muted-foreground">{body}</div>;
	return (
		<div className="flex gap-2 py-1 text-md leading-relaxed text-muted-foreground">
			{live ? <StatusIcon s="running" className="mt-1 size-3.5 shrink-0" /> : <Brain className="mt-1 size-3.5 shrink-0" />}
			{body}
		</div>
	);
}

/** 点开时拿的：完整参数、结果（长的先给前 4000 字，cut 时可以再要完整的） */
type Detail = { input: string; result: string | null; cut: boolean };

/**
 * since：这一步正在执行（还没结果），从什么时候开始的。节点里的参数、结果只是预览，点开时拿完整的。
 * spawn：Agent 调用开出来的子代理；还在跑就带 ping 点、耗时，下面一行它在做什么，点了看它的对话
 */
function ToolCall({ t, project, session, agent, onAgent, onFile, since: at, spawn }: { t: ToolNode; project: string; session: string; agent?: string; onAgent?: (id: string) => void; onFile?: OnFile; since?: number; spawn?: Spawn }) {
	const since = at ?? (spawn?.running ? spawn.since : undefined);
	const sub = t.agent ?? spawn?.agentId ?? null;
	const I = toolIcon(t.name);
	// 它碰的文件能在右边的面板里打开：改了的看改动，读的看文件（服务端照参数、结果给的）
	const file = onFile ? (t.files?.[0] ?? t.file ?? null) : null;
	const diff = !!t.files?.length;
	const [full, setFull] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [detail, setDetail] = useState<Detail | null>(null);
	const done = !!t.result;
	useEffect(() => {
		// 正在写的（还没进记录）没得拿，就用流里的；点开时还在跑的，有了结果再拿一次
		if (!open || t.uuid.startsWith("live:")) return;
		let gone = false;
		api<Detail>(`/api/sessions/${enc(project)}/${enc(session)}/tool/${t.id}${agent ? `?agent=${agent}` : ""}`).then((d) => { if (!gone) setDetail(d); }, () => {});
		return () => { gone = true; };
	}, [open, done, t.id, t.uuid, project, session, agent]);
	const imgs = resultImages(t, project, session, agent);
	// 只有图片的结果（读一张图）：文字部分就是「[图片]」，不用再显示
	const onlyImages = imgs.length > 0 && !t.result?.text.replace(/\[图片\]/g, "").trim();
	const more = () =>
		api<{ text: string }>(`/api/sessions/${enc(project)}/${enc(session)}/result/${t.id}${agent ? `?agent=${agent}` : ""}`).then(
			(r) => setFull(r.text),
			(e: Error) => toast.error(`没拿到完整结果：${e.message}`),
		);
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<div className="flex items-center gap-2">
				<CollapsibleTrigger className="group/tool flex min-w-0 flex-1 rounded-md py-1 text-left hover:text-foreground">
					<StepLine
						mark={since !== undefined ? <StatusIcon s="running" className="size-3.5" /> : <I className={cn("size-3.5 shrink-0", t.result?.error ? "text-destructive" : "text-muted-foreground")} />}
						name={toolName(t.name)}
						summary={t.summary}
						since={since}
						className="flex-1"
					/>
				</CollapsibleTrigger>
				{file && onFile && (
					<Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" onClick={() => onFile(file, diff)} aria-label={diff ? "查看改动" : "查看文件"} title={diff ? "在右边看这个文件的改动" : "在右边打开这个文件"}>
						{diff ? <FileDiff className="size-3.5" /> : <FileText className="size-3.5" />}
					</Button>
				)}
				<AgentButton id={sub} onAgent={onAgent} />
			</div>
			{spawn?.running && spawn.latest && (
				<button type="button" disabled={!sub || !onAgent} onClick={() => sub && onAgent?.(sub)} className="block w-full truncate pb-1 pl-5.5 text-left text-xs text-muted-foreground enabled:hover:text-foreground" title="看子代理的对话">
					{spawn.latest}
				</button>
			)}
			{imgs.length > 0 && <Images srcs={imgs} className="mb-2 pl-5.5" />}
			<CollapsibleContent className="mb-2 flex flex-col gap-2 pl-5">
				<CodeBlock className="max-h-72">{detail?.input ?? t.input}</CodeBlock>
				{t.result && !onlyImages && (
					<div className="flex flex-col gap-1">
						<CodeBlock className={cn("max-h-96", t.result.error && "border-destructive/40 bg-destructive/5")}>{full ?? detail?.result ?? t.result.text}</CodeBlock>
						{(detail ? detail.cut : t.result.cut) && full === null && (
							<Button variant="ghost" size="xs" className="self-start" onClick={more}>
								显示完整结果
							</Button>
						)}
					</div>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}
