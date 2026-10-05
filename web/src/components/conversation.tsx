// 对话：把节点树走成一条路（默认走到最新的那片叶子；地址里的 leaf 指定看哪个版本），一条消息改写过的地方放版本切换。
// 最后是正在跑的那次运行（实时的字）、这个会话等你确认的请求、输入框。
// 输入框只有两种发送方式：继续（续接这个会话），或者分叉（开一个新会话，带着到某一处为止的上下文，原会话不动）。
// Claude 正在 mixer 里运行时继续就排队，这次运行结束后一起发送；在看旧版本、终端中打开，只能分叉。
// 从中间分叉：每条回复、每组工具调用的「⋯」→ 从这里分叉；每条你的消息的「⋯」→ 编辑并分叉。
import { Bot, ChevronDown, ChevronLeft, ChevronRight, Clock, GitFork, Hand, ListChecks, MessageSquareText, Send, Sparkles, Square, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { type Agent, api, enc, type Node, type Queued, type Run } from "@/lib/api";
import { useEvent } from "@/lib/events";
import { askNotify, type Status, useLive } from "@/lib/live";
import { go } from "@/lib/route";
import { defaultModel, family, lastCtx, MODELS, pretty, windowOf } from "@/lib/model";
import { clock } from "@/lib/time";
import { ApprovalCard } from "./approvals";
import { AttachButton, AttachStrip, encode, type Shot, toShots } from "./attach";
import { Markdown } from "./markdown";
import { StatusIcon } from "./side";
import { SkillButton, SkillPicker, withSkill } from "./skills";
import { AssistantMessage, Elapsed, EventLine, Steps, UserMessage } from "./message";

export type Tree = { kids: Map<string | null, Node[]>; best: Map<string, Node>; byId: Map<string, Node> };
export type Walk = ReturnType<typeof walk>;
type User = Extract<Node, { k: "user" }>;

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

/**
 * 分叉点要的是一条记录的 uuid，新会话只带到它为止的上下文。
 * 工具调用要用它结果那条记录：用调用本身，命令行带过去的上下文里就没有结果
 */
const pointOf = (n: Node) => (n.k === "tool" ? (n.resultUuid ?? n.uuid) : n.uuid);
/** 路上 before 之前（不含）最后一条 Claude 的回复、思考或工具结果。没有（在第一条消息上分叉）就是 null */
function forkPoint(path: Node[], before?: Node): string | null {
	const upto = before ? path.slice(0, path.indexOf(before)) : path;
	const last = [...upto].reverse().find((n) => n.k === "assistant" || n.k === "thinking" || n.k === "tool");
	return last ? pointOf(last) : null;
}

type ForkTarget = { kind: "edit"; n: User } | { kind: "at"; at: string; what: string };

type Option = { v: string; icon: typeof Send; label: string; desc: string; disabled?: boolean };

/** 输入框下面的小选项：平时只是个图标，点开才写每一项是什么意思 */
/** 平时只是个图标；给了 text 就显示成文字（模型名） */
function OptionMenu({ title, options, value, onChange, text }: { title: string; options: Option[]; value: string; onChange: (v: string) => void; text?: ReactNode }) {
	const cur = options.find((o) => o.v === value) ?? options[0];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm" className="h-7 gap-0.5 px-1.5 text-muted-foreground" aria-label={`${title}：${cur.label}`} title={`${title}：${cur.label}`}>
					{text ? <span className="text-2xs">{text}</span> : <cur.icon className="size-4" />}
					<ChevronDown className="size-3 opacity-60" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72">
				<DropdownMenuLabel>{title}</DropdownMenuLabel>
				<DropdownMenuRadioGroup value={value} onValueChange={onChange}>
					{options.map((o) => (
						<DropdownMenuRadioItem key={o.v} value={o.v} disabled={o.disabled} className="items-start gap-2.5 py-2">
							<o.icon className="mt-0.5 size-4 text-muted-foreground" />
							<span className="flex flex-col gap-0.5">
								<span className="font-medium">{o.label}</span>
								<span className="text-xs leading-snug text-muted-foreground">{o.desc}</span>
							</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// auto：Claude Code 的自动模式，由它判断，一般操作直接放行，有风险的才请求确认。「Accept edits」被它盖住了，不再单列
const PERMISSIONS: Option[] = [
	{ v: "auto", icon: Sparkles, label: "自动", desc: "读写文件、运行命令直接执行，Claude 判断有风险的才请求确认" },
	{ v: "default", icon: Hand, label: "每次询问", desc: "修改文件、运行命令前都请求确认（只读命令除外）" },
	{ v: "plan", icon: ListChecks, label: "计划模式", desc: "只读不改，先写出计划" },
];

export function PermissionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	return <OptionMenu title="权限" options={PERMISSIONS} value={value} onChange={onChange} />;
}

/**
 * 下一条用的模型。value 是别名，"" 是 Claude Code 的默认；current 是上一条回复实际用的完整型号，同系列时显示它（Opus 5.5），
 * 手机上只显示系列名
 */
export function ModelSelect({ value, onChange, current }: { value: string; onChange: (v: string) => void; current?: string | null }) {
	const options: Option[] = [
		{ v: "", icon: Bot, label: "默认", desc: "Claude Code 里设的默认模型" },
		...MODELS.map((m) => ({ v: m.v as string, icon: Bot, label: m.label, desc: current && family(current) === m.v ? `现在用的是 ${pretty(current)}` : `最新的 ${m.label}` })),
	];
	const full = current && (!value || family(current) === value) ? pretty(current) : value ? pretty(value) : "默认";
	const text = (
		<>
			<span className="md:hidden">{full.split(" ")[0]}</span>
			<span className="hidden md:inline">{full}</span>
		</>
	);
	return <OptionMenu title="模型" options={options} value={value} onChange={onChange} text={text} />;
}

export function Conversation({ project, session, w, t, onFile, chosen, stream, status }: { project: string; session: string; w: Walk; t: Tree; onFile: (path: string, diff: boolean) => void; chosen: string | null; stream: Stream; status: Status }) {
	const { approvals, runs } = useLive();
	const [agent, setAgent] = useState<Agent | null>(null);
	const [fork, setFork] = useState<ForkTarget | null>(null);
	// 看的是最新处：正在写的接在末尾
	const live = w.atLatest ? liveNodes(stream, w.path) : [];
	const bs = blocks([...w.path, ...live]);
	// 还在跑（mixer 里、或者终端里开着）：最后一组里还没结果的工具、正在写的那一步，带上 ping 点和耗时
	const busy = status === "running" || status === "waiting" || status === "terminal";
	const tail = bs[bs.length - 1];
	const last = busy && w.atLatest && tail?.kind === "steps" ? tail.nodes[tail.nodes.length - 1] : null;
	const liveAt = (n: Node) => stream.blocks[Number(n.uuid.slice(5))]?.at ?? Date.now();
	const now = last && ((last.k === "tool" && !last.result) || (last.k === "thinking" && isLive(last))) ? { node: last, since: isLive(last) ? liveAt(last) : Date.parse(last.ts) } : null;
	// 换过模型的地方：前一条回复和这一条用的模型不同，前面放一条分隔线
	const switched = new Map<string, string>();
	let prev: string | null = null;
	for (const b of bs) {
		const ns = b.kind === "one" ? [b.n] : b.nodes;
		const m = ns.map((n) => ("ctx" in n ? n.ctx?.model : undefined)).find(Boolean);
		if (!m) continue;
		if (prev && m !== prev) switched.set((b.kind === "one" ? b.n : b.nodes[0]).uuid, m);
		prev = m;
	}
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
						{switched.has(head.uuid) && <EventLine n={{ k: "event", uuid: `model-${head.uuid}`, parent: null, ts: head.ts, kind: "info", text: `换成 ${pretty(switched.get(head.uuid) as string)}` }} />}
						{b.kind === "steps" ? (
							<Steps nodes={b.nodes} project={project} session={session} onAgent={openAgent} onFile={onFile} now={b === tail ? now : null} onFork={b.nodes.some(isLive) ? undefined : (ns) => setFork({ kind: "at", at: pointOf(ns[ns.length - 1]), what: "这几步工具调用" })} />
						) : b.n.k === "user" ? (
							<UserMessage n={b.n} project={project} session={session} onFork={(n) => setFork({ kind: "edit", n })} />
						) : b.n.k === "assistant" ? (
							<AssistantMessage n={b.n} onFork={isLive(b.n) ? undefined : (n) => setFork({ kind: "at", at: n.uuid, what: "这条回复" })} />
						) : b.n.k === "event" ? (
							<EventLine n={b.n} onAgent={openAgent} />
						) : null}
					</div>
				);
			})}
			<QueuedMessages session={session} />
			{mine.map((a) => <ApprovalCard key={a.id} a={a} run={runs.find((r) => r.id === a.run)} className="border-waiting/50" />)}

			<Sheet open={!!agent} onOpenChange={(o) => !o && setAgent(null)}>
				<SheetContent side="right" className="w-full p-0 sm:max-w-2xl">
					<SheetHeader className="border-b">
						<SheetTitle>子代理：{agent?.info.agentType ?? agent?.id}</SheetTitle>
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
										<div key={b.n.uuid} className="rounded-lg border bg-muted/40 p-3 text-md whitespace-pre-wrap">{b.n.text}</div>
									) : null,
								)}
						</div>
					</ScrollArea>
				</SheetContent>
			</Sheet>

			<ForkDialog project={project} session={session} w={w} chosen={chosen} target={fork} onClose={() => setFork(null)} />
		</>
	);
}

function VersionSwitch({ v, best }: { v: { options: Node[]; index: number }; best: Map<string, Node> }) {
	const to = (i: number) => {
		const n = v.options[(i + v.options.length) % v.options.length];
		go({ leaf: (best.get(n.uuid) ?? n).uuid }, true);
	};
	return (
		<div className="flex items-center gap-1 self-end text-xs text-muted-foreground" title="这条消息编辑过，每个版本之后的对话不同">
			<Button variant="ghost" size="icon-xs" onClick={() => to(v.index - 1)} aria-label="上一个版本">
				<ChevronLeft className="size-3.5" />
			</Button>
			<span className="tabular-nums">第 {v.index + 1} / {v.options.length} 版</span>
			<Button variant="ghost" size="icon-xs" onClick={() => to(v.index + 1)} aria-label="下一个版本">
				<ChevronRight className="size-3.5" />
			</Button>
		</div>
	);
}

async function start(body: Record<string, unknown>, follow: (r: Run) => void) {
	askNotify();
	const r = await api<Run | { queued: Queued }>("/api/runs", body);
	if ("queued" in r) return r;
	if (body.mode === "fork") {
		toast.success("正在分叉，新会话建好后自动打开");
		follow(r);
	}
	return r;
}

/** 为什么只能分叉；能接着说就是 null */
function noContinue(w: Walk, status: Status): string | null {
	if (!w.atLatest) return "你在看旧版本：发送后会从这里分叉出新会话";
	if (status === "terminal") return "这个会话在终端中打开：发送后会分叉出新会话";
	return null;
}

const wan = (n: number) => (n >= 10_000 ? `${Math.round(n / 10_000)} 万` : String(n));

/** 运行中：在做什么、跑了多久、停止。手机上地方不够，只有时长和停止（在做什么看对话末尾带 ping 点的那一步） */
function RunStatus({ run, stream, waiting, path }: { run: Run; stream: Stream; waiting: boolean; path: Node[] }) {
	const b = stream.blocks[stream.blocks.length - 1];
	// 运行到一半才打开的页面没收到前面的流：从记录里看最后一步是不是还没结果的工具
	const tail = path[path.length - 1];
	const doing = waiting
		? "待确认"
		: b
			? b.k === "text" ? "写回复" : b.k === "thinking" ? "思考" : b.name.replace(/^mcp__[^_]+__/, "")
			: tail?.k === "tool" && !tail.result ? tail.name.replace(/^mcp__[^_]+__/, "") : "等 Claude";
	return (
		<span className="flex min-w-0 shrink items-center gap-1 text-2xs text-muted-foreground">
			<span className="hidden min-w-0 truncate md:inline">运行中 · {doing} ·</span>
			<Elapsed since={Date.parse(run.started)} className="shrink-0" />
			<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" onClick={() => api(`/api/runs/${run.id}/stop`, {}).catch(() => {})} aria-label="停止" title="停止这次运行">
				<Square className="size-3 fill-current" />
			</Button>
		</span>
	);
}

/** 上下文用了多少：你正在看的那条路上最后一条回复发出时的量，按下一条要用的模型的窗口算。手机上只有百分比 */
function ContextUsage({ path, windows, model }: { path: Node[]; windows: Record<string, number>; model: string }) {
	const ctx = lastCtx(path);
	if (!ctx) return null;
	const size = windowOf(model || ctx.model, windows) ?? windowOf(ctx.model, windows);
	if (!size) return <span className="px-1 text-2xs text-muted-foreground tabular-nums" title={`上下文 ${wan(ctx.used)} token`}>{wan(ctx.used)}</span>;
	const pct = Math.min(100, Math.round((ctx.used / size) * 100));
	const r = 6;
	const c = 2 * Math.PI * r;
	return (
		<span className="flex items-center gap-1 px-1 text-2xs text-muted-foreground tabular-nums" title={`上下文 ${wan(ctx.used)} / ${wan(size)} token${pct >= 80 ? "，快满了，会自动压缩" : ""}`}>
			<svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
				<circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth="2" />
				<circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
			</svg>
			{pct}%
			<span className="hidden md:inline">· {wan(ctx.used)} / {wan(size)}</span>
		</span>
	);
}

export function Composer({ project, session, w, status, windows, chosen, stream }: { project: string; session: string; w: Walk; status: Status; windows: Record<string, number>; chosen: string | null; stream: Stream }) {
	const { follow } = useLive();
	const [text, setText] = useState("");
	const why = noContinue(w, status);
	const busyRun = status === "running" || status === "waiting";
	const [mode, setMode] = useState<"resume" | "fork">(why ? "fork" : "resume");
	const [permission, setPermission] = useState("auto");
	const [model, setModel] = useState(() => defaultModel(w.path, chosen) ?? "");
	const [busy, setBusy] = useState(false);
	const [skills, setSkills] = useState(false);
	const [shots, setShots] = useState<Shot[]>([]);
	const input = useRef<HTMLTextAreaElement>(null);
	useEffect(() => setMode(why ? "fork" : "resume"), [why]);
	// 换了会话、或者在别处（终端、另一个页面）换了模型：跟着变
	const fallback = defaultModel(w.path, chosen) ?? "";
	useEffect(() => setModel(fallback), [session, fallback]);
	const send = async () => {
		if ((!text.trim() && !shots.length) || busy) return;
		setBusy(true);
		try {
			// 分叉：在看旧版本就从看到的地方分；否则从最新处（不给分叉点）
			const at = w.atLatest ? null : forkPoint(w.path);
			const images = await Promise.all(shots.map(encode));
			await start({ project, session, mode, at, prompt: text, images, permission, model: model || null }, follow);
			setText("");
			for (const s of shots) URL.revokeObjectURL(s.url);
			setShots([]);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="border-t bg-background/80 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur md:px-6">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-xl border bg-card p-2 shadow-xs focus-within:ring-[3px] focus-within:ring-ring/30">
				<AttachStrip shots={shots} onChange={setShots} />
				<Textarea
					value={text}
					ref={input}
					onChange={(e) => {
						// 空输入框里打「/」：弹出 skill 列表
						if (!text && e.target.value === "/") return setSkills(true);
						setText(e.target.value);
					}}
					onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
					onPaste={(e) => {
						const s = toShots(e.clipboardData.files);
						if (s.length) { e.preventDefault(); setShots((x) => [...x, ...s]); }
					}}
					placeholder={why ?? (mode === "fork" ? "分叉出新会话，从最新处继续……" : busyRun ? "Claude 正在运行：发送后排队，运行结束后发出……" : "继续……")}
					className="max-h-48 min-h-11 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<div className="flex items-center gap-1.5">
					<OptionMenu
						title="发送方式"
						value={mode}
						onChange={(v) => setMode(v as "resume" | "fork")}
						options={[
							{ v: "resume", icon: MessageSquareText, label: "继续", desc: why ? `现在不可用：${why.split("：")[0]}` : busyRun ? "Claude 正在运行：先排队，本次运行结束后发送" : "在这个会话的最新处继续", disabled: !!why },
							{ v: "fork", icon: GitFork, label: "分叉", desc: w.atLatest ? "开一个新会话，带着到最新处为止的对话；原会话不变" : "开一个新会话，带着到你正在看的地方为止的对话；原会话不变" },
						]}
					/>
					<PermissionSelect value={permission} onChange={setPermission} />
					<ModelSelect value={model} onChange={setModel} current={lastCtx(w.path)?.model} />
					<SkillButton onClick={() => setSkills(true)} />
					<AttachButton onAdd={(s) => setShots((x) => [...x, ...s])} />
					<span className="ml-auto" />
					{stream.run && <RunStatus run={stream.run} stream={stream} waiting={status === "waiting"} path={w.path} />}
					{/* 手机上运行中地方不够：先不显示上下文 */}
					<span className={stream.run ? "hidden md:contents" : "contents"}>
						<ContextUsage path={w.path} windows={windows} model={model} />
					</span>
					<Button size="icon" className="shrink-0 rounded-lg" disabled={(!text.trim() && !shots.length) || busy} onClick={send} aria-label="发送">
						{busy ? <Spinner /> : <Send className="size-4" />}
					</Button>
				</div>
			</div>
			<SkillPicker
				project={project}
				open={skills}
				onOpenChange={setSkills}
				onPick={(name) => {
					setText((t) => withSkill(t, name));
					setTimeout(() => input.current?.focus(), 0);
				}}
			/>
		</div>
	);
}

function ForkDialog({ project, session, w, chosen, target, onClose }: { project: string; session: string; w: Walk; chosen: string | null; target: ForkTarget | null; onClose: () => void }) {
	const { follow } = useLive();
	const [text, setText] = useState("");
	const [permission, setPermission] = useState("auto");
	const [model, setModel] = useState("");
	useEffect(() => {
		if (!target) return;
		setText(target.kind === "edit" ? target.n.text : "");
		setModel(defaultModel(w.path, chosen) ?? "");
	}, [target]);
	const send = async () => {
		if (!target || !text.trim()) return;
		try {
			const at = target.kind === "at" ? target.at : forkPoint(w.path, target.n);
			// 改写第一条消息：前面没有上下文，就是在同一个项目里开新会话
			const m = model || null;
			await start(at ? { project, session, mode: "fork", at, prompt: text, permission, model: m } : { project, mode: "new", prompt: text, permission, model: m }, follow);
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
						{target?.kind === "edit" ? "编辑并分叉" : "从这里分叉"}
					</DialogTitle>
					<DialogDescription>
						{target?.kind === "edit" ? "带着这条消息之前的对话开一个新会话，这条换成下面的内容。" : `带着到${target?.what ?? "这里"}为止的对话开一个新会话，接着发送下面的内容。`}原会话不变。
					</DialogDescription>
				</DialogHeader>
				<Textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} className="min-h-32" autoFocus />
				<DialogFooter className="items-center sm:justify-between">
					<div className="flex items-center gap-1.5">
						<PermissionSelect value={permission} onChange={setPermission} />
						<ModelSelect value={model} onChange={setModel} current={lastCtx(w.path)?.model} />
					</div>
					<div className="flex gap-2">
						<Button variant="outline" onClick={onClose}>取消</Button>
						<Button onClick={send} disabled={!text.trim()}>分叉</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** 这个会话排着队的话：这次跑完一起发。可以撤回，也可以停下当前的马上发 */
function QueuedMessages({ session }: { session: string }) {
	const { queue, runs } = useLive();
	const mine = queue.filter((q) => q.session === session);
	if (!mine.length) return null;
	const run = runs.find((r) => r.session === session && r.status === "running");
	return (
		<div className="flex flex-col items-end gap-2">
			{mine.map((q) => (
				<div key={q.id} className="group flex max-w-[88%] flex-col items-end gap-1">
					<div className="rounded-2xl rounded-br-md border border-dashed bg-secondary/50 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-secondary-foreground">{q.prompt}{q.images > 0 && <span className="block text-xs text-muted-foreground">带 {q.images} 张图片</span>}</div>
					<div className="flex items-center gap-1 px-1 text-2xs text-muted-foreground">
						<Clock className="size-3" />
						<span>排队中，本次运行结束后发送</span>
						<Button variant="ghost" size="xs" className="px-1.5 text-2xs" onClick={() => api(`/api/queue/${q.id}/cancel`, {}).catch(() => {})}>
							<X className="size-3" />
							取消
						</Button>
						{run && (
							<Button variant="ghost" size="xs" className="px-1.5 text-2xs" onClick={() => api(`/api/runs/${run.id}/stop`, {}).catch(() => {})}>
								<Square className="size-3" />
								中断并发送
							</Button>
						)}
					</div>
				</div>
			))}
		</div>
	);
}

type Ev = { type: string; event?: { type: string; delta?: { type: string; text?: string; thinking?: string; partial_json?: string }; content_block?: { type: string; name?: string; id?: string } } };

/** 运行输出流里的一段：正在写的文字、思考，或者正在写参数的工具调用（at：这一段开始的时间） */
type LiveBlock = ({ k: "text"; text: string } | { k: "thinking"; text: string } | { k: "tool"; id: string; name: string; json: string }) & { at: number };
export type Stream = { run: Run | null; blocks: LiveBlock[] };

/**
 * 这个会话上正在跑的那次运行，和它输出流里的各段。
 * 每段写完才写进会话记录；对话末尾先用流里的内容顶上，样子和写进记录之后一样，记录里一有就换成记录里的
 */
export function useStream(session: string): Stream {
	const { runs } = useLive();
	const run = runs.find((r) => r.session === session && r.status === "running") ?? null;
	const [blocks, setBlocks] = useState<LiveBlock[]>([]);
	useEffect(() => setBlocks([]), [run?.id]);
	useEvent("run-event", useCallback((e: { id: string; event: Ev }) => {
		if (!run || e.id !== run.id) return;
		const ev = e.event.event;
		if (e.event.type !== "stream_event" || !ev) return;
		if (ev.type === "content_block_start") {
			const b = ev.content_block;
			const at = Date.now();
			if (b?.type === "text") setBlocks((bs) => [...bs, { k: "text", text: "", at }]);
			else if (b?.type === "thinking") setBlocks((bs) => [...bs, { k: "thinking", text: "", at }]);
			else if (b?.type === "tool_use") setBlocks((bs) => [...bs, { k: "tool", id: b.id ?? "", name: b.name ?? "工具", json: "", at }]);
		} else if (ev.type === "content_block_delta") {
			const d = ev.delta;
			const add = d?.type === "text_delta" ? d.text : d?.type === "thinking_delta" ? d.thinking : d?.type === "input_json_delta" ? d.partial_json : undefined;
			if (!add) return;
			setBlocks((bs) => {
				const last = bs[bs.length - 1];
				if (!last) return bs;
				const next = last.k === "tool" ? { ...last, json: last.json + add } : { ...last, text: last.text + add };
				return [...bs.slice(0, -1), next];
			});
		}
	}, [run]));
	return { run, blocks: run ? blocks : [] };
}

/** 工具参数还在写的时候的概览：能解析了就挑一个最能说明它在干什么的字段，还没写完就显示写了多少 */
function liveSummary(json: string) {
	try {
		const o = JSON.parse(json) as Record<string, unknown>;
		const v = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description", "prompt"].map((k) => o[k]).find((x) => typeof x === "string");
		return typeof v === "string" ? v.split("\n")[0] : "";
	} catch {
		return json.length > 2048 ? `正在写… ${Math.round(json.length / 1024)} KB` : "";
	}
}

/** 流里还没写进记录的那几段，变成和记录里一样的节点，接在对话末尾 */
function liveNodes(stream: Stream, path: Node[]): Node[] {
	const texts = new Set(path.flatMap((n) => (n.k === "assistant" || n.k === "thinking" ? [n.text.trim()] : [])));
	const tools = new Set(path.flatMap((n) => (n.k === "tool" ? [n.id] : [])));
	const ts = new Date().toISOString();
	return stream.blocks.flatMap((b, i): Node[] => {
		const base = { uuid: `live:${i}`, parent: null, ts };
		if (b.k === "tool") return tools.has(b.id) ? [] : [{ k: "tool", ...base, id: b.id, name: b.name, summary: liveSummary(b.json), input: b.json, result: null, resultUuid: null, agent: null }];
		if (texts.has(b.text.trim())) return [];
		// 后面已经有别的段了：这段写完了。思考有时是不给看的（空的），记录里不会有它，不再显示
		if (b.k === "thinking") return !b.text.trim() && i < stream.blocks.length - 1 ? [] : [{ k: "thinking", ...base, text: b.text }];
		return b.text.trim() ? [{ k: "assistant", ...base, text: b.text }] : [];
	});
}
const isLive = (n: Node) => n.uuid.startsWith("live:");
