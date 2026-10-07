// 会话记录（Claude Code、Codex 都是）按行读
import { createReadStream } from "node:fs";

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
