// tail.ts：运行输出流 → 短事件 → 正在写的那几段
import assert from "node:assert/strict";
import { test } from "node:test";
import { coalesce, emptyTail, type Ev, project, step, summarize, type Tail } from "../shared/tail.ts";

const ev = (event: object) => ({ type: "stream_event", event });
const start = (id: string) => ev({ type: "message_start", message: { id } });
const block = (index: number, content_block: object) => ev({ type: "content_block_start", index, content_block });
const delta = (index: number, d: object) => ev({ type: "content_block_delta", index, delta: d });
const stop = (index: number) => ev({ type: "content_block_stop", index });

/** 命令行的输出 → 推出去的短事件（扔掉的不算） */
const kept = (evs: object[]) => evs.map(project).filter((e) => e !== null);
const fold = (evs: Ev[], t = emptyTail()) => evs.reduce<Tail>((t, e, i) => step(t, e, 1000 + i), t);
/** 不看开始时间 */
const shape = (t: Tail) => t.blocks.map(({ at: _, ...b }) => b);

/** 一条消息：思考、文字、工具参数各一段，还有页面用不着的签名、ping、stop、message_delta、空的增量 */
const raw = [
	ev({ type: "ping" }),
	start("msg_1"),
	block(0, { type: "thinking", thinking: "" }),
	delta(0, { type: "thinking_delta", thinking: "" }),
	delta(0, { type: "thinking_delta", thinking: "想" }),
	delta(0, { type: "signature_delta", signature: "sig" }),
	delta(0, { type: "thinking_delta", thinking: "一想" }),
	stop(0),
	block(1, { type: "text", text: "" }),
	delta(1, { type: "text_delta", text: "我来" }),
	delta(1, { type: "text_delta", text: "看看" }),
	stop(1),
	block(2, { type: "tool_use", id: "toolu_1", name: "Bash", input: {} }),
	delta(2, { type: "input_json_delta", partial_json: '{"command":' }),
	delta(2, { type: "input_json_delta", partial_json: '"ls"}' }),
	stop(2),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
	ev({ type: "message_stop" }),
	{ type: "assistant", message: { id: "msg_1", content: [] } },
	{ type: "user", message: { content: [] } },
];

test("project：只留 step 用得着的", () => {
	assert.deepEqual(kept(raw), [
		["m", "msg_1"],
		["b", 0, "thinking"],
		["d", 0, "想"],
		["d", 0, "一想"],
		["b", 1, "text"],
		["d", 1, "我来"],
		["d", 1, "看看"],
		["b", 2, "tool", "toolu_1", "Bash"],
		["d", 2, '{"command":'],
		["d", 2, '"ls"}'],
	]);
	assert.equal(project(block(0, { type: "server_tool_use" })), null);
	assert.equal(project({ type: "stream_event" }), null);
	assert.deepEqual(project(block(3, { type: "tool_use" })), ["b", 3, "tool", "", "工具"]);
});

test("思考、文字、工具参数各一段，key 是「消息 id : 第几段」；序号只数留下的", () => {
	const t = fold(kept(raw));
	assert.equal(t.seq, 10);
	assert.equal(t.msg, "msg_1");
	assert.deepEqual(t.blocks, [
		{ k: "thinking", text: "想一想", key: "msg_1:0", at: 1001 },
		{ k: "text", text: "我来看看", key: "msg_1:1", at: 1004 },
		{ k: "tool", id: "toolu_1", name: "Bash", json: '{"command":"ls"}', key: "msg_1:2", at: 1007 },
	]);
});

test("只留这条消息和上一条的段", () => {
	const t = fold(kept([start("m1"), block(0, { type: "text" }), start("m2"), block(0, { type: "text" }), start("m3"), block(0, { type: "text" })]));
	assert.deepEqual(t.blocks.map((b) => b.key), ["m2:0", "m3:0"]);
});

test("不改原来的对象", () => {
	const a = fold(kept([start("m"), block(0, { type: "text" })]));
	const snapshot = structuredClone(a);
	const b = step(a, ["d", 0, "x"], 0);
	assert.deepEqual(a, snapshot);
	assert.notEqual(a.blocks[0], b.blocks[0]);
});

test("message_start 之前的段：只加序号", () => {
	const t = fold([["b", 0, "text"], ["d", 0, "x"], ["m", "m"]]);
	assert.equal(t.seq, 3);
	assert.deepEqual(t.blocks, []);
});

/** 一口气来的事件过一遍 coalesce，按推出去的顺序收下来 */
function merged(evs: Ev[]) {
	const out: Ev[] = [];
	const c = coalesce((e) => out.push(e), 1000);
	for (const e of evs) c.add(e);
	c.flush();
	return out;
}

test("coalesce：同一段连着的增量合成一个，别的事件、换了一段先推攒着的", () => {
	const evs = kept(raw);
	const out = merged(evs);
	assert.deepEqual(out, [
		["m", "msg_1"],
		["b", 0, "thinking"],
		["d", 0, "想一想"],
		["b", 1, "text"],
		["d", 1, "我来看看"],
		["b", 2, "tool", "toolu_1", "Bash"],
		["d", 2, '{"command":"ls"}'],
	]);
	// 合并之后和一个一个来的拼出一样的段
	assert.deepEqual(shape(fold(out)), shape(fold(evs)));
	// 不改传进来的事件
	assert.deepEqual(evs[2], ["d", 0, "想"]);
	// 两段的增量交错（Claude 一条消息一次只写一段，不会这样）：换段就推，先后不乱
	assert.deepEqual(merged([["d", 0, "a"], ["d", 1, "b"], ["d", 1, "c"], ["d", 0, "d"]]), [["d", 0, "a"], ["d", 1, "bc"], ["d", 0, "d"]]);
});

test("coalesce：攒着的到点推出去，flush 马上推", async () => {
	const out: Ev[] = [];
	const c = coalesce((e) => out.push(e), 20);
	c.add(["d", 0, "a"]);
	c.add(["d", 0, "b"]);
	assert.deepEqual(out, []);
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(out, [["d", 0, "ab"]]);
	c.add(["d", 0, "c"]);
	c.flush();
	c.flush();
	assert.deepEqual(out, [["d", 0, "ab"], ["d", 0, "c"]]);
	// 到点时已经推过了：不会再推一次
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(out.length, 2);
});

test("快照 + 按序号接：中间拿快照（先 flush）和一直接着的一样", () => {
	const evs = kept(raw);
	let server = emptyTail();
	const pushed: { seq: number; e: Ev }[] = [];
	const c = coalesce((e) => {
		server = step(server, e, 0);
		pushed.push({ seq: server.seq, e });
	}, 1000);
	evs.slice(0, 6).forEach((e) => c.add(e));
	c.flush();
	const snap = structuredClone(server);
	evs.slice(6).forEach((e) => c.add(e));
	c.flush();
	const late = pushed.filter((p) => p.seq > snap.seq).reduce((t, p) => (assert.equal(p.seq, t.seq + 1), step(t, p.e, 0)), snap);
	assert.deepEqual(late, server);
	assert.deepEqual(shape(server), shape(fold(evs)));
});

test("summarize：挑一句、只要第一行", () => {
	assert.equal(summarize({ command: "ls -la\necho hi", description: "列文件" }), "列文件");
	assert.equal(summarize({ command: "ls -la\necho hi" }), "ls -la");
	assert.equal(summarize({ file_path: "/a/b.ts" }), "/a/b.ts");
	assert.equal(summarize({}), "");
	assert.equal(summarize({ prompt: "x".repeat(300) }).length, 160);
});
