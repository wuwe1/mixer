// claude-io.ts：只按 \n 切行（U+2028 不切）、半行等下一块、结束时最后一行没换行也算；control_request 等同一个 request_id 的回音
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { onLines, requests } from "../server/claude-io.ts";

test("按 \\n 切：U+2028 不切，汉字切在两块之间也对，最后没换行的那行在结束时给", async () => {
	const s = new PassThrough();
	const got: string[] = [];
	onLines(s, (l) => got.push(l));
	const all = Buffer.from("a b\n中文\n尾巴");
	s.write(all.subarray(0, 6));
	s.write(all.subarray(6, 9));
	s.end(all.subarray(9));
	await new Promise((r) => s.on("end", r));
	assert.deepEqual(got, ["a b", "中文", "尾巴"]);
});

test("request 等回音：success 给 response，error 算失败，超时、failAll 算失败；没人等的不收", async () => {
	const sent: { request_id: string }[] = [];
	const io = requests((m) => void sent.push(m as { request_id: string }));
	const a = io.request({ subtype: "x" }, 1000, "a");
	const b = io.request({ subtype: "y" }, 1000);
	assert.equal(sent[0].request_id, "a");
	assert.equal(io.reply({ type: "control_response", response: { subtype: "success", request_id: "a", response: { ok: 1 } } }), true);
	assert.deepEqual(await a, { ok: 1 });
	assert.equal(io.reply({ type: "control_response", response: { subtype: "success", request_id: "nobody" } }), false);
	io.reply({ type: "control_response", response: { subtype: "error", request_id: sent[1].request_id, error: "不认识" } });
	await assert.rejects(b, /不认识/);
	await assert.rejects(io.request({}, 10), /秒没回/);
	const c = io.request({}, 1000);
	io.failAll(new Error("claude 退出了"));
	await assert.rejects(c, /退出了/);
});
