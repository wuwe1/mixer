// 一个会话：中间是对话和输入框；右边是面板（session-panel.tsx：目录、文件、改动）。
// 数据怎么拉、切回来先画上次的在 lib/session-data.ts，贴底和记下看到哪儿在 lib/scroll.ts。
// 打开着的会话跑完了，就算看过了。
import { ArrowDown, TriangleAlert, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { spawner, useSpawns, useSubs } from "@/lib/agents";
import { ApiError, api, type SessionMeta, temporary } from "@shared/api";
import { useSessionLive } from "@/lib/live";
import { clearNotices } from "@/lib/push";
import { go, type Route } from "@/lib/route";
import { spotOf, useSpot, useStick } from "@/lib/scroll";
import { useSessionData } from "@/lib/session-data";
import { keysOf, tree, type User, walk } from "@/lib/thread";
import { useStream } from "@/lib/use-stream";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { Conversation, type Reveal } from "./conversation";
import { Boundary, Placeholder } from "./placeholder";
import { SessionPanel } from "./session-panel";

export function SessionView({ project, root, session, r, meta }: { project: string; root: string | null; session: string; r: Route; meta: SessionMeta | undefined }) {
	const key = `${project}/${session}`;
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const [reveal, setReveal] = useState<Reveal | null>(null);
	const first = useRef(true);

	const { data, error, load } = useSessionData(project, session);
	// 状态用侧栏那份（看过之后会更新），还没有就用会话自己带的
	const live = useSessionLive(session, meta ?? data?.meta);
	const st = live.status;
	// 新会话、分叉刚开始跑，记录文件还没写出来（404）：等着，文件有了会推 session 过来再拉
	const starting = error instanceof ApiError && error.status === 404 && !!live.run;
	// 出错时整页换成「没打开」，滚动的那一层卸掉了；拉到了再挂上：靠它让挂在滚动层上的 effect 重新挂
	const failed = !!error && !data && !starting;
	const { away, unseen, toBottom } = useStick(scroller, content, failed);
	useSpot(key, scroller, content, failed);

	const nodes = data?.nodes;
	// 记录里有的段（消息 id 全局唯一，整个会话的一份就够）：流里的哪几段已经写进去了
	const keys = useMemo(() => keysOf(nodes ?? []), [nodes]);
	const stream = useStream(session, data?.version ?? null);
	const t = useMemo(() => (nodes ? tree(nodes) : null), [nodes]);
	const home = data?.leaf ?? null;
	const w = useMemo(() => (t ? walk(t, r.leaf, home) : null), [t, r.leaf, home]);
	// 子代理：Agent 调用下面画它在做什么；往上翻着的时候「↓」上带着还在跑的有几个
	const spawning = useMemo(() => !!nodes?.some(spawner), [nodes]);
	const subs = useSubs(project, session, spawning);
	// 在 mixer 里开着 claude 进程：后台子代理在不在跑看它报的后台任务；没有进程（终端里开的、进程退了）才猜
	const spawned = useSpawns(w ? w.path : null, subs, live.active, live.jobs);
	const working = spawned ? [...spawned.values()].filter((s) => s.running).length : 0;

	// 开着的会话跑完了（页面在前台）：算看过了；它的通知也收掉
	useEffect(() => {
		const mark = () => {
			if (document.visibilityState !== "visible") return;
			clearNotices(session);
			if (st === "done" || st === "error") api("/api/seen", { project, session }).catch(() => {});
		};
		mark();
		document.addEventListener("visibilitychange", mark);
		return () => document.removeEventListener("visibilitychange", mark);
	}, [st, project, session]);

	// 第一次打开：滚到最后，贴上；切回来的（离开时不在底部、那条还在这条路上）放回原处；
	// 跑完了还没看的：停在最后一条回复的开头（长回复不用从结尾往上翻；短的本来就到底了）
	useEffect(() => {
		if (!data || !w || !first.current) return;
		first.current = false;
		const spot = spotOf(key);
		const reply = st === "done" || st === "error" ? w.path.findLast((n) => n.k === "assistant") : undefined;
		if (spot && w.path.some((n) => n.uuid === spot.uuid)) setReveal({ ...spot, at: Date.now() });
		else if (reply) setReveal({ uuid: reply.uuid, at: Date.now(), offset: 12 });
		else requestAnimationFrame(() => toBottom());
	}, [data, w, key, toBottom, st]);

	// 刚发出去（排上队了，或者开始跑了）：不管刚才在哪，滚到最后贴上，让人看见
	const onSent = useCallback(() => requestAnimationFrame(() => toBottom(true)), [toBottom]);
	const onJump = useCallback((uuid: string) => setReveal({ uuid, at: Date.now() }), []);

	const rel = useCallback((abs: string) => (root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null), [root]);
	// 这个会话（连子代理）改过的文件：服务端照工具结果里结构化的那份给，这里只换成仓库里的相对路径
	const changed = data?.touched;
	const touched = useMemo(() => [...new Set((changed ?? []).flatMap((p) => rel(p) ?? []))], [changed, rel]);
	const onFile = useCallback((abs: string, diff: boolean) => {
		const p = rel(abs);
		if (!p) return void toast(`不在这个项目里：${abs}`);
		go({ panel: "files", file: p, view: diff ? "diff" : null });
	}, [rel]);
	const prompts = useMemo(() => w?.path.filter((n): n is User => n.k === "user") ?? [], [w]);

	if (failed && error)
		return (
			<Placeholder icon={temporary(error) ? WifiOff : TriangleAlert} title="没打开" text={temporary(error) ? `${error.message}，过一会儿自己再试` : error.message}>
				<Button variant="outline" size="sm" onClick={load}>重试</Button>
			</Placeholder>
		);

	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="relative flex min-h-0 flex-1 flex-col">
					{/* 原生滚动：shadcn 的 ScrollArea 里面是 display:table，长代码会把整栏撑宽 */}
					<div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
						<div ref={content} className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6 md:px-6">
							{t && w ? (
								<Boundary>
									<Conversation project={project} session={session} w={w} t={t} keys={keys} onFile={onFile} chosen={data?.model ?? null} chosenEffort={data?.effort ?? null} chosenPermission={data?.permission ?? "auto"} stream={stream} live={live} scroller={scroller} reveal={reveal} spawned={spawned} />
								</Boundary>
							) : (
								[0, 1, 2, 3].map((i) => <Skeleton key={i} className={cn("h-16", i % 2 ? "w-3/4" : "ml-auto w-2/3")} />)
							)}
						</div>
					</div>
					{away && (
						<Button variant="outline" size="icon" className="absolute right-4 bottom-3 rounded-full shadow-md" onClick={() => toBottom(true)} aria-label="回到最新" title={working ? `回到最新 · ${working} 个子代理在跑` : "回到最新"}>
							<ArrowDown className="size-4" />
							{unseen && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-unread" />}
							{/* 还在跑的子代理有几个：灰的小数字，不抢眼 */}
							{working > 0 && <span className="absolute -top-1 -left-1 flex h-4 min-w-4 items-center justify-center rounded-full border bg-background px-1 text-2xs leading-none tabular-nums text-muted-foreground">{working}</span>}
						</Button>
					)}
				</div>
				{w && t && data && <Composer project={project} session={session} w={w} ids={t.ids} version={data.version} live={live} windows={data.windows} chosen={data.model} chosenEffort={data.effort ?? null} chosenPermission={data.permission ?? "auto"} onSent={onSent} />}
			</div>
			<SessionPanel project={project} r={r} prompts={prompts} touched={touched} onJump={onJump} />
		</div>
	);
}
