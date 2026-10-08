// 子代理的对话（从 Agent 工具调用、后台任务通知、子代理回报点开），从右边出来。会话页（session.tsx）记着开的是哪个。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { toast } from "@/lib/toast";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { type Agent, enc, type Sub } from "@shared/api";
import { useEvent } from "@/lib/events";
import { scopeOf, SessionScope, useScope } from "@/lib/scope";
import { blocks } from "@/lib/thread";
import { useIncremental } from "@/lib/use-incremental";
import { cn } from "@/lib/utils";
import { AliveDot, AssistantMessage, Steps } from "./message";
import { StatusIcon } from "./side";

/**
 * 开着的时候它的记录一变（agent 事件）就带 version 拉增量，上一次还没回来就等它回来再拉一次；
 * 还在跑的（running），正在执行的那一步带 ping 点和耗时。停在底部时跟着往下滚，一打开就在最新处。
 * 里面的工具调用、思考拿详情时带上 ?agent=（再给一层 SessionScope），不能再点开别的子代理
 */
export function AgentSheet({ id, running, onClose }: { id: string | null; running: boolean; onClose: () => void }) {
	const { project, session, url, onFile } = useScope();
	const box = useRef<HTMLDivElement>(null);
	const near = useRef(true);
	// 关上了不拉（看过的留着，再打开同一个先画它）。第一次就没拿到（还没有记录）：说一声、关上；跟着拉的时候出错，等下次
	const { data: a, load } = useIncremental<Agent>(id ? url(`agents/${enc(id)}`) : null, {
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
	// 按画着的那个（关上的动画里 id 已经是 null 了）
	const agent = a?.id;
	const scope = useMemo(() => scopeOf(project, session, { agent, onFile }), [project, session, agent, onFile]);
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
						<SessionScope value={scope}>
							<div className="flex flex-col gap-4 p-4">
								{bs.map((b) =>
									b.kind === "steps" ? (
										<Steps key={b.nodes[0].uuid} nodes={b.nodes} now={b === tail ? now : null} />
									) : b.n.k === "assistant" ? (
										<AssistantMessage key={b.n.uuid} n={b.n} />
									) : b.n.k === "user" ? (
										<div key={b.n.uuid} className="rounded-lg border bg-muted/40 p-3 text-md whitespace-pre-wrap">{b.n.text}</div>
									) : null,
								)}
								{running && !now && <AliveDot />}
							</div>
						</SessionScope>
					) : (
						<div className="flex flex-col gap-4 p-4">
							{[0, 1, 2].map((i) => <Skeleton key={i} className={cn("h-16", i % 2 ? "w-2/3" : "w-full")} />)}
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
