// 你写的消息不丢：输入框里的草稿随打随存；点了发送的先记进发件箱，真写进会话记录了才删。
// 发送请求失败、运行一开始就出错、排着队服务重启了（队列只在内存里），都放回输入框。都存在这台设备的 localStorage 里。
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import type { Node, Queued, Run } from "./api";

type Item = { id: string; session: string; text: string; at: number; mode: string; run?: string; queued?: string };

const DRAFT = (session: string) => `mixer.draft.${session}`;
const OUTBOX = "mixer.outbox";

const load = (): Item[] => {
	try { return JSON.parse(localStorage.getItem(OUTBOX) ?? "[]"); } catch { return []; }
};
const save = (items: Item[]) => {
	try { localStorage.setItem(OUTBOX, JSON.stringify(items)); } catch {}
};

/** 输入框的内容，随打随存；换会话时换成那个会话的 */
export function useDraft(session: string) {
	const [text, setText] = useState(() => localStorage.getItem(DRAFT(session)) ?? "");
	const was = useRef(session);
	useEffect(() => {
		if (was.current === session) return;
		was.current = session;
		setText(localStorage.getItem(DRAFT(session)) ?? "");
	}, [session]);
	useEffect(() => {
		try {
			if (text) localStorage.setItem(DRAFT(session), text);
			else localStorage.removeItem(DRAFT(session));
		} catch {}
	}, [session, text]);
	return [text, setText] as const;
}

/**
 * 发件箱。track 在发送前记一条，sent 记下请求的结果；之后对着会话记录、运行、队列看它到了没有：
 * - 记录里出现了（排队的会和别的合成一条，所以看「包含」）：到了。输入框里还原样是这段（请求报错了其实发出去了、
 *   请求没回来页面就刷新了，草稿又把它放了回来）：清掉，免得再发一遍
 * - 分叉、新会话：运行拿到了新会话的 id、没出错，就是到了；运行跑完了也是
 * - 运行出错、被停了，记录里却没有；服务重启过，运行、队列里都找不到了；请求失败了：过了 20 秒还没出现，
 *   放回输入框（接在已经写了的后面；输入框里本来就有的不重复放）
 * 请求失败也不马上删：服务端可能已经收到了，只是回不来
 */
export function useOutbox(session: string, path: Node[], runs: Run[], queue: Queued[], text: string, setText: (f: (t: string) => string) => void) {
	const track = useCallback((text: string, mode: string) => {
		const item: Item = { id: crypto.randomUUID(), session, text, at: Date.now(), mode };
		save([...load(), item]);
		return {
			sent: (r: { id?: string; queued?: { id: string } }) => save(load().map((x) => (x.id === item.id ? { ...x, run: r.queued ? undefined : r.id, queued: r.queued?.id } : x))),
		};
	}, [session]);

	const [tick, setTick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setTick((n) => n + 1), 5000);
		return () => clearInterval(t);
	}, []);

	useEffect(() => {
		void tick;
		const items = load();
		const keep: Item[] = [];
		const back: Item[] = [];
		const arrived: Item[] = [];
		for (const x of items) {
			if (x.session !== session) {
				keep.push(x);
				continue;
			}
			const written = path.some((n) => n.k === "user" && n.text.includes(x.text.trim()) && Date.parse(n.ts) >= x.at - 60_000);
			const run = x.run ? runs.find((r) => r.id === x.run) : undefined;
			const forked = x.mode !== "resume" && !!run?.session && run.status !== "error";
			if (written || forked || run?.status === "done") {
				arrived.push(x);
				continue;
			}
			const busy = runs.some((r) => r.session === session && r.status === "running");
			const alive = run ? run.status === "running" : (x.queued && queue.some((q) => q.id === x.queued)) || busy;
			if (!alive && Date.now() - x.at > 20_000) back.push(x);
			else keep.push(x);
		}
		if (!back.length && !arrived.length) return;
		save(keep);
		const sent = new Set(arrived.map((x) => x.text.trim()));
		if (sent.has(text.trim())) setText(() => "");
		const missing = back.filter((x) => !text.includes(x.text.trim()));
		if (!missing.length) return;
		setText((t) => [t.trim() ? t : "", ...missing.map((x) => x.text)].filter(Boolean).join("\n\n"));
		toast.warning(missing.length > 1 ? `${missing.length} 条消息没发出去，放回输入框了` : "消息没发出去，放回输入框了");
	}, [session, path, runs, queue, tick, text, setText]);

	return track;
}
