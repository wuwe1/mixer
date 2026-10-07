// 发出去的那条到没到：纯函数，不碰 React（outbox.ts、use-stream.ts 用，测试也用）。
// 每条发出去的带一个网页给的 uuid：记录里那条就用它（排队的几条合成一条时另给一个，运行的 merged 记着带了哪几条）。不比字、不看时间。
import type { Queued, Run } from "@shared/api.ts";

/**
 * 手里的数据（version）到没到 want 这个版本：同一个 epoch 比 rev；epoch 不同的，后给的那个新（服务端的 epoch 越晚越大，server/jsonl.ts）。
 * want 是 null：没有记录，没什么可等的；undefined：还不知道（运行刚结束、服务端还没算出来）
 */
export function reached(have: string | null | undefined, want: string | null | undefined) {
	if (want === null) return true;
	if (!want || !have) return false;
	const [he, hr] = have.split(":").map(Number);
	const [we, wr] = want.split(":").map(Number);
	return he > we || (he === we && hr >= wr);
}

/** 比 version 晚一个 epoch 的（服务重启过、从头重读过才到得了）：rev 写成 Infinity，reached 照样比 */
export const later = (version: string | null | undefined) => (version ? `${version.split(":")[0]}:Infinity` : undefined);

/**
 * 发件箱里的一条（存在 localStorage）。state：sending 请求在路上；sent 服务端收下了；unknown 请求没回来（连不上、超时），不知道收没收到。
 * where：在哪（回复说的，或者在运行、队列里见过）；seen：在运行、队列里见过；
 * mark：它在的那次运行要是从运行列表里没了（服务重启过），数据到了这里还没有它才算丢了（跑完了的是运行结束时的 version，在跑的是 later）；
 * tab、gen：哪个页面发的、那时这个页面来过几次 hello
 */
export type Item = { uuid: string; session: string; text: string; state: "sending" | "sent" | "unknown"; where?: "run" | "queue"; seen?: boolean; mark?: string; tab: string; gen: number };

/** 现在知道的：记录里有的 uuid（thread.ts 的 idsOf）、数据到哪了、运行、队列、这个页面来过几次 hello（0：还没连上，运行、队列还不作数）、这个页面 */
export type Known = { ids: Set<string>; version: string | null; runs: Run[]; queue: Queued[]; synced: number; tab: string };

/**
 * arrived 写进记录了；lost 没发出去，放回输入框；gone 服务端根本没收到（请求没回来的那种：字本来就还在输入框里，忘掉就行）；
 * wait 接着等（带上新知道的 where、seen、mark）
 */
export type Fate = { f: "arrived" | "lost" | "gone" } | { f: "wait"; where?: "run" | "queue"; seen?: boolean; mark?: string };

export function fate(x: Item, k: Known): Fate {
	const run = k.runs.find((r) => r.merged.includes(x.uuid));
	if (k.ids.has(x.uuid) || (run?.uuid && k.ids.has(run.uuid))) return { f: "arrived" };
	if (run) {
		if (run.status === "running") return { f: "wait", where: "run", seen: true, mark: later(k.version) };
		// 跑完了：数据到了它结束时记录写到的地方，还没有这条，就是没写进去（claude 没接、一开始就出错）
		if (run.version === undefined) return { f: "wait", where: "run", seen: true };
		return reached(k.version, run.version) ? { f: "lost" } : { f: "wait", where: "run", seen: true, mark: run.version ?? undefined };
	}
	if (k.queue.some((q) => q.uuid === x.uuid)) return { f: "wait", where: "queue", seen: true };
	// 运行、队列里都没有。还没连上、这个页面的请求还在路上：等着
	if (!k.synced || (x.tab === k.tab && x.state === "sending")) return { f: "wait" };
	// 排着队的没了（取消了、没发出去、服务重启了）：排队的发出去时，带着它的运行先推过来、队列后推，所以不会是到了。
	// 回复说排上了、还没见过的：同一个页面等推送（可能比回复晚到），来过下一次 hello 还没有就是没了
	if (x.where === "queue") return x.seen || x.tab !== k.tab || k.synced > x.gen ? { f: "lost" } : { f: "wait" };
	// 运行没了（服务重启过）：记录里可能已经有它，等数据从头重读过（新的 epoch）再说
	if (x.where === "run") return x.mark && reached(k.version, x.mark) ? { f: "lost" } : { f: "wait" };
	return { f: "gone" };
}
