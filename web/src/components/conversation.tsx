// 对话：把节点树走成一条路（默认走到最新的那片叶子；地址里的 leaf 指定看哪个版本），一条消息改写过的地方放版本切换。
// 最后是正在跑的那次运行（实时的字）、这个会话等你确认的请求、输入框。
// 输入框只有两种发送方式：继续（续接这个会话），或者分叉（开一个新会话，带着到某一处为止的上下文，原会话不动）。
// Claude 正在 mixer 里运行时继续就排队，这次运行结束后一起发送；在看旧版本、终端中打开，只能分叉。
// 从中间分叉：每条回复、每组工具调用的「⋯」→ 从这里分叉；每条你的消息的「⋯」→ 编辑并分叉。
import { Bot, ChevronDown, ChevronLeft, ChevronRight, Clock, GitFork, Hand, ListChecks, MessageSquareText, Send, Sparkles, Square, X } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { useDraft, useOutbox } from "@/lib/outbox";
import { type Block as LiveBlock, emptyTail, step, type Tail } from "@/lib/tail";
import { clock } from "@/lib/time";
import { ApprovalCard } from "./approvals";
import { AttachButton, AttachStrip, encode, type Shot, toShots } from "./attach";
import { Images } from "./lightbox";
import { Markdown } from "./markdown";
import { StatusIcon } from "./side";
import { SkillButton, SkillPicker, withSkill } from "./skills";
import { AssistantMessage, Elapsed, EventLine, Steps, stable, UserMessage } from "./message";

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
	for (let n: Node | undefined = end; n; n = n.parent ? t.byId.get(n.parent) : undefined) path.push(n);
	path.reverse();
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

/** 接上正在写的那几段：只换最后一块，前面的块原样留着（消息组件是 memo 的，每来一个字不用全部重画） */
function append(bs: Block[], live: Node[]): Block[] {
	if (!live.length) return bs;
	const out = bs.slice();
	for (const n of live) {
		const last = out[out.length - 1];
		if (n.k !== "tool" && n.k !== "thinking") out.push({ kind: "one", n });
		else if (last?.kind === "steps") out[out.length - 1] = { kind: "steps", nodes: [...last.nodes, n] };
		else out.push({ kind: "steps", nodes: [n] });
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

/** 跳到这条（目录里点的）；at 让同一条点两次也算 */
export type Reveal = { uuid: string; at: number };

const STEP = 60;
const headOf = (b: Block) => (b.kind === "one" ? b.n : b.nodes[0]);

/**
 * 长对话只画最后一段：一开始画最后 STEP 块，往上滚到离顶不远时再往前接一段，接上之后保持看到的位置不动。
 * 起点只往前挪、不往后：新内容接在末尾时上面的不会被拿掉，往上翻着看的位置不跳。
 * 目录里跳到还没画的那条：先从那里画起，再滚过去
 */
function useWindow(bs: Block[], scroller: RefObject<HTMLDivElement | null>, reveal: Reveal | null) {
	const [start, setStart] = useState(() => Math.max(0, bs.length - STEP));
	// 换了版本、路变短了：至少还画最后 STEP 块
	const first = Math.min(start, Math.max(0, bs.length - STEP));
	const firstRef = useRef(first);
	firstRef.current = first;
	/** 往前接之前离底部多远：接上之后照这个把位置放回去 */
	const keep = useRef<number | null>(null);
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const check = () => {
			if (firstRef.current === 0 || keep.current !== null || el.scrollTop > 1500) return;
			keep.current = el.scrollHeight - el.scrollTop;
			setStart(Math.max(0, firstRef.current - STEP));
		};
		el.addEventListener("scroll", check, { passive: true });
		return () => el.removeEventListener("scroll", check);
	}, [scroller]);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (keep.current === null || !el) return;
		// 改 scrollTop 会再来一次 scroll：还离顶不远就接着往前接
		el.scrollTop = el.scrollHeight - keep.current;
		keep.current = null;
	}, [first, scroller]);

	const pending = useRef<string | null>(null);
	const bsRef = useRef(bs);
	bsRef.current = bs;
	const scrollTo = (uuid: string) => requestAnimationFrame(() => document.getElementById(`n-${uuid}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
	useEffect(() => {
		if (!reveal) return;
		const i = bsRef.current.findIndex((b) => headOf(b).uuid === reveal.uuid);
		if (i < 0 || i >= firstRef.current) return void scrollTo(reveal.uuid);
		pending.current = reveal.uuid;
		setStart(i);
	}, [reveal]);
	useLayoutEffect(() => {
		const u = pending.current;
		if (u && document.getElementById(`n-${u}`)) {
			pending.current = null;
			scrollTo(u);
		}
	});
	return first;
}

/**
 * 每一块的 React key：正在写的那几段换成记录里的时，key 不变，不重新挂载（点开的不收起，往上翻着看的位置不跳）。
 *   回复、思考、工具：「消息 id : 第几段」（stable）
 *   一组工具调用：跟着前面那一块认。组里第一段可能会变：不给看的空思考，后面来了别的段就不显示了
 *   你发的那条：记录里出现之前是 live:user:<运行>，出现之后记录里那条沿用这个 key
 */
function useIds(bs: Block[], run: Run | null, path: Node[]) {
	/** 记录里那条的 uuid → 它写进去之前用的 key */
	const alias = useRef(new Map<string, string>());
	/** 画过「还没写进记录」的那条的运行 */
	const drawn = useRef<string | null>(null);
	const live = liveUser(run);
	if (run && live && bs.some((b) => b.kind === "one" && b.n.uuid === live)) drawn.current = run.id;
	else if (run && live && drawn.current === run.id) {
		const got = sentNode(run, path);
		if (got) alias.current.set(got.uuid, live);
	}
	const ids: string[] = [];
	for (const b of bs) {
		const prev = ids[ids.length - 1];
		ids.push(b.kind === "steps" ? `steps:${prev ?? ""}` : b.n.k === "user" ? (alias.current.get(b.n.uuid) ?? b.n.uuid) : stable(b.n));
	}
	return ids;
}

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
	{ v: "auto", icon: Sparkles, label: "自动", desc: "直接执行，有风险的才请求确认" },
	{ v: "default", icon: Hand, label: "每次询问", desc: "改文件、跑命令前都请求确认" },
	{ v: "plan", icon: ListChecks, label: "计划模式", desc: "只读不改，先出计划" },
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
		{ v: "", icon: Bot, label: "默认", desc: "用 Claude Code 的设置" },
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

/** readOnly：只能看（Codex 的会话），不给分叉 */
export function Conversation({ project, session, w, t, onFile, chosen, stream, status, scroller, reveal, readOnly }: { project: string; session: string; w: Walk; t: Tree; onFile: (path: string, diff: boolean) => void; chosen: string | null; stream: Stream; status: Status; scroller: RefObject<HTMLDivElement | null>; reveal: Reveal | null; readOnly?: boolean }) {
	const { approvals, runs } = useLive();
	const [agent, setAgent] = useState<Agent | null>(null);
	const [fork, setFork] = useState<ForkTarget | null>(null);
	// 看的是最新处：正在写的接在末尾
	const keys = useMemo(() => new Set(w.path.flatMap((n) => ("key" in n && n.key ? [n.key] : []))), [w.path]);
	const live = w.atLatest ? liveNodes(stream, w.path, keys) : [];
	const written = useMemo(() => blocks(w.path), [w.path]);
	const bs = append(written, live);
	const first = useWindow(bs, scroller, reveal);
	const ids = useIds(bs, stream.run, w.path);
	// 还在跑（mixer 里、或者终端里开着）：最后一组里还没结果的工具、正在写的那一步，带上 ping 点和耗时
	const busy = status === "running" || status === "waiting" || status === "terminal";
	const tail = bs[bs.length - 1];
	const last = busy && w.atLatest && tail?.kind === "steps" ? tail.nodes[tail.nodes.length - 1] : null;
	const liveAt = (n: Node) => stream.blocks.find((b) => `live:${b.key}` === n.uuid)?.at ?? Date.now();
	const now = last && ((last.k === "tool" && !last.result) || (last.k === "thinking" && isLive(last))) ? { node: last, since: isLive(last) ? liveAt(last) : Date.parse(last.ts) } : null;
	// 在跑，末尾却什么都没在动（等 Claude 开口、工具结果回来之后）：留一个 ping 点，知道它还活着
	const writing = live.length > 0 && live[live.length - 1].k === "assistant";
	const idle = !!stream.run && w.atLatest && !now && !writing && status !== "waiting";
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
	// 每条回复用了多久：从这一轮开头（你的消息，或者后台任务的通知把 Claude 叫起来）算起
	const spent = new Map<string, number>();
	let turn: number | null = null;
	for (const b of bs) {
		for (const n of b.kind === "one" ? [b.n] : b.nodes) {
			if (n.k === "user" || (n.k === "event" && n.kind === "task")) turn = Date.parse(n.ts);
			else if (n.k === "assistant" && turn !== null && !isLive(n)) spent.set(n.uuid, Date.parse(n.ts) - turn);
		}
	}
	const mine = approvals.filter((a) => runs.some((r) => r.id === a.run && r.session === session));

	const openAgent = useCallback(async (id: string) => {
		try {
			setAgent(await api<Agent>(`/api/sessions/${enc(project)}/${enc(session)}/agents/${id}`));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	}, [project, session]);
	// 不变的回调：消息组件是 memo 的
	const forkEdit = useCallback((n: User) => setFork({ kind: "edit", n }), []);
	const forkReply = useCallback((n: Node) => setFork({ kind: "at", at: n.uuid, what: "这条回复" }), []);
	const forkSteps = useCallback((ns: Node[]) => setFork({ kind: "at", at: pointOf(ns[ns.length - 1]), what: "这几步工具调用" }), []);

	return (
		<>
			{(first ? bs.slice(first) : bs).map((b, i) => {
				const head = headOf(b);
				const v = w.versions.get(head.uuid);
				return (
					<div key={ids[first + i]} className="flex flex-col gap-2">
						{v && <VersionSwitch v={v} best={t.best} />}
						{switched.has(head.uuid) && <EventLine n={{ k: "event", uuid: `model-${head.uuid}`, parent: null, ts: head.ts, kind: "info", text: `换成 ${pretty(switched.get(head.uuid) as string)}` }} />}
						{b.kind === "steps" ? (
							<Steps nodes={b.nodes} project={project} session={session} onAgent={openAgent} onFile={onFile} now={b === tail ? now : null} onFork={readOnly || b.nodes.some(isLive) ? undefined : forkSteps} />
						) : b.n.k === "user" ? (
							<UserMessage n={b.n} project={project} session={session} onFork={readOnly || isLive(b.n) ? undefined : forkEdit} />
						) : b.n.k === "assistant" ? (
							<AssistantMessage n={b.n} spent={spent.get(b.n.uuid)} onFork={readOnly || isLive(b.n) ? undefined : forkReply} />
						) : b.n.k === "event" ? (
							<EventLine n={b.n} onAgent={openAgent} />
						) : null}
					</div>
				);
			})}
			{idle && <StatusIcon s="running" className="-mt-2" />}
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
		toast.success("正在分叉，建好后自动打开");
		follow(r);
	}
	return r;
}

/** 为什么只能分叉（输入框里写的那句）；能继续就是 null */
function noContinue(w: Walk, status: Status): { reason: string; hint: string } | null {
	if (!w.atLatest) return { reason: "在看旧版本", hint: "在看旧版本，发送后从这里分叉" };
	if (status === "terminal") return { reason: "终端中打开", hint: "终端中打开着，发送后分叉" };
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
			<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" onClick={() => api(`/api/runs/${run.id}/stop`, {}).catch(() => {})} aria-label="停止" title="停止运行">
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
	const { follow, runs, queue } = useLive();
	const [text, setText] = useDraft(session);
	// 发出去的先记着，真写进会话记录才算数；没发出去的放回输入框
	const track = useOutbox(session, w.path, runs, queue, text, setText);
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
			const box = track(text, mode);
			box.sent(await start({ project, session, mode, at, prompt: text, images, permission, model: model || null }, follow));
			setText("");
			for (const s of shots) URL.revokeObjectURL(s.url);
			setShots([]);
		} catch (e) {
			// 连不上（断网、服务在重启）浏览器只给一句英文
			const m = e instanceof TypeError ? "连不上 mixer" : e instanceof Error ? e.message : String(e);
			toast.error(`没发出去：${m}，消息还在输入框里`);
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
					placeholder={why?.hint ?? (mode === "fork" ? "分叉出新会话…" : busyRun ? "运行中，发送后排队…" : "继续…")}
					className="max-h-48 min-h-11 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<div className="flex items-center gap-1.5">
					<OptionMenu
						title="发送方式"
						value={mode}
						onChange={(v) => setMode(v as "resume" | "fork")}
						options={[
							{ v: "resume", icon: MessageSquareText, label: "继续", desc: why ? `不可用：${why.reason}` : busyRun ? "运行中，先排队，结束后发出" : "接着这个会话", disabled: !!why },
							{ v: "fork", icon: GitFork, label: "分叉", desc: w.atLatest ? "开新会话，带上到最新处的对话，原会话不变" : "开新会话，带上到你正在看的地方的对话，原会话不变" },
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
						{target?.kind === "edit" ? "带上这条之前的对话开新会话，这条换成下面的内容。" : `带上到${target?.what ?? "这里"}为止的对话开新会话，发出下面的内容。`}原会话不变。
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

/** 这个会话排着队的消息：这次运行结束后一起发出。每条可以取消；也可以停下这次运行马上发 */
function QueuedMessages({ session }: { session: string }) {
	const { queue, runs } = useLive();
	const mine = queue.filter((q) => q.session === session);
	if (!mine.length) return null;
	const run = runs.find((r) => r.session === session && r.status === "running");
	return (
		<div className="flex flex-col items-end gap-2">
			{mine.map((q) => (
				<div key={q.id} className="flex max-w-[88%] flex-col items-end gap-1.5">
					<div className="rounded-2xl rounded-br-md border border-dashed bg-secondary/50 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-secondary-foreground">
						{q.prompt}
						{q.images > 0 && <Images className={q.prompt.trim() ? "mt-2" : undefined} srcs={Array.from({ length: q.images }, (_, i) => `/api/queue/${q.id}/image/${i}`)} />}
					</div>
					<div className="flex items-center gap-1 px-1 text-2xs text-muted-foreground">
						<Clock className="size-3" />
						<span>排队中</span>
						<Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={() => api(`/api/queue/${q.id}/cancel`, {}).catch(() => {})} aria-label="取消" title="取消">
							<X className="size-3.5" />
						</Button>
					</div>
				</div>
			))}
			{run && (
				<Button variant="ghost" size="xs" className="text-2xs text-muted-foreground" onClick={() => api(`/api/runs/${run.id}/stop`, {}).catch(() => {})} title="停止这次运行，排队的消息马上发出">
					<Square className="size-3" />
					停止并发送
				</Button>
			)}
		</div>
	);
}

export type Stream = { run: Run | null; blocks: LiveBlock[] };

/**
 * 这个会话上正在跑的那次运行，和它输出流里正在写的那几段。
 * 服务端也攒着一份：打开（刷新、断线重连）时先拿快照，之后按序号接推送来的事件；中间漏了就重新拿快照。
 * 每段写完才写进会话记录；对话末尾先用流里的顶上，样子和写进记录之后一样，记录里有了同一段（消息 id : 第几段）就换成记录里的
 */
export function useStream(session: string): Stream {
	const { runs } = useLive();
	const run = runs.find((r) => r.session === session && r.status === "running") ?? null;
	const id = run?.id ?? null;
	const [tail, setTail] = useState<Tail>(emptyTail);
	const cur = useRef<Tail>(tail);
	/** 正在拿快照：这期间推来的事件先攒着，快照到了接在后面 */
	const buffer = useRef<{ seq: number; event: unknown }[] | null>(null);
	// 一帧里常来好几段：只记下最新的，每帧最多画一次（页面在后台时不画，回来再画最新的）
	const frame = useRef<number | null>(null);
	const put = (t: Tail) => {
		cur.current = t;
		frame.current ??= requestAnimationFrame(() => {
			frame.current = null;
			setTail(cur.current);
		});
	};
	useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
	const sync = useCallback(() => {
		if (!id) return;
		buffer.current = [];
		api<Tail>(`/api/runs/${id}/tail`).then(
			(t) => {
				let next = t;
				for (const e of buffer.current ?? []) if (e.seq === next.seq + 1) next = step(next, e.event as Record<string, unknown>, Date.now());
				buffer.current = null;
				put(next);
			},
			() => { buffer.current = null; },
		);
	}, [id]);
	useEffect(() => { put(emptyTail()); sync(); }, [sync]);
	useEvent("reconnect", sync);
	useEvent("run-event", useCallback((e: { id: string; seq: number; event: Record<string, unknown> }) => {
		if (e.id !== id) return;
		if (buffer.current) return void buffer.current.push(e);
		const t = cur.current;
		if (e.seq <= t.seq) return;
		if (e.seq === t.seq + 1) put(step(t, e.event, Date.now()));
		else sync();
	}, [id, sync]));
	return { run, blocks: run ? tail.blocks : [] };
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

/**
 * 流里还没写进记录的那几段，变成和记录里一样的节点，接在对话末尾。
 * 你发的那条也一样：记录里出现之前先按原文顶上，不然流比文件快，会先看到思考、后看到你的消息
 */
function liveNodes(stream: Stream, path: Node[], keys: Set<string>): Node[] {
	const ts = new Date().toISOString();
	const r = stream.run;
	const mine: Node[] = !r || !r.prompt.trim() || sentNode(r, path) ? [] : [{ k: "user", uuid: liveUser(r) as string, parent: null, ts: r.started, text: r.prompt, images: 0 }];
	const blocks = stream.blocks.filter((b) => !keys.has(b.key));
	return [
		...mine,
		...blocks.flatMap((b, i): Node[] => {
			const base = { uuid: `live:${b.key}`, parent: null, ts, key: b.key };
			if (b.k === "tool") return [{ k: "tool", ...base, id: b.id, name: b.name, summary: liveSummary(b.json), input: b.json, result: null, resultUuid: null, agent: null }];
			// 思考有时是不给看的（空的）：记录里不会有能显示的节点，后面有了别的段就不再显示
			if (b.k === "thinking") return !b.text.trim() && i < blocks.length - 1 ? [] : [{ k: "thinking", ...base, text: b.text }];
			return b.text.trim() ? [{ k: "assistant", ...base, text: b.text }] : [];
		}),
	];
}
const isLive = (n: Node) => n.uuid.startsWith("live:");
const liveUser = (r: Run | null) => (r ? `live:user:${r.id}` : null);
/** 这次运行你发的那条已经写进记录了：运行开始之后（给一分钟时钟误差）记录里有同样的一句 */
function sentNode(r: Run | null, path: Node[]) {
	const asked = r?.prompt.trim();
	if (!r || !asked) return undefined;
	return path.find((n): n is User => n.k === "user" && n.text.trim() === asked && Date.parse(n.ts) >= Date.parse(r.started) - 60_000);
}
