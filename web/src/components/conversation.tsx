// 对话：把节点树走成一条路（默认走到最新的那片叶子；地址里的 leaf 指定看哪个版本），一条消息改写过的地方放版本切换。
// 最后是正在跑的那次运行（实时的字）、这个会话等你确认的请求、输入框。
// 输入框只有两种做法：接着说（续接这个会话），或者分叉（开一个新会话，带着到某一处为止的上下文，原会话不动）。
// 能不能接着说看情况：在看旧版本、Claude 正在跑、终端里开着，都只能分叉。
import { ChevronLeft, ChevronRight, GitFork, Loader2, Send, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { type Agent, api, enc, type Node, type Run } from "@/lib/api";
import { useEvent } from "@/lib/events";
import { askNotify, type Status, useLive } from "@/lib/live";
import { go } from "@/lib/route";
import { clock } from "@/lib/time";
import { ApprovalCard } from "./approvals";
import { Markdown } from "./markdown";
import { AssistantMessage, EventLine, Steps, UserMessage } from "./message";

export type Tree = { kids: Map<string | null, Node[]>; best: Map<string, Node>; byId: Map<string, Node> };
export type Walk = ReturnType<typeof walk>;
type User = Extract<Node, { k: "user" }>;
type Said = Extract<Node, { k: "assistant" }>;

/** 子节点表；每个节点往下最新的那片叶子 */
export function tree(nodes: Node[]): Tree {
	const kids = new Map<string | null, Node[]>();
	const byId = new Map(nodes.map((n) => [n.uuid, n]));
	for (const n of nodes) {
		const p = n.parent && byId.has(n.parent) ? n.parent : null;
		kids.set(p, [...(kids.get(p) ?? []), n]);
	}
	const best = new Map<string, Node>();
	// 节点是按文件顺序来的，子节点总在父节点后面：倒着走一遍就能算出每个节点的最新叶子
	for (let i = nodes.length - 1; i >= 0; i--) {
		const n = nodes[i];
		const cs = kids.get(n.uuid) ?? [];
		let b: Node = n;
		for (const c of cs) {
			const cb = best.get(c.uuid) ?? c;
			if (cb.ts > b.ts || b === n) b = cb;
		}
		best.set(n.uuid, b);
	}
	return { kids, best, byId };
}

/** 从根走到 leaf 的那条路；路上每个改写过的地方的各个版本；latest 是整棵树最新的叶子 */
export function walk(t: Tree, leaf: string | null) {
	const roots = t.kids.get(null) ?? [];
	const latest = roots.map((r) => t.best.get(r.uuid) ?? r).sort((a, b) => b.ts.localeCompare(a.ts))[0];
	const end = (leaf ? t.byId.get(leaf) : undefined) ?? latest;
	const path: Node[] = [];
	for (let n: Node | undefined = end; n; n = n.parent ? t.byId.get(n.parent) : undefined) path.unshift(n);
	const versions = new Map<string, { options: Node[]; index: number }>();
	for (const n of path) {
		const siblings = t.kids.get(n.parent && t.byId.has(n.parent) ? n.parent : null) ?? [];
		if (siblings.length > 1) versions.set(n.uuid, { options: siblings, index: siblings.indexOf(n) });
	}
	return { path, versions, end, latest, atLatest: !end || end === latest };
}

type Block = { kind: "one"; n: Node } | { kind: "steps"; nodes: Node[] };
export function blocks(path: Node[]): Block[] {
	const out: Block[] = [];
	for (const n of path) {
		if (n.k === "tool" || n.k === "thinking") {
			const last = out[out.length - 1];
			if (last?.kind === "steps") last.nodes.push(n);
			else out.push({ kind: "steps", nodes: [n] });
		} else out.push({ kind: "one", n });
	}
	return out;
}

/** 分叉点：路上 before 之前（不含）最后一条 Claude 说的话。没有（在第一条消息上分叉）就是 null */
function forkPoint(path: Node[], before?: Node): string | null {
	const upto = before ? path.slice(0, path.indexOf(before)) : path;
	const said = [...upto].reverse().find((n) => n.k === "assistant") ?? [...upto].reverse().find((n) => n.k !== "user" && n.k !== "event");
	return said?.uuid ?? null;
}

export const PERMISSIONS = [
	{ v: "default", label: "改文件、跑命令都问" },
	{ v: "acceptEdits", label: "改文件不问" },
	{ v: "plan", label: "只出计划，不动手" },
];

export function PermissionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger size="sm" className="h-7 w-auto gap-1.5 border-0 bg-muted/60 px-2 text-xs shadow-none">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{PERMISSIONS.map((p) => <SelectItem key={p.v} value={p.v}>{p.label}</SelectItem>)}
			</SelectContent>
		</Select>
	);
}

export function Conversation({ project, session, w, t, onFile }: { project: string; session: string; w: Walk; t: Tree; onFile: (path: string, diff: boolean) => void }) {
	const { approvals, runs } = useLive();
	const [agent, setAgent] = useState<Agent | null>(null);
	const [fork, setFork] = useState<{ kind: "edit"; n: User } | { kind: "after"; n: Said } | null>(null);
	const bs = blocks(w.path);
	const mine = approvals.filter((a) => runs.some((r) => r.id === a.run && r.session === session));

	const openAgent = async (id: string) => {
		try {
			setAgent(await api<Agent>(`/api/sessions/${enc(project)}/${enc(session)}/agents/${id}`));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<>
			{bs.map((b) => {
				const head = b.kind === "one" ? b.n : b.nodes[0];
				const v = w.versions.get(head.uuid);
				return (
					<div key={head.uuid} className="flex flex-col gap-2">
						{v && <VersionSwitch v={v} best={t.best} />}
						{b.kind === "steps" ? (
							<Steps nodes={b.nodes} project={project} session={session} onAgent={openAgent} onFile={onFile} />
						) : b.n.k === "user" ? (
							<UserMessage n={b.n} project={project} session={session} onFork={(n) => setFork({ kind: "edit", n })} />
						) : b.n.k === "assistant" ? (
							<AssistantMessage n={b.n} onFork={(n) => setFork({ kind: "after", n })} />
						) : b.n.k === "event" ? (
							<EventLine n={b.n} />
						) : null}
					</div>
				);
			})}
			<LiveRun session={session} />
			{mine.map((a) => <ApprovalCard key={a.id} a={a} run={runs.find((r) => r.id === a.run)} className="border-primary/40" />)}

			<Sheet open={!!agent} onOpenChange={(o) => !o && setAgent(null)}>
				<SheetContent side="right" className="w-full p-0 sm:max-w-2xl">
					<SheetHeader className="border-b">
						<SheetTitle>子 agent：{agent?.info.agentType ?? agent?.id}</SheetTitle>
						<SheetDescription>{agent?.info.description}</SheetDescription>
					</SheetHeader>
					<ScrollArea className="min-h-0 flex-1">
						<div className="flex flex-col gap-4 p-4">
							{agent &&
								blocks(agent.nodes).map((b) =>
									b.kind === "steps" ? (
										<Steps key={b.nodes[0].uuid} nodes={b.nodes} project={project} session={session} agent={agent.id} onFile={onFile} />
									) : b.n.k === "assistant" ? (
										<AssistantMessage key={b.n.uuid} n={b.n} />
									) : b.n.k === "user" ? (
										<div key={b.n.uuid} className="rounded-lg border bg-muted/40 p-3 text-[13px] whitespace-pre-wrap">{b.n.text}</div>
									) : null,
								)}
						</div>
					</ScrollArea>
				</SheetContent>
			</Sheet>

			<ForkDialog project={project} session={session} w={w} target={fork} onClose={() => setFork(null)} />
		</>
	);
}

function VersionSwitch({ v, best }: { v: { options: Node[]; index: number }; best: Map<string, Node> }) {
	const to = (i: number) => {
		const n = v.options[(i + v.options.length) % v.options.length];
		go({ leaf: (best.get(n.uuid) ?? n).uuid }, true);
	};
	return (
		<div className="flex items-center gap-1 self-end text-xs text-muted-foreground" title="这条消息改写过，每个版本后面的对话不一样">
			<Button variant="ghost" size="icon" className="size-6" onClick={() => to(v.index - 1)} aria-label="上一个版本">
				<ChevronLeft className="size-3.5" />
			</Button>
			<span className="tabular-nums">第 {v.index + 1} / {v.options.length} 版</span>
			<Button variant="ghost" size="icon" className="size-6" onClick={() => to(v.index + 1)} aria-label="下一个版本">
				<ChevronRight className="size-3.5" />
			</Button>
		</div>
	);
}

async function start(body: Record<string, unknown>, follow: (r: Run) => void) {
	askNotify();
	const r = await api<Run>("/api/runs", body);
	if (body.mode === "fork") {
		toast.success("分叉出新会话：建好就跳过去");
		follow(r);
	}
	return r;
}

/** 为什么只能分叉；能接着说就是 null */
function noContinue(w: Walk, status: Status): string | null {
	if (!w.atLatest) return "你在看旧版本：发出去会从这里分叉出一个新会话";
	if (status === "running" || status === "waiting") return "Claude 正在跑：发出去会分叉出一个新会话";
	if (status === "terminal") return "这个会话在终端里开着：发出去会分叉出一个新会话";
	return null;
}

export function Composer({ project, session, w, status }: { project: string; session: string; w: Walk; status: Status }) {
	const { follow } = useLive();
	const [text, setText] = useState("");
	const why = noContinue(w, status);
	const [mode, setMode] = useState<"resume" | "fork">(why ? "fork" : "resume");
	const [permission, setPermission] = useState("default");
	const [busy, setBusy] = useState(false);
	useEffect(() => setMode(why ? "fork" : "resume"), [why]);
	const send = async () => {
		if (!text.trim() || busy) return;
		setBusy(true);
		try {
			// 分叉：在看旧版本就从看到的地方分；否则从最新处（不给分叉点）
			const at = w.atLatest ? null : forkPoint(w.path);
			await start({ project, session, mode, at, prompt: text, permission }, follow);
			setText("");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="border-t bg-background/80 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur md:px-6">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-xl border bg-card p-2 shadow-xs focus-within:ring-[3px] focus-within:ring-ring/30">
				<Textarea
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
					placeholder={why ?? (mode === "resume" ? "接着说……" : "分叉出一个新会话，从最新处接着说……")}
					className="max-h-48 min-h-11 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<div className="flex items-center gap-1.5">
					<Select value={mode} onValueChange={(v) => setMode(v as "resume" | "fork")}>
						<SelectTrigger size="sm" className="h-7 w-auto gap-1.5 border-0 bg-muted/60 px-2 text-xs shadow-none">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="resume" disabled={!!why}>接着说</SelectItem>
							<SelectItem value="fork">分叉出新会话</SelectItem>
						</SelectContent>
					</Select>
					<PermissionSelect value={permission} onChange={setPermission} />
					<Button size="icon" className="ml-auto size-8 rounded-lg" disabled={!text.trim() || busy} onClick={send} aria-label="发送">
						{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
					</Button>
				</div>
			</div>
		</div>
	);
}

function ForkDialog({ project, session, w, target, onClose }: { project: string; session: string; w: Walk; target: { kind: "edit"; n: User } | { kind: "after"; n: Said } | null; onClose: () => void }) {
	const { follow } = useLive();
	const [text, setText] = useState("");
	const [permission, setPermission] = useState("default");
	useEffect(() => { if (target) setText(target.kind === "edit" ? target.n.text : ""); }, [target]);
	const send = async () => {
		if (!target || !text.trim()) return;
		try {
			const at = target.kind === "after" ? target.n.uuid : forkPoint(w.path, target.n);
			// 改写第一条消息：前面没有上下文，就是在同一个项目里开新会话
			await start(at ? { project, session, mode: "fork", at, prompt: text, permission } : { project, mode: "new", prompt: text, permission }, follow);
			onClose();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	};
	return (
		<Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GitFork className="size-4" />
						{target?.kind === "edit" ? "改写这条消息，分叉出新会话" : "从这条回答之后分叉"}
					</DialogTitle>
					<DialogDescription>
						{target?.kind === "edit" ? "带着这条消息之前的对话开一个新会话，把这条换成下面的内容。" : "带着到这里为止的对话开一个新会话，接着问下面的内容。"}原会话不动。
					</DialogDescription>
				</DialogHeader>
				<Textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} className="min-h-32" autoFocus />
				<DialogFooter className="items-center sm:justify-between">
					<PermissionSelect value={permission} onChange={setPermission} />
					<div className="flex gap-2">
						<Button variant="outline" onClick={onClose}>取消</Button>
						<Button onClick={send} disabled={!text.trim()}>分叉</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type Ev = { type: string; event?: { type: string; delta?: { type: string; text?: string }; content_block?: { type: string; name?: string } } };

/** 这个会话上正在跑的那次运行：实时显示 Claude 正在写的字、正在调的工具 */
function LiveRun({ session }: { session: string }) {
	const { runs } = useLive();
	const run = runs.find((r) => r.session === session && r.status === "running") ?? null;
	const [text, setText] = useState("");
	const [tools, setTools] = useState<string[]>([]);
	useEffect(() => { setText(""); setTools([]); }, [run?.id]);
	useEvent("run-event", useCallback((e: { id: string; event: Ev }) => {
		if (!run || e.id !== run.id) return;
		const ev = e.event;
		if (ev.type !== "stream_event") return;
		if (ev.event?.type === "message_start") setText("");
		if (ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") setText((t) => t + (ev.event?.delta?.text ?? ""));
		if (ev.event?.type === "content_block_start" && ev.event.content_block?.type === "tool_use") setTools((ts) => [...ts, ev.event?.content_block?.name ?? "?"]);
	}, [run]));
	if (!run) return null;
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-dashed p-3">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Loader2 className="size-3.5 animate-spin" />
				<span>在跑 · {clock(run.started)}</span>
				{tools.length > 0 && <span className="truncate">{tools.slice(-4).join("、")}</span>}
				<Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-[11px]" onClick={() => api(`/api/runs/${run.id}/stop`, {}).catch(() => {})}>
					<Square className="size-3" />
					停
				</Button>
			</div>
			{text && <Markdown text={text} />}
		</div>
	);
}
