// 你写的消息不丢：输入框里的草稿随打随存；点了发送的先记进发件箱，真写进会话记录了才删。
// 每条发出去的带一个网页给的 uuid，到没到按它认（lib/arrival.ts）：没写进去的（运行结束了、拉回来的数据到了它结束时写到的地方还没有它；
// 排着队被取消、没发出去，服务重启了）放回输入框。都存在这台设备的 localStorage 里。
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import type { Queued, Run } from "@shared/api";
import { fate, type Item, later } from "./arrival";
import { useLive } from "./live";

const DRAFT = (key: string) => `mixer.draft.${key}`;
const OUTBOX = "mixer.outbox";
/** 这个页面（打开一次算一个）：请求还在路上的只有发它的页面知道 */
const TAB = crypto.randomUUID();

const load = (): Item[] => {
	try { return (JSON.parse(localStorage.getItem(OUTBOX) ?? "[]") as Item[]).filter((x) => typeof x?.uuid === "string"); } catch { return []; }
};
const save = (items: Item[]) => {
	try { localStorage.setItem(OUTBOX, JSON.stringify(items)); } catch {}
};
const update = (uuid: string, f: (x: Item) => Item | null) => save(load().flatMap((x) => (x.uuid === uuid ? (f(x) ?? []) : [x])));

/**
 * 输入框的内容，随打随存。key 是发到哪里（继续：会话；分叉：会话@分叉点；新会话：new.项目），用的地方换了 key 就整个重新挂载，key 不会变。
 * initial：没存过时先填上的（编辑并分叉：原来那条的字）；和它一样就不存
 */
export function useDraft(key: string, initial = "") {
	const [text, setText] = useState(() => {
		try { return localStorage.getItem(DRAFT(key)) ?? initial; } catch { return initial; }
	});
	useEffect(() => {
		try {
			if (text && text !== initial) localStorage.setItem(DRAFT(key), text);
			else localStorage.removeItem(DRAFT(key));
		} catch {}
	}, [key, text, initial]);
	return [text, setText] as const;
}

/**
 * 发件箱（只管继续）。track 在发送前记一条，返回的 sent / failed 记下请求的结果；之后对着记录、运行、队列看它（arrival.ts 的 fate）：
 * - 到了：删掉。请求没回来（报错了其实发出去了、请求没回来页面就刷新了，草稿又把它放了回来），输入框里还原样是这段：清掉，免得再发一遍
 * - 没发出去：放回输入框（接在已经写了的后面；输入框里本来就有的不重复放）
 * - 请求明确被拒（4xx）：马上删，字本来就还在输入框里；没回来的（连不上、超时）等运行、队列说了算
 * record：会话记录里有的 uuid、拉回来的数据到哪了；session 是 null（分叉、新会话的输入框）：不管
 */
export function useOutbox(session: string | null, record: { ids: Set<string>; version: string } | null, text: string, setText: (f: (t: string) => string) => void) {
	const { runs, queue, synced } = useLive();
	const now = useRef({ synced, version: record?.version ?? null });
	now.current = { synced, version: record?.version ?? null };
	const track = useCallback((uuid: string, text: string) => {
		save([...load(), { uuid, session: session ?? "", text, state: "sending", tab: TAB, gen: now.current.synced }]);
		return {
			sent: (r: Run | { queued: Queued }) => update(uuid, (x) => ({ ...x, state: "sent", where: "queued" in r ? "queue" : "run", gen: now.current.synced, mark: later(now.current.version) })),
			failed: (definite: boolean) => update(uuid, (x) => (definite ? null : { ...x, state: "unknown" })),
		};
	}, [session]);

	useEffect(() => {
		if (!session || !record) return;
		const items = load();
		const next: Item[] = [];
		const back: Item[] = [];
		const arrived: Item[] = [];
		for (const x of items) {
			if (x.session !== session) {
				next.push(x);
				continue;
			}
			const r = fate(x, { ids: record.ids, version: record.version, runs, queue, synced, tab: TAB });
			if (r.f === "arrived") arrived.push(x);
			else if (r.f === "lost") back.push(x);
			else if (r.f === "wait") next.push({ ...x, ...(r.where ? { where: r.where } : {}), ...(r.seen ? { seen: true } : {}), ...(r.mark ? { mark: r.mark } : {}) });
		}
		if (JSON.stringify(next) !== JSON.stringify(items)) save(next);
		// 请求没回来的（服务端其实收下了）：字还在输入框里，原样的清掉。回来了的发的时候已经拿掉了，不碰（输入框里可能是又打的一样的字）
		if (arrived.some((x) => x.state !== "sent" && x.text.trim() === text.trim())) setText(() => "");
		const missing = back.filter((x) => x.text.trim() && !text.includes(x.text.trim()));
		if (!missing.length) return;
		setText((t) => [t.trim() ? t : "", ...missing.map((x) => x.text)].filter(Boolean).join("\n\n"));
		toast(missing.length > 1 ? `${missing.length} 条消息没发出去，放回输入框了` : "消息没发出去，放回输入框了");
	}, [session, record, runs, queue, synced, text, setText]);

	return track;
}
