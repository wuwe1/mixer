// 对话页：把节点树走成一条路（默认走到最新的那片叶子；地址里的 leaf 指定走哪条分支），在真正的分支处放切换器，
// 右边（手机上是抽屉）是「你问过的问题」目录，底部是输入框（续接 / 分叉），正在跑的那次运行实时显示在最后。
import { ChevronLeft, ChevronRight, GitBranch, GitFork, ListTree, Loader2, Send, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { type Agent, api, enc, type Node, type Run, type Session } from "@/lib/api";
import { useEvent } from "@/lib/events";
import { go } from "@/lib/route";
import { clock } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { AssistantMessage, EventLine, Steps, UserMessage } from "./message";
import { useRuns } from "./runs";

type Tree = { kids: Map<string | null, Node[]>; best: Map<string, Node>; byId: Map<string, Node> };

/** 子节点表；每个节点往下最新的那片叶子 */
function tree(nodes: Node[]): Tree {
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

/** 从根走到 leaf 的那条路；以及路上每个真正分支处的选项 */
function walk(t: Tree, leaf: string | null) {
	const roots = t.kids.get(null) ?? [];
	let end = leaf ? t.byId.get(leaf) : undefined;
	if (!end) {
		const last = roots.map((r) => t.best.get(r.uuid) ?? r).sort((a, b) => b.ts.localeCompare(a.ts))[0];
		end = last;
	}
	const path: Node[] = [];
	for (let n: Node | undefined = end; n; n = n.parent ? t.byId.get(n.parent) : undefined) path.unshift(n);
	const forks = new Map<string, { options: Node[]; index: number }>();
	for (const n of path) {
		const siblings = t.kids.get(n.parent && t.byId.has(n.parent) ? n.parent : null) ?? [];
		if (siblings.length > 1) forks.set(n.uuid, { options: siblings, index: siblings.indexOf(n) });
	}
	return { path, forks, end };
}

type Block = { kind: "one"; n: Node } | { kind: "steps"; nodes: Node[] };
function blocks(path: Node[]): Block[] {
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

export function Conversation({ project, session, leaf, outlineOpen, setOutlineOpen }: { project: string; session: string; leaf: string | null; outlineOpen: boolean; setOutlineOpen: (o: boolean) => void }) {
	const [data, setData] = useState<Session | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [agent, setAgent] = useState<Agent | null>(null);
	const [fork, setFork] = useState<Extract<Node, { k: "user" }> | null>(null);
	const bottom = useRef<HTMLDivElement>(null);
	const first = useRef(true);
	// 不能续接：正在 mixer 里跑，或者最近有写入而且不是 mixer 写的（可能在终端里开着）
	const runs = useRuns();
	const ours = runs.filter((r) => r.project === project && r.session === session);
	const busy = ours.some((r) => r.status === "running") || (!!data?.meta.active && ours.length === 0);

	const load = useCallback(() => {
		api<Session>(`/api/sessions/${enc(project)}/${enc(session)}`).then((d) => { setData(d); setError(null); }, (e: Error) => setError(e.message));
	}, [project, session]);
	useEffect(() => { setData(null); setError(null); first.current = true; load(); }, [load]);
	useEvent("session", useCallback((e: { project: string; id: string }) => { if (e.project === project && e.id === session) load(); }, [project, session, load]));
	useEvent("reconnect", load);

	const t = useMemo(() => (data ? tree(data.nodes) : null), [data]);
	const w = useMemo(() => (t ? walk(t, leaf) : null), [t, leaf]);
	const bs = useMemo(() => (w ? blocks(w.path) : []), [w]);
	const prompts = useMemo(() => w?.path.filter((n): n is Extract<Node, { k: "user" }> => n.k === "user") ?? [], [w]);

	// 第一次打开：滚到最后
	useEffect(() => {
		if (data && first.current) {
			first.current = false;
			requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: "end" }));
		}
	}, [data]);

	const jump = (uuid: string) => {
		setOutlineOpen(false);
		requestAnimationFrame(() => document.getElementById(`n-${uuid}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
	};
	const openAgent = async (id: string) => {
		try {
			setAgent(await api<Agent>(`/api/sessions/${enc(project)}/${enc(session)}/agents/${id}`));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	};

	if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
	if (!data || !w || !t) {
		return (
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
				{[0, 1, 2, 3].map((i) => <Skeleton key={i} className={cn("h-16", i % 2 ? "w-3/4" : "ml-auto w-2/3")} />)}
			</div>
		);
	}

	const outline = (
		<nav className="flex flex-col gap-0.5">
			{prompts.map((p, i) => (
				<button
					key={p.uuid}
					type="button"
					onClick={() => jump(p.uuid)}
					className="group flex gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
				>
					<span className="w-5 shrink-0 pt-px text-right text-[11px] text-muted-foreground tabular-nums">{i + 1}</span>
					<span className="line-clamp-2 min-w-0 flex-1 leading-snug">{p.text || "（图片）"}</span>
				</button>
			))}
		</nav>
	);

	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* 原生滚动：shadcn 的 ScrollArea 里面是 display:table，长代码会把整栏撑宽 */}
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
					<div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 px-4 py-6 md:px-6">
						{bs.map((b) => {
							const head = b.kind === "one" ? b.n : b.nodes[0];
							const f = w.forks.get(head.uuid);
							return (
								<div key={head.uuid} className="flex flex-col gap-2">
									{f && <ForkSwitch f={f} best={t.best} />}
									{b.kind === "steps" ? (
										<Steps nodes={b.nodes} project={project} session={session} onAgent={openAgent} />
									) : b.n.k === "user" ? (
										<UserMessage n={b.n} project={project} session={session} onFork={setFork} />
									) : b.n.k === "assistant" ? (
										<AssistantMessage n={b.n} />
									) : b.n.k === "event" ? (
										<EventLine n={b.n} />
									) : null}
								</div>
							);
						})}
						<LiveRun project={project} session={session} />
						<div ref={bottom} />
					</div>
				</div>
				<Composer project={project} session={session} active={busy} />
			</div>

			<aside className="hidden w-72 shrink-0 flex-col border-l xl:flex">
				<div className="flex h-11 items-center gap-2 border-b px-4 text-xs font-medium text-muted-foreground">
					<ListTree className="size-3.5" />
					你问过的 {prompts.length} 个问题
				</div>
				<ScrollArea className="min-h-0 flex-1 p-2">{outline}</ScrollArea>
			</aside>
			<Sheet open={outlineOpen} onOpenChange={setOutlineOpen}>
				<SheetContent side="right" className="w-[85vw] max-w-sm p-0">
					<SheetHeader className="border-b">
						<SheetTitle>你问过的问题</SheetTitle>
						<SheetDescription>{prompts.length} 个，点一下跳过去</SheetDescription>
					</SheetHeader>
					<ScrollArea className="min-h-0 flex-1 p-2">{outline}</ScrollArea>
				</SheetContent>
			</Sheet>

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
										<Steps key={b.nodes[0].uuid} nodes={b.nodes} project={project} session={session} agent={agent.id} />
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

			<ForkDialog project={project} session={session} node={fork} onClose={() => setFork(null)} />
		</div>
	);
}

function ForkSwitch({ f, best }: { f: { options: Node[]; index: number }; best: Map<string, Node> }) {
	const to = (i: number) => {
		const n = f.options[(i + f.options.length) % f.options.length];
		go({ leaf: (best.get(n.uuid) ?? n).uuid }, true);
	};
	return (
		<div className="flex items-center gap-2 self-center rounded-full border bg-background px-1 py-0.5 text-xs text-muted-foreground shadow-xs">
			<Button variant="ghost" size="icon" className="size-6 rounded-full" onClick={() => to(f.index - 1)} aria-label="上一个分支">
				<ChevronLeft className="size-3.5" />
			</Button>
			<span className="flex items-center gap-1.5 tabular-nums">
				<GitBranch className="size-3" />
				分支 {f.index + 1} / {f.options.length}
			</span>
			<Button variant="ghost" size="icon" className="size-6 rounded-full" onClick={() => to(f.index + 1)} aria-label="下一个分支">
				<ChevronRight className="size-3.5" />
			</Button>
		</div>
	);
}

export const PERMISSIONS = [
	{ v: "default", label: "逐个确认" },
	{ v: "acceptEdits", label: "改文件不问" },
	{ v: "plan", label: "只做计划" },
];

async function startRun(body: Record<string, unknown>) {
	const r = await api<Run>("/api/runs", body);
	toast.success(body.mode === "resume" ? "开始续接" : "开始分叉：新会话一建好就跳过去");
	return r;
}

/** 新会话的 id 一出来就跳过去（分叉、从中间分叉） */
function useFollow(run: Run | null, project: string) {
	useEvent("run", useCallback((r: Run) => {
		if (run && r.id === run.id && r.session && r.session !== run.from) go({ project, session: r.session, leaf: null, tab: "chat" });
	}, [run, project]));
}

function Composer({ project, session, active }: { project: string; session: string; active: boolean }) {
	const [text, setText] = useState("");
	const [mode, setMode] = useState<"resume" | "fork">(active ? "fork" : "resume");
	const [permission, setPermission] = useState("default");
	const [busy, setBusy] = useState(false);
	const [run, setRun] = useState<Run | null>(null);
	useEffect(() => setMode(active ? "fork" : "resume"), [active]);
	useFollow(mode === "fork" ? run : null, project);
	const send = async () => {
		setBusy(true);
		try {
			setRun(await startRun({ project, session, mode, prompt: text, permission }));
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
					onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) send(); }}
					placeholder={mode === "resume" ? "接着这个会话说……" : "从最新处分叉成一个新会话，说……"}
					className="max-h-48 min-h-11 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<div className="flex items-center gap-1.5">
					<Select value={mode} onValueChange={(v) => setMode(v as "resume" | "fork")}>
						<SelectTrigger size="sm" className="h-7 w-auto gap-1.5 border-0 bg-muted/60 px-2 text-xs shadow-none">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="resume" disabled={active}>续接{active ? "（它还在跑）" : ""}</SelectItem>
							<SelectItem value="fork">分叉成新会话</SelectItem>
						</SelectContent>
					</Select>
					<Select value={permission} onValueChange={setPermission}>
						<SelectTrigger size="sm" className="h-7 w-auto gap-1.5 border-0 bg-muted/60 px-2 text-xs shadow-none">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PERMISSIONS.map((p) => <SelectItem key={p.v} value={p.v}>{p.label}</SelectItem>)}
						</SelectContent>
					</Select>
					<Button size="icon" className="ml-auto size-8 rounded-lg" disabled={!text.trim() || busy} onClick={send} aria-label="发送">
						{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
					</Button>
				</div>
			</div>
		</div>
	);
}

function ForkDialog({ project, session, node, onClose }: { project: string; session: string; node: Extract<Node, { k: "user" }> | null; onClose: () => void }) {
	const [text, setText] = useState("");
	const [run, setRun] = useState<Run | null>(null);
	useEffect(() => { if (node) setText(node.text); }, [node]);
	useFollow(run, project);
	const send = async () => {
		try {
			setRun(await startRun({ project, session, mode: "fork-at", at: node?.uuid, prompt: text, permission: "default" }));
			onClose();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	};
	return (
		<Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GitFork className="size-4" />
						从这条消息分叉
					</DialogTitle>
					<DialogDescription>
						带着这条消息之前的全部上下文，开一个新会话，把这条消息换成下面的内容重新问。原来的会话不动。（实验：复制了一份记录再续接）
					</DialogDescription>
				</DialogHeader>
				<Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-32" />
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>取消</Button>
					<Button onClick={send} disabled={!text.trim()}>分叉并发送</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type Ev = { type: string; subtype?: string; session_id?: string; event?: { type: string; delta?: { type: string; text?: string }; content_block?: { type: string; name?: string } }; message?: { content?: { type: string; name?: string; text?: string }[] }; result?: string };

/** 这个会话上正在跑的那次运行：实时显示 Claude 正在写的字、正在调的工具 */
function LiveRun({ project, session }: { project: string; session: string }) {
	const [run, setRun] = useState<Run | null>(null);
	const [text, setText] = useState("");
	const [tools, setTools] = useState<string[]>([]);
	const mine = useCallback((r: Run) => r.project === project && (r.session === session || (r.session === null && r.from === session && r.mode === "resume")), [project, session]);
	useEffect(() => {
		api<Run[]>("/api/runs").then((rs) => setRun(rs.find((r) => r.status === "running" && mine(r)) ?? null), () => {});
	}, [mine]);
	useEvent("run", useCallback((r: Run) => {
		if (!mine(r)) return;
		setRun(r);
		if (r.status !== "running") setTimeout(() => { setRun(null); setText(""); setTools([]); }, 1500);
	}, [mine]));
	useEvent("run-event", useCallback((e: { id: string; event: Ev }) => {
		if (!run || e.id !== run.id) return;
		const ev = e.event;
		if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") setText((t) => t + (ev.event?.delta?.text ?? ""));
		if (ev.type === "stream_event" && ev.event?.type === "content_block_start" && ev.event.content_block?.type === "tool_use") setTools((ts) => [...ts, ev.event?.content_block?.name ?? "?"]);
		if (ev.type === "assistant") setText((t) => t); // 完整消息到了：已经由增量拼好
		if (ev.type === "stream_event" && ev.event?.type === "message_start") setText("");
	}, [run]));
	if (!run) return null;
	const stop = () => api(`/api/runs/${run.id}/stop`, {}).catch(() => {});
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-dashed p-3">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				{run.status === "running" && <Loader2 className="size-3.5 animate-spin" />}
				<span>{run.status === "running" ? "正在跑" : "跑完了"} · {clock(run.started)}</span>
				{tools.length > 0 && <span className="truncate">工具：{tools.slice(-4).join("、")}</span>}
				{run.status === "running" && (
					<Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-[11px]" onClick={stop}>
						<Square className="size-3" />
						停
					</Button>
				)}
			</div>
			{text && <Markdown text={text} />}
		</div>
	);
}
