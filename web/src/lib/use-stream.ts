// 这个会话上正在跑的那次运行，和它输出流里正在写的那几段。
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Run } from "./api";
import { useEvent } from "./events";
import { useLive } from "./live";
import { type Block, emptyTail, step, type Tail } from "./tail";

export type Stream = { run: Run | null; blocks: Block[] };

/** 跑完了最多再等这么久，等最后几段写进记录 */
const LINGER = 10_000;

/**
 * 服务端也攒着一份：打开（刷新、断线重连）时先拿快照，之后按序号接推送来的事件；中间漏了就重新拿快照。
 * 每段写完才写进会话记录；对话末尾先用流里的顶上，样子和写进记录之后一样，记录里有了同一段（消息 id : 第几段）就换成记录里的。
 * written：记录里已经有的段。跑完时最后几段可能还没拉回来（会话的变化有节流，还要再拉一次）：先留着，记录里都有了再收，
 * 不然最后那条回复会闪一下没了又回来
 */
export function useStream(session: string, written: Set<string>): Stream {
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
	// 新的一次运行才清掉；跑完了（id 没了）留着上一次的
	useEffect(() => { if (id) { put(emptyTail()); sync(); } }, [id, sync]);
	useEvent("reconnect", sync);
	useEvent("run-event", useCallback((e: { id: string; seq: number; event: Record<string, unknown> }) => {
		if (e.id !== id) return;
		if (buffer.current) return void buffer.current.push(e);
		const t = cur.current;
		if (e.seq <= t.seq) return;
		if (e.seq === t.seq + 1) put(step(t, e.event, Date.now()));
		else sync();
	}, [id, sync]));
	const [late, setLate] = useState(false);
	useEffect(() => {
		setLate(false);
		if (id) return;
		const t = setTimeout(() => setLate(true), LINGER);
		return () => clearTimeout(t);
	}, [id]);
	// 还有能看见的段（工具调用、有字的回复和思考）没写进记录
	const left = !run && !late && tail.blocks.some((b) => (b.k === "tool" || b.text.trim()) && !written.has(b.key));
	return { run, blocks: run || left ? tail.blocks : [] };
}
