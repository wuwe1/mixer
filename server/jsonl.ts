// 会话记录（Claude Code、Codex、pi 的）两边共用的：按行读、接着上次读到的地方读、截短、读过的留多少
import { createReadStream, type Stats } from "node:fs";

/**
 * 记录只会往后追加：记下读到哪个字节，文件变了只读新写的部分。
 * 没变（大小、修改时间都一样）就是 "same"；变短了或者换了个文件（inode 不同）就得从头读
 */
export type Cursor = { ino: number; size: number; mtime: number; offset: number };
export const resume = (c: Cursor | undefined, st: Stats) =>
	!c || c.ino !== st.ino || st.size < c.offset ? "fresh" : c.size === st.size && c.mtime === st.mtimeMs ? "same" : "more";

/**
 * 新的 epoch（「epoch:rev」的前一半，从头读一份记录时给）：后给的比先给的大（毫秒 × 1000 往上数，服务重启过也接着大）。
 * 同一个文件同时只留一份读好的，后给的 epoch 是在先给的之后从头读的：里面有那之前写的全部。网页靠这个比两个版本谁新（lib/thread.ts 的 reached）
 */
let lastEpoch = 0;
export const epoch = () => String((lastEpoch = Math.max(lastEpoch + 1, Date.now() * 1000)));

/** 节点里只放开头：工具结果、思考（推理摘要）的预览多长；点开给多长 */
export const CUT = 4000;
export const cut = (s: string, n = CUT) => (s.length > n ? { text: s.slice(0, n), cut: true } : { text: s, cut: false });
export const BRIEF_RESULT = 120;
export const BRIEF_THOUGHT = 120;

/**
 * 读过的会话留在内存里，按最近用过的排（keep 一次挪到最后）；加起来超过 budget（按文件大小算）就丢掉最久没用的。正在用的那个不丢
 */
export function lru<T extends { size: number }>(budget: number) {
	const m = new Map<string, T>();
	return Object.assign(m, {
		keep(key: string, v: T) {
			m.delete(key);
			m.set(key, v);
			let total = 0;
			for (const x of m.values()) total += x.size;
			for (const [k, x] of m) {
				if (total <= budget || k === key) break;
				m.delete(k);
				total -= x.size;
			}
		},
	});
}

/**
 * 从 start 字节起按 \n 一行一行读，带上这一行（连 \n）结束的位置，下次从那里接着读。
 * 不用 node:readline：它把 U+2028、U+2029 也当换行，而工具结果里会出现这两个字符，一条记录就被切断了。
 * 最后没有 \n 的半行不给：可能还没写完，下次从它开头接着读
 */
export async function* lines(file: string, start = 0): AsyncGenerator<{ line: string; end: number }> {
	let pos = start;
	const parts: Buffer[] = [];
	for await (const chunk of createReadStream(file, { start, highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
		let from = 0;
		let i: number;
		while ((i = chunk.indexOf(10, from)) >= 0) {
			parts.push(chunk.subarray(from, i));
			const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString("utf8");
			parts.length = 0;
			yield { line, end: pos + i + 1 };
			from = i + 1;
		}
		if (from < chunk.length) parts.push(chunk.subarray(from));
		pos += chunk.length;
	}
}

/**
 * 同一个文件一次只让一个人往下读：两个同时从同一处接着读，新的记录会算两遍；同时整份重读，后写完的盖掉先写完的、节点的改动丢了。
 * 排队用的只留「轮到下一个」，不留读出来的结果（不然这里攥着每个会话读过的全部内容，缓存的上限就没用了），排完了删掉
 */
const locks = new Map<string, Promise<void>>();
export function serial<T>(key: string, f: () => Promise<T>): Promise<T> {
	const p = (locks.get(key) ?? Promise.resolve()).then(f, f);
	const next = p.then(() => {}, () => {});
	locks.set(key, next);
	next.then(() => { if (locks.get(key) === next) locks.delete(key); });
	return p;
}
