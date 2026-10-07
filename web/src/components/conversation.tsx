// 对话：把节点树走成一条路（默认走到最新的那片叶子；地址里的 leaf 指定看哪个版本），一条消息改写过的地方放版本切换。
// 最后是正在跑的那次运行（实时的字）、这个会话排着队的消息、等你确认的请求。输入框在 composer.tsx，分叉的对话框在 fork-dialog.tsx。
import { ChevronLeft, ChevronRight, Clock, Square, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { type Spawn, spawner } from "@/lib/agents";
import { type Agent, api, enc, type Node, type Run, type Sub } from "@/lib/api";
import { useEvent } from "@/lib/events";
import { type Status, useLive } from "@/lib/live";
import { type Agent as Kind, pretty } from "@/lib/model";
import { go } from "@/lib/route";
import { append, type Block, blocks, headOf, isLive, keysOf, liveNodes, liveUser, merge, pointOf, sentNode, type Tree, type User, type Walk } from "@/lib/thread";
import type { Stream } from "@/lib/use-stream";
import { ApprovalCard } from "./approvals";
import { ForkDialog, type ForkTarget } from "./fork-dialog";
import { Images } from "./lightbox";
import { AssistantMessage, EventLine, Steps, stable, UserMessage } from "./message";
import { StatusIcon } from "./side";

/** 跳到这条（目录里点的）；at 让同一条点两次也算 */
/** 跳到一条：带 offset 是放回原处（切回会话时），不动画，让它的顶边离滚动区顶部 offset 像素 */
export type Reveal = { uuid: string; at: number; offset?: number };

const STEP = 60;

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
	const offset = useRef<number | undefined>(undefined);
	const scrollTo = (uuid: string) => {
		const at = offset.current;
		requestAnimationFrame(() => {
			const el = document.getElementById(`n-${uuid}`);
			const box = scroller.current;
			if (!el) return;
			if (at === undefined || !box) return el.scrollIntoView({ behavior: "smooth", block: "start" });
			box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - at;
		});
	};
	useEffect(() => {
		if (!reveal) return;
		offset.current = reveal.offset;
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

/** kind：Claude Code 还是 Codex 的会话（分叉时模型、说法不一样）；spawned：Agent 调用开出来的子代理怎么样了（lib/agents.ts） */
export function Conversation({ project, session, w, t, onFile, chosen, chosenEffort, stream, status, scroller, reveal, kind = "claude", spawned }: { project: string; session: string; w: Walk; t: Tree; onFile: (path: string, diff: boolean) => void; chosen: string | null; chosenEffort: string | null; stream: Stream; status: Status; scroller: RefObject<HTMLDivElement | null>; reveal: Reveal | null; kind?: Kind; spawned?: Map<string, Spawn> | null }) {
	const { approvals, runs } = useLive();
	/** 开着看的子代理 */
	const [agent, setAgent] = useState<string | null>(null);
	const [fork, setFork] = useState<ForkTarget | null>(null);
	// 看的是最新处：正在写的接在末尾
	const keys = useMemo(() => keysOf(w.path), [w.path]);
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

	const closeAgent = useCallback(() => setAgent(null), []);
	const agentRunning = !!agent && !!spawned && [...spawned.values()].some((s) => s.agentId === agent && s.running);
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
							<Steps nodes={b.nodes} project={project} session={session} onAgent={setAgent} onFile={onFile} now={b === tail ? now : null} onFork={b.nodes.some(isLive) ? undefined : forkSteps} spawns={spawned && b.nodes.some(spawner) ? spawned : undefined} />
						) : b.n.k === "user" ? (
							<UserMessage n={b.n} project={project} session={session} onFork={isLive(b.n) ? undefined : forkEdit} />
						) : b.n.k === "assistant" ? (
							<AssistantMessage n={b.n} spent={spent.get(b.n.uuid)} onFork={isLive(b.n) ? undefined : forkReply} last={b === tail} />
						) : b.n.k === "event" ? (
							<EventLine n={b.n} onAgent={setAgent} />
						) : null}
					</div>
				);
			})}
			{/* 和工具组收着时露出的那一步对齐：同样缩进、同样大小 */}
			{idle && (
				<div className="-mt-3 flex py-1 pl-5.5">
					<StatusIcon s="running" className="size-3.5" />
				</div>
			)}
			<QueuedMessages session={session} />
			{mine.map((a) => <ApprovalCard key={a.id} a={a} run={runs.find((r) => r.id === a.run)} className="border-waiting/50" />)}

			<AgentSheet project={project} session={session} id={agent} running={agentRunning} onClose={closeAgent} onFile={onFile} />

			<ForkDialog project={project} session={session} w={w} chosen={chosen} chosenEffort={chosenEffort} target={fork} agent={kind} onClose={() => setFork(null)} />
		</>
	);
}

/**
 * 子代理的对话（从 Agent 工具调用、后台任务通知、子代理回报点开）。开着的时候它的记录一变（agent 事件）就带 version 拉增量，
 * 上一次还没回来就等它回来再拉一次；还在跑的，正在执行的那一步带 ping 点和耗时。停在底部时跟着往下滚，一打开就在最新处
 */
function AgentSheet({ project, session, id, running, onClose, onFile }: { project: string; session: string; id: string | null; running: boolean; onClose: () => void; onFile: (path: string, diff: boolean) => void }) {
	const [a, setA] = useState<Agent | null>(null);
	const cur = useRef<Agent | null>(null);
	const pulling = useRef<{ id: string; again: boolean } | null>(null);
	const box = useRef<HTMLDivElement>(null);
	const near = useRef(true);
	const load = useCallback((agentId: string) => {
		if (pulling.current?.id === agentId) return void (pulling.current.again = true);
		pulling.current = { id: agentId, again: false };
		const done = () => {
			const p = pulling.current;
			if (p?.id !== agentId) return;
			pulling.current = null;
			if (p.again) load(agentId);
		};
		const since = cur.current?.id === agentId ? `?since=${enc(cur.current.version)}` : "";
		api<Agent>(`/api/sessions/${enc(project)}/${enc(session)}/agents/${agentId}${since}`).then(
			(d) => {
				if (pulling.current?.id === agentId) {
					cur.current = merge(cur.current?.id === agentId ? cur.current : null, d);
					setA(cur.current);
				}
				done();
			},
			(e: Error) => {
				// 第一次就没拿到（还没有记录）：说一声、关上；跟着拉的时候出错，等下次
				if (pulling.current?.id === agentId && cur.current?.id !== agentId) {
					toast.error(e.message);
					onClose();
				}
				done();
			},
		);
	}, [project, session, onClose]);
	useEffect(() => {
		pulling.current = null;
		if (!id) return;
		cur.current = null;
		setA(null);
		near.current = true;
		load(id);
	}, [id, load]);
	useEvent("agent", useCallback((e: Sub & { project: string; session: string }) => { if (id && e.project === project && e.session === session && e.agentId === id) load(id); }, [id, project, session, load]));
	useEvent("reconnect", useCallback(() => { if (id) load(id); }, [id, load]));
	useLayoutEffect(() => {
		const el = box.current;
		if (el && a && near.current) el.scrollTop = el.scrollHeight;
	}, [a]);
	const bs = useMemo(() => (a ? blocks(a.nodes) : []), [a]);
	const tail = bs[bs.length - 1];
	const last = running && tail?.kind === "steps" ? tail.nodes[tail.nodes.length - 1] : null;
	const now = last?.k === "tool" && !last.result ? { node: last, since: Date.parse(last.ts) } : null;
	return (
		<Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
			<SheetContent side="right" className="w-full p-0 sm:max-w-2xl">
				<SheetHeader className="border-b">
					<SheetTitle className="flex items-center gap-2">
						{running && <StatusIcon s="running" />}
						子代理：{a?.info.agentType ?? id}
					</SheetTitle>
					<SheetDescription>{a?.info.description}</SheetDescription>
				</SheetHeader>
				{/* 原生滚动：ScrollArea 里面是 display:table，长代码会把整栏撑宽 */}
				<div ref={box} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" onScroll={(e) => { const el = e.currentTarget; near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
					{a ? (
						<div className="flex flex-col gap-4 p-4">
							{bs.map((b) =>
								b.kind === "steps" ? (
									<Steps key={b.nodes[0].uuid} nodes={b.nodes} project={project} session={session} agent={a.id} onFile={onFile} now={b === tail ? now : null} />
								) : b.n.k === "assistant" ? (
									<AssistantMessage key={b.n.uuid} n={b.n} />
								) : b.n.k === "user" ? (
									<div key={b.n.uuid} className="rounded-lg border bg-muted/40 p-3 text-md whitespace-pre-wrap">{b.n.text}</div>
								) : null,
							)}
							{running && !now && (
								<div className="-mt-3 flex py-1 pl-5.5">
									<StatusIcon s="running" className="size-3.5" />
								</div>
							)}
						</div>
					) : (
						<div className="flex h-full">
							<Spinner className="m-auto text-muted-foreground" />
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
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
				<Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => api(`/api/runs/${run.id}/stop`, {}).catch(() => {})} title="停止这次运行，排队的消息马上发出">
					<Square className="size-3" />
					停止并发送
				</Button>
			)}
		</div>
	);
}
