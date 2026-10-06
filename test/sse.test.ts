// sse.ts：连上先发 hello，算 hello 的时候来的事件攒着、接在 hello 后面
import assert from "node:assert/strict";
import { test } from "node:test";
import { emit, frame, join, leave } from "../server/sse.ts";

/** 假的连接：记下写出去的事件名 */
const conn = () => {
	const got: string[] = [];
	let ended = false;
	return { got, ended: () => ended, write: (m: string) => { for (const [, t] of m.matchAll(/^event: (.+)$/gm)) got.push(t); }, end: () => { ended = true; } };
};

test("hello 先发，算它的时候来的事件攒着接在后面，之后的直接推", async () => {
	const c = conn();
	let done!: (v: unknown) => void;
	const p = join(c, () => new Promise((ok) => { done = ok; }));
	emit("run", { id: "r1" });
	emit("run-event", { id: "r1", seq: 1 });
	assert.deepEqual(c.got, []);
	done({ runs: [] });
	await p;
	assert.deepEqual(c.got, ["hello", "run", "run-event"]);
	emit("approval", {});
	assert.deepEqual(c.got, ["hello", "run", "run-event", "approval"]);
	leave(c);
	emit("ping", {});
	assert.equal(c.got.length, 4);
});

test("hello 里同步拿的是发出去那一刻的：await 之后才拿", async () => {
	const c = conn();
	let n = 0;
	const p = join(c, async () => ({ w: await Promise.resolve("ws"), n }));
	n = 2;
	const out: string[] = [];
	c.write = (m: string) => void out.push(m);
	await p;
	assert.equal(out[0], frame("hello", { w: "ws", n: 2 }));
	leave(c);
});

test("等 hello 的时候断了：什么都不写；算不出来：断开，别人照常收", async () => {
	const gone = conn();
	let done!: (v: unknown) => void;
	const p = join(gone, () => new Promise((ok) => { done = ok; }));
	leave(gone);
	done({});
	await p;
	assert.deepEqual(gone.got, []);

	const bad = conn();
	await assert.rejects(join(bad, async () => { throw new Error("坏了"); }));
	assert.ok(bad.ended());
	const ok = conn();
	await join(ok, async () => ({}));
	emit("queue", []);
	assert.deepEqual(bad.got, []);
	assert.deepEqual(ok.got, ["hello", "queue"]);
	leave(ok);
});
