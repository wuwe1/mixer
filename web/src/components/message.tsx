// 一条一条消息怎么画：你的消息（右边的气泡）、Claude 的回复（Markdown）、连在一起的工具调用和思考（收成一组，点开看）、
// 事件：小结、上下文压缩、系统提示是分隔线；后台任务的通知是一行；子代理的回报是一张卡片。都和人、Claude 说的话分开。
// 每条消息、每组工具调用后面几个图标按钮：复制、从这里分叉（回复、工具调用）、编辑并分叉（你的消息）。平时收着，指着、点一下那条才出现，
// 最后一条回复的常驻；手机上工具组的分叉常驻（点工具组是展开）。图片点了在当前页面放大。
import { Bell, Bot, Brain, Check, ChevronRight, CircleCheck, CircleX, Copy, FileDiff, FileText, Globe, GitFork, Info, Layers, ListChecks, Pencil, Search, SquareTerminal, Wrench, TriangleAlert } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Spawn } from "@/lib/agents";
import { api, enc, type Node, type ToolNode } from "@/lib/api";
import { clock, took } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Images } from "./lightbox";
import { Markdown } from "./markdown";
import { StatusIcon } from "./side";

const ICON: Record<string, typeof Wrench> = {
	Bash: SquareTerminal, Read: FileText, Write: Pencil, Edit: Pencil, MultiEdit: Pencil, NotebookEdit: Pencil, Grep: Search, Glob: Search,
	WebSearch: Globe, WebFetch: Globe, Agent: Bot, Task: Bot,
	// Codex 的
	exec_command: SquareTerminal, shell: SquareTerminal, write_stdin: SquareTerminal, apply_patch: Pencil, web_search: Globe, update_plan: ListChecks,
};
const toolIcon = (name: string) => ICON[name] ?? (name.startsWith("mcp__") ? Globe : Wrench);
const toolName = (name: string) => name.replace(/^mcp__[^_]+__/, "");

/** 从 since（毫秒）到现在多久：12 秒、2:13；每秒走一下 */
export function Elapsed({ since, className }: { since: number; className?: string }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	return <span className={cn("tabular-nums", className)}>{took(now - since)}</span>;
}

/** 一组里正在进行的那一步（执行中的工具、正在写的思考）和它开始的时间 */
export type Now = { node: Node; since: number };

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

export const UserMessage = memo(function UserMessage({ n, project, session, onFork }: { n: Extract<Node, { k: "user" }>; project: string; session: string; onFork?: (n: Extract<Node, { k: "user" }>) => void }) {
	return (
		<div id={`n-${n.uuid}`} tabIndex={-1} className="group flex scroll-mt-24 flex-col items-end gap-1.5 outline-none">
			<div className="max-w-[88%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-secondary-foreground">
				{n.text || (n.images ? "" : "（空）")}
				{n.images > 0 && <Images className="mt-2" srcs={Array.from({ length: n.images }, (_, i) => `/api/sessions/${enc(project)}/${enc(session)}/image/${n.uuid}/${i}`)} />}
			</div>
			<div className="flex items-center gap-2 px-1 text-2xs text-muted-foreground">
				{n.queued && <Badge variant="outline" className="h-4 px-1.5 text-2xs" title="运行中发的，插进了这次运行">排队</Badge>}
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

const AgentButton = ({ id, onAgent, className }: { id?: string; onAgent?: (id: string) => void; className?: string }) =>
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
});

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
	const tools = nodes.filter((n): n is ToolNode => n.k === "tool");
	const errors = tools.filter((t) => t.result?.error).length;
	const names = [...new Set(tools.map((t) => toolName(t.name)))];
	const imgs = tools.flatMap((t) => resultImages(t, project, session, agent));
	// 只有思考的一组：正在想的时候不另起一行，标题上直接带 ping 点、最新一句和耗时
	const thinking = !tools.length && now?.node.k === "thinking" ? now : null;
	const running = now && !thinking ? now : null;
	const lastTool = tools[tools.length - 1];
	const shown = running?.node ?? (lastTool?.result ? lastTool : null);
	// 还在跑的子代理：收着的时候每个都露出来（最多 3 个），各带一行它在做什么；露出来的最后一步要是其中之一，就不再另画
	const subs = spawns ? tools.filter((t) => spawns.get(t.id)?.running) : [];
	const shownSub = shown?.k === "tool" && subs.includes(shown);
	const shownAgent = shown?.k === "tool" && spawns ? (shown.agent ?? spawns.get(shown.id)?.agentId ?? null) : null;
	// 跑完了、没有在跑的子代理：收着时只一行，就是最后那一步（几次调用、几个出错跟在后面）；展开了这一行换回「N 次工具调用」
	const flat = !running && !thinking && !subs.length && shown?.k === "tool" ? shown : null;
	const label = (
		<span className={cn(flat && "hidden group-data-[state=open]/stepbox:inline")}>
			{tools.length ? `${tools.length} 次工具调用` : "思考"}
			{tools.length > 0 && <span className="ml-1.5 opacity-70">{names.slice(0, 4).join("、")}{names.length > 4 ? "…" : ""}</span>}
		</span>
	);
	return (
		<Collapsible id={`n-${nodes[0].uuid}`} className="group/stepbox scroll-mt-24">
			<div className="flex items-center gap-1">
			<CollapsibleTrigger className="group/steps flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
				<ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/steps:rotate-90" />
				{thinking ? (
					<>
						<StatusIcon s="running" className="size-3.5" />
						<span className="shrink-0">思考</span>
						<span className="min-w-0 truncate opacity-70 group-data-[state=open]/stepbox:hidden">{latest(thinking.node)}</span>
						<Elapsed since={thinking.since} className="ml-auto shrink-0 text-2xs" />
					</>
				) : flat ? (
					<>
						<span className="flex min-w-0 items-center gap-2 text-md text-foreground group-data-[state=open]/stepbox:hidden">
							<StatusIcon s={flat.result?.error ? "failed" : "ok"} className="size-3.5" />
							<span className="shrink-0 font-medium">{toolName(flat.name)}</span>
							<span className="truncate font-mono text-xs text-muted-foreground">{flat.summary}</span>
						</span>
						{label}
						{tools.length > 1 && <span className="shrink-0 tabular-nums opacity-70 group-data-[state=open]/stepbox:hidden">{tools.length} 次</span>}
					</>
				) : (
					label
				)}
				{errors > (flat?.result?.error && tools.length === 1 ? 1 : 0) && <span className="flex shrink-0 items-center gap-1 text-destructive"><TriangleAlert className="size-3" />{errors}</span>}
			</CollapsibleTrigger>
			{flat && shownAgent && onAgent && <Action icon={Bot} label="看子代理的对话" onClick={() => onAgent(shownAgent)} />}
			{onFork && (
				<span className="md:invisible md:group-hover/stepbox:visible md:group-focus-within/stepbox:visible">
					<Action icon={GitFork} label="从这里分叉" onClick={() => onFork(nodes)} />
				</span>
			)}
			</div>
			{spawns && subs.slice(0, 3).map((t) => <SpawnRow key={t.id} t={t} s={spawns.get(t.id) as Spawn} onAgent={onAgent} />)}
			{subs.length > 3 && <div className="py-1 pl-5.5 text-xs text-muted-foreground group-data-[state=open]/stepbox:hidden">还有 {subs.length - 3} 个</div>}
			{/* 收着的时候最后一步也露出来：在跑是蓝点带耗时，跑完了留着，成功绿点、失败红点 */}
			{shown && !shownSub && !flat && (
				// 跑完的子代理也留着这一行，点了看它的对话
				<button type="button" disabled={!shownAgent || !onAgent} onClick={() => shownAgent && onAgent?.(shownAgent)} className="flex w-full min-w-0 items-center gap-2 py-1 pl-5.5 text-left text-md group-data-[state=open]/stepbox:hidden" title={shownAgent ? "看子代理的对话" : undefined}>
					<StatusIcon s={running ? "running" : shown.k === "tool" && shown.result?.error ? "failed" : "ok"} className="size-3.5" />
					<span className="shrink-0 font-medium">{shown.k === "tool" ? toolName(shown.name) : "思考"}</span>
					{shown.k === "tool" ? <span className="truncate font-mono text-xs text-muted-foreground">{shown.summary}</span> : <span className="truncate text-muted-foreground">{latest(shown)}</span>}
					{running && <Elapsed since={running.since} className="ml-auto shrink-0 text-2xs text-muted-foreground" />}
				</button>
			)}
			{/* 收着的时候图片也露出来；展开了就跟着各自的工具调用 */}
			{imgs.length > 0 && <Images srcs={imgs} className="mt-1 mb-1 pl-5.5 group-data-[state=open]/stepbox:hidden" />}
			<CollapsibleContent className="mt-1 flex flex-col gap-1 border-l pl-4 ml-1.5">
				{nodes.map((n) =>
					n.k === "tool" ? (
						<ToolCall key={stable(n)} t={n} project={project} session={session} agent={agent} onAgent={onAgent} onFile={onFile} since={now?.node === n ? now.since : undefined} spawn={spawns?.get(n.id)} />
					) : n.k === "thinking" ? (
						<Thought key={stable(n)} n={n} project={project} session={session} agent={agent} live={now?.node === n} bare={!tools.length} />
					) : null,
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}, sameSteps);

/** 收着的组里一个还在跑的子代理：开它的那个调用（ping 点、耗时），下面一行它在做什么。点了看它的对话 */
function SpawnRow({ t, s, onAgent }: { t: ToolNode; s: Spawn; onAgent?: (id: string) => void }) {
	const id = s.agentId;
	return (
		<button type="button" disabled={!id || !onAgent} onClick={() => id && onAgent?.(id)} className="flex w-full min-w-0 flex-col py-1 pl-5.5 text-left group-data-[state=open]/stepbox:hidden" title="看子代理的对话">
			<span className="flex min-w-0 items-center gap-2 text-md">
				<StatusIcon s="running" className="size-3.5" />
				<span className="shrink-0 font-medium">{toolName(t.name)}</span>
				<span className="truncate font-mono text-xs text-muted-foreground">{t.summary}</span>
				<Elapsed since={s.since} className="ml-auto shrink-0 pl-2 text-2xs text-muted-foreground" />
			</span>
			{s.latest && <span className="block truncate pl-5.5 text-xs text-muted-foreground">{s.latest}</span>}
		</button>
	);
}

/** 思考写到哪了：最后一句（摘要是一段一段来的）。只用在正在写的上（流里的，是全文） */
const latest = (n: Node) => (n.k === "thinking" ? (n.text.trim().split("\n").filter((l) => l.trim()).pop() ?? "") : "");

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

/** 改文件的工具：它碰的文件能在右边的面板里打开 */
const EDITS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const filePath = (t: ToolNode) => {
	if (!EDITS.has(t.name) && t.name !== "Read") return null;
	const m = /"(?:file_path|notebook_path)": "((?:[^"\\]|\\.)*)"/.exec(t.input);
	if (!m) return null;
	try { return JSON.parse(`"${m[1]}"`) as string; } catch { return null; }
};
export const edited = (t: ToolNode) => (EDITS.has(t.name) ? filePath(t) : null);

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
	const file = onFile ? filePath(t) : null;
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
	const more = async () => {
		const r = await api<{ text: string }>(`/api/sessions/${enc(project)}/${enc(session)}/result/${t.id}${agent ? `?agent=${agent}` : ""}`);
		setFull(r.text);
	};
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<div className="flex items-center gap-2">
				<CollapsibleTrigger className="group/tool flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-md hover:text-foreground">
					{since !== undefined ? <StatusIcon s="running" className="size-3.5" /> : <I className={cn("size-3.5 shrink-0", t.result?.error ? "text-destructive" : "text-muted-foreground")} />}
					<span className="shrink-0 font-medium">{toolName(t.name)}</span>
					<span className="truncate font-mono text-xs text-muted-foreground">{t.summary}</span>
					{since !== undefined && <Elapsed since={since} className="ml-auto shrink-0 pl-2 text-2xs text-muted-foreground" />}
				</CollapsibleTrigger>
				{file && onFile && (
					<Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" onClick={() => onFile(file, EDITS.has(t.name))} aria-label={EDITS.has(t.name) ? "查看改动" : "查看文件"} title={EDITS.has(t.name) ? "在右边看这个文件的改动" : "在右边打开这个文件"}>
						{EDITS.has(t.name) ? <FileDiff className="size-3.5" /> : <FileText className="size-3.5" />}
					</Button>
				)}
				{sub && onAgent && (
					<Button variant="outline" size="xs" className="shrink-0" onClick={() => onAgent(sub)}>
						<Bot className="size-3" />
						子代理对话
					</Button>
				)}
			</div>
			{spawn?.running && spawn.latest && (
				<button type="button" disabled={!sub || !onAgent} onClick={() => sub && onAgent?.(sub)} className="block w-full truncate pb-1 pl-5.5 text-left text-xs text-muted-foreground enabled:hover:text-foreground" title="看子代理的对话">
					{spawn.latest}
				</button>
			)}
			{imgs.length > 0 && <Images srcs={imgs} className="mb-2 pl-5.5" />}
			<CollapsibleContent className="mb-2 flex flex-col gap-2 pl-5">
				<pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all">{detail?.input ?? t.input}</pre>
				{t.result && !onlyImages && (
					<div className="flex flex-col gap-1">
						<pre className={cn("max-h-96 overflow-auto rounded-md border p-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all", t.result.error ? "border-destructive/40 bg-destructive/5" : "bg-background")}>
							{full ?? detail?.result ?? t.result.text}
						</pre>
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
