// tail.ts：运行输出流 → 正在写的那几段
import assert from "node:assert/strict";
import { test } from "node:test";
import { counts, emptyTail, step, summarize, type Tail } from "../web/src/lib/tail.ts";

const ev = (event: object) => ({ type: "stream_event", event });
const start = (id: string) => ev({ type: "message_start", message: { id } });
const block = (index: number, content_block: object) => ev({ type: "content_block_start", index, content_block });
const delta = (index: number, d: object) => ev({ type: "content_block_delta", index, delta: d });
const stop = (index: number) => ev({ type: "content_block_stop", index });

const fold = (evs: object[], t = emptyTail()) => evs.reduce<Tail>((t, e, i) => step(t, e, 1000 + i), t);

test("思考、文字、工具参数各一段，key 是「消息 id : 第几段」", () => {
	const t = fold([
		start("msg_1"),
		block(0, { type: "thinking", thinking: "" }),
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
	]);
	assert.equal(t.seq, 14);
	assert.equal(t.msg, "msg_1");
	assert.deepEqual(t.blocks, [
		{ k: "thinking", text: "想一想", key: "msg_1:0", at: 1001 },
		{ k: "text", text: "我来看看", key: "msg_1:1", at: 1006 },
		{ k: "tool", id: "toolu_1", name: "Bash", json: '{"command":"ls"}', key: "msg_1:2", at: 1010 },
	]);
});

test("只留这条消息和上一条的段", () => {
	const t = fold([start("m1"), block(0, { type: "text" }), start("m2"), block(0, { type: "text" }), start("m3"), block(0, { type: "text" })]);
	assert.deepEqual(t.blocks.map((b) => b.key), ["m2:0", "m3:0"]);
});

test("不改原来的对象", () => {
	const a = fold([start("m"), block(0, { type: "text" })]);
	const snapshot = structuredClone(a);
	const b = step(a, delta(0, { type: "text_delta", text: "x" }), 0);
	assert.deepEqual(a, snapshot);
	assert.notEqual(a.blocks[0], b.blocks[0]);
});

test("message_start 之前的段、认不出的块：只加序号", () => {
	const t = fold([block(0, { type: "text" }), start("m"), block(0, { type: "server_tool_use" }), ev({ type: "message_delta" })]);
	assert.equal(t.seq, 4);
	assert.deepEqual(t.blocks, []);
});

test("只有 stream_event 算序号", () => {
	assert.equal(counts(start("m")), true);
	assert.equal(counts({ type: "assistant", message: {} }), false);
	assert.equal(counts({ type: "stream_event" }), false);
});

test("summarize：挑一句、只要第一行", () => {
	assert.equal(summarize({ command: "ls -la\necho hi", description: "列文件" }), "列文件");
	assert.equal(summarize({ command: "ls -la\necho hi" }), "ls -la");
	assert.equal(summarize({ file_path: "/a/b.ts" }), "/a/b.ts");
	assert.equal(summarize({}), "");
	assert.equal(summarize({ prompt: "x".repeat(300) }).length, 160);
});
