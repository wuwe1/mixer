// 对话：把节点树走成一条路（默认走到命令行续接时接着的那条，记录里没写就是最新的那片叶子；地址里的 leaf 指定看哪个版本），一条消息改写过的地方放版本切换。
// 最后是正在跑的那次运行（实时的字）、这个会话排着队的消息、等你确认的请求。输入框在 composer.tsx，分叉的对话框在 fork-dialog.tsx。
import { ChevronLeft, ChevronRight, Clock, RotateCw, Square, TriangleAlert, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { type Spawn, spawner } from "@/lib/agents";
import { type Agent, api, enc, type Node, type Sub } from "@shared/api";
import { useEvent } from "@/lib/events";
import { type Status, useLive } from "@/lib/live";
import { pretty } from "@/lib/model";
import { go } from "@/lib/route";
import { type Block, blocks, headOf, isLive, liveNodes, pointOf, type Tree, type User, type Walk } from "@/lib/thread";
import { useIncremental } from "@/lib/use-incremental";
import type { Stream } from "@/lib/use-stream";
import { ForkDialog, type ForkTarget } from "./fork-dialog";
import { AssistantMessage, Bubble, EventLine, Steps, stable, UserMessage } from "./message";
import { Loading } from "./placeholder";
import { start } from "./prompt";
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
 *   你发的那条：uuid，写进记录前后一样（发的时候就定了）
 */
function idsOf(bs: Block[]) {
	const ids: string[] = [];
	for (const b of bs) {
		const prev = ids[ids.length - 1];
		ids.push(b.kind === "steps" ? `steps:${prev ?? ""}` : stable(b.n));
	}
	return ids;
}

/** 在跑，末尾却什么都没在动：留一个 ping 点，知道它还活着。和工具组收着时露出的那一步对齐：同样缩进、同样大小 */
function AliveDot() {
	return (
		<div className="-mt-3 flex py-1 pl-5.5">
			<StatusIcon s="running" className="size-3.5" />
		</div>
	);
}

/**
 * spawned：Agent 调用开出来的子代理怎么样了（lib/agents.ts）；
 * keys：记录里有的段（流里的哪几段已经写进去了，和 useStream 用的同一份）
 */
export function Conversation({ project, session, w, t, keys, onFile, chosen, chosenEffort, chosenPermission, stream, status, busy, scroller, reveal, spawned }: { project: string; session: string; w: Walk; t: Tree; keys: Set<string>; onFile: (path: string, diff: boolean) => void; chosen: string | null; chosenEffort: string | null; chosenPermission: string; stream: Stream; status: Status; busy: boolean; scroller: RefObject<HTMLDivElement | null>; reveal: Reveal | null; spawned?: Map<string, Spawn> | null }) {
	/** 开着看的子代理 */
	const [agent, setAgent] = useState<string | null>(null);
	const [fork, setFork] = useState<ForkTarget | null>(null);
	// 看的是最新处：正在写的接在末尾
	const live = w.atLatest ? liveNodes(stream, t.ids, keys) : [];
	const written = useMemo(() => blocks(w.path), [w.path]);
	const bs = blocks(live, written);
	const first = useWindow(bs, scroller, reveal);
	const ids = idsOf(bs);
	// 还在跑（busy：mixer 里在跑、待确认，或者终端里开着在跑）：最后一组里还没结果的工具、正在写的那一步，带上 ping 点和耗时
	const tail = bs[bs.length - 1];
	const last = busy && w.atLatest && tail?.kind === "steps" ? tail.nodes[tail.nodes.length - 1] : null;
	const liveAt = (n: Node) => stream.blocks.find((b) => `live:${b.key}` === n.uuid)?.at ?? Date.now();
	const now = last && ((last.k === "tool" && !last.result) || (last.k === "thinking" && isLive(last))) ? { node: last, since: isLive(last) ? liveAt(last) : Date.parse(last.ts) } : null;
	// 在跑，末尾却什么都没在动（等 Claude 开口、工具结果回来之后）：留一个 ping 点，知道它还活着
	const writing = live.length > 0 && live[live.length - 1].k === "assistant";
	const idle = !!stream.run && w.atLatest && !now && !writing && status !== "waiting";
	// 只看写进记录的（正在写的没有模型、不算用时），不用每来一个字就重算一遍
	const { switched, spent } = useMemo(() => {
		// 换过模型的地方：前一条回复和这一条用的模型不同，前面放一条分隔线
		const switched = new Map<string, string>();
		let prev: string | null = null;
		for (const b of written) {
			const ns = b.kind === "one" ? [b.n] : b.nodes;
			const m = ns.map((n) => ("ctx" in n ? n.ctx?.model : undefined)).find(Boolean);
			if (!m) continue;
			if (prev && m !== prev) switched.set(headOf(b).uuid, m);
			prev = m;
		}
		// 每条回复用了多久：从这一轮开头（你的消息，或者后台任务的通知把 Claude 叫起来）算起
		const spent = new Map<string, number>();
		let turn: number | null = null;
		for (const n of w.path) {
			if (n.k === "user" || (n.k === "event" && n.kind === "task")) turn = Date.parse(n.ts);
			else if (n.k === "assistant" && turn !== null) spent.set(n.uuid, Date.parse(n.ts) - turn);
		}
		return { switched, spent };
	}, [written, w.path]);

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
						{v && <VersionSwitch v={v} />}
						{switched.has(head.uuid) && <EventLine n={{ k: "event", uuid: `model-${head.uuid}`, parent: null, ts: head.ts, kind: "info", text: `换成 ${pretty(switched.get(head.uuid) as string)}` }} />}
						{b.kind === "steps" ? (
							<Steps nodes={b.nodes} project={project} session={session} onAgent={setAgent} onFile={onFile} now={b === tail ? now : null} onFork={b.nodes.some(isLive) ? undefined : forkSteps} spawns={spawned && b.nodes.some(spawner) ? spawned : undefined} />
						) : b.n.k === "user" ? (
							<UserMessage n={b.n} project={project} session={session} onFork={isLive(b.n) ? undefined : forkEdit} />
						) : b.n.k === "assistant" ? (
							<AssistantMessage n={b.n} spent={spent.get(b.n.uuid)} onFork={isLive(b.n) ? undefined : forkReply} last={b === tail} />
						) : b.n.k === "event" ? (
							// 正在重试的那行只在它是最后一条、还在跑时显示（重试过去了、跑完了就不用看了）
							b.n.kind === "retry" && !(b === tail && busy) ? null : <EventLine n={b.n} onAgent={setAgent} />
						) : null}
					</div>
				);
			})}
			{idle && <AliveDot />}
			<QueuedMessages session={session} />
			{!busy && <LastError project={project} session={session} last={w.path[w.path.length - 1]} choice={{ permission: chosenPermission, model: chosen, effort: chosenEffort }} />}

			<AgentSheet project={project} session={session} id={agent} running={agentRunning} onClose={closeAgent} onFile={onFile} />

			<ForkDialog project={project} session={session} w={w} chosen={chosen} chosenEffort={chosenEffort} chosenPermission={chosenPermission} target={fork} onClose={() => setFork(null)} />
		</>
	);
}

/**
 * 子代理的对话（从 Agent 工具调用、后台任务通知、子代理回报点开）。开着的时候它的记录一变（agent 事件）就带 version 拉增量，
 * 上一次还没回来就等它回来再拉一次；还在跑的，正在执行的那一步带 ping 点和耗时。停在底部时跟着往下滚，一打开就在最新处
 */
function AgentSheet({ project, session, id, running, onClose, onFile }: { project: string; session: string; id: string | null; running: boolean; onClose: () => void; onFile: (path: string, diff: boolean) => void }) {
	const box = useRef<HTMLDivElement>(null);
	const near = useRef(true);
	// 关上了不拉（看过的留着，再打开同一个先画它）。第一次就没拿到（还没有记录）：说一声、关上；跟着拉的时候出错，等下次
	const { data: a, load } = useIncremental<Agent>(id ? `/api/sessions/${enc(project)}/${enc(session)}/agents/${enc(id)}` : null, {
		onError: (e, first) => {
			if (!first) return;
			toast.error(e.message);
			onClose();
		},
	});
	useEffect(() => { if (id) near.current = true; }, [id]);
	useEvent("agent", useCallback((e: Sub & { project: string; session: string }) => { if (id && e.project === project && e.session === session && e.agentId === id) load(); }, [id, project, session, load]));
	useEvent("hello", load);
	useLayoutEffect(() => {
		const el = box.current;
		if (el && a && id && near.current) el.scrollTop = el.scrollHeight;
	}, [a, id]);
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
							{running && !now && <AliveDot />}
						</div>
					) : (
						<Loading className="h-full" />
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

function VersionSwitch({ v }: { v: { options: Node[]; index: number; to: (string | null)[] } }) {
	const to = (i: number) => go({ leaf: v.to[(i + v.options.length) % v.options.length] }, true);
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

/**
 * 最后出错了：对话末尾「重试」，续接一句「继续」（权限、模型、思考强度照这个会话选的）。两种来路：
 * 记录里最后一条是出错（命令行合成的 API Error：终端里跑的、服务重启过的也认得），出错那行已经画了，这里只给按钮；
 * mixer 里最近一次运行出错、记录里没有（命令行没接这条、进程挂了），这里写明原因。之后又写了别的就不显示
 */
function LastError({ project, session, last, choice }: { project: string; session: string; last: Node | undefined; choice: { permission: string; model: string | null; effort: string | null } }) {
	const { runs, follow } = useLive();
	const [busy, setBusy] = useState(false);
	const run = runs.find((r) => r.session === session);
	const inRecord = last?.k === "event" && last.kind === "error";
	const fromRun = run?.status === "error" && run.ended && (!last || Date.parse(run.ended) >= Date.parse(last.ts)) ? run : null;
	if (!inRecord && !fromRun) return null;
	const retry = async () => {
		setBusy(true);
		try {
			await start({ project, session, mode: "resume", prompt: "继续", uuid: crypto.randomUUID(), permission: choice.permission, model: choice.model, effort: choice.effort }, follow);
		} catch (e) {
			toast.error(`没发出去：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	};
	const button = (
		<Button variant="outline" size="xs" className="shrink-0" disabled={busy} onClick={retry}>
			{busy ? <Spinner /> : <RotateCw />}
			重试
		</Button>
	);
	if (inRecord) return <div className="-mt-2 flex justify-end">{button}</div>;
	return (
		<div className="flex items-start gap-2 rounded-md border border-destructive/30 px-3 py-2 text-xs">
			<TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
			<span className="min-w-0 flex-1 break-words text-destructive">出错了：{fromRun?.error || "不知道为什么"}</span>
			{button}
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
				<div key={q.id} className="flex w-full flex-col items-end gap-1.5">
					<Bubble queued text={q.prompt} srcs={Array.from({ length: q.images }, (_, i) => `/api/queue/${q.id}/image/${i}`)} />
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
