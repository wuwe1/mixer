// 这个会话上正在跑的那次运行，和它输出流里正在写的那几段。
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Hello, type Run } from "@shared/api";
import { useEvent } from "./events";
import { useLive } from "./live";
import { type Block, type Ev, emptyTail, step, type Tail } from "@shared/tail";
import { reached } from "./arrival";

/** run：正在跑的那次；of：blocks 是哪次的（正在跑的，或者跑完了、它写的还没全拉回来的那次） */
export type Stream = { run: Run | null; of: Run | null; blocks: Block[] };

/**
 * 服务端也攒着一份：打开（刷新、断线重连）时先拿快照，之后按序号接推送来的短事件（tail.ts 的 Ev）；中间漏了就重新拿快照。
 * 快照在 SSE 连上时的 hello 里就有（同一条流，之后的事件正好接在后面）；新开始的运行、中间漏了的，才去拿 /tail。
 * 每段写完才写进会话记录；对话末尾先用流里的顶上，样子和写进记录之后一样，记录里有了同一段（消息 id : 第几段）就换成记录里的。
 * 跑完时最后几段可能还没拉回来（会话的变化有节流，还要再拉一次）：留着，直到手里的数据（version）到了这次运行结束时记录写到的地方
 * （运行的 version）再整个收掉，不然最后那条回复会闪一下没了又回来；停下来时写了一半的那段也是这时收
 */
export function useStream(session: string, version: string | null): Stream {
	const { runs } = useLive();
	const run = runs.find((r) => r.session === session && r.status === "running") ?? null;
	const id = run?.id ?? null;
	const [tail, setTail] = useState<Tail>(emptyTail);
	const cur = useRef<Tail>(tail);
	/** cur 是哪次运行的：hello 里拿到快照时 id 还没跟上（live 那边的 runs 下一次画才有） */
	const mine = useRef<string | null>(null);
	/** 正在拿快照：这期间推来的事件先攒着，快照到了接在后面 */
	const buffer = useRef<{ seq: number; event: Ev }[] | null>(null);
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
		const rid = mine.current;
		if (!rid) return;
		const b: { seq: number; event: Ev }[] = [];
		buffer.current = b;
		api<Tail>(`/api/runs/${rid}/tail`).then(
			(t) => {
				// 等的时候 hello 来了（换了一份快照）、又开始拿了一次、换了运行：这份不要了
				if (buffer.current !== b || mine.current !== rid) return;
				let next = t;
				for (const e of b) if (e.seq === next.seq + 1) next = step(next, e.event, Date.now());
				buffer.current = null;
				put(next);
			},
			() => { if (buffer.current === b) buffer.current = null; },
		);
	}, []);
	// 新的一次运行才清掉、拿快照（hello 里已经拿到了的不用）；跑完了（id 没了）留着上一次的
	useEffect(() => {
		if (!id || mine.current === id) return;
		mine.current = id;
		put(emptyTail());
		sync();
	}, [id, sync]);
	// 连上了：hello 里有这个会话正在跑的那次的快照，直接换上
	useEvent("hello", useCallback((h: Hello) => {
		const r = h.runs.find((x) => x.session === session && x.status === "running");
		const t = r && h.tails[r.id];
		if (!r || !t) return;
		mine.current = r.id;
		buffer.current = null;
		put(t);
	}, [session]));
	useEvent("run-event", useCallback((e: { id: string; seq: number; event: Ev }) => {
		if (e.id !== mine.current) return;
		if (buffer.current) return void buffer.current.push(e);
		const t = cur.current;
		if (e.seq <= t.seq) return;
		if (e.seq === t.seq + 1) put(step(t, e.event, Date.now()));
		else sync();
	}, [sync]));
	// 跑完了的那次（mine 是它）：数据还没到它结束时的 version 就接着显示
	const ended = run ? null : (runs.find((r) => r.id === mine.current) ?? null);
	const of = run ?? (ended && !reached(version, ended.version) ? ended : null);
	return { run, of, blocks: of ? tail.blocks : [] };
}
