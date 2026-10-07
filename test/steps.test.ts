// steps.ts：工具组收着时露出什么（标题、标题下面的几行）
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Node, ToolNode } from "../shared/api.ts";
import { exposed } from "../web/src/lib/steps.ts";

let n = 0;
const base = () => ({ uuid: `u${++n}`, parent: null, ts: "2026-01-01T00:00:00Z" });
/** result：undefined 是还没结果，true 出错，false 成功 */
const tool = (name: string, summary: string, result?: boolean, agent: string | null = null): ToolNode => ({
	...base(), k: "tool", id: `t${n}`, name, summary, input: "{}", agent, resultUuid: null,
	result: result === undefined ? null : { text: "", error: result, cut: false, images: 0 },
});
const think = (text: string): Node => ({ ...base(), k: "thinking", text });
const spawn = (running: boolean, agentId: string | null = "a1", since = 5, latest: string | null = "Read x") => ({ running, agentId, since, latest });

test("跑完了：最后一步当标题（成功绿点 / 失败红点），下面不另露", () => {
	const a = tool("Read", "a.ts", false);
	const b = tool("mcp__srv__fetch", "url", false);
	const e = exposed([think("想"), a, b]);
	assert.deepEqual(e.head, { k: "step", line: { mark: "ok", name: "fetch", summary: "url", mono: true, agent: null } });
	assert.equal(e.count, 2);
	assert.deepEqual(e.names, ["Read", "fetch"]);
	assert.deepEqual(e.rows, []);
	assert.equal(e.errors, 0);
	const f = exposed([a, tool("Bash", "ls", true)]);
	assert.equal(f.head.k === "step" && f.head.line.mark, "failed");
	assert.equal(f.errors, 1, "多步的组照样标出错数");
});

test("只有一步、出错了：红点已经说了，标题上不再标出错数；别的步出错了照标", () => {
	assert.equal(exposed([tool("Bash", "ls", true)]).errors, 0);
	assert.equal(exposed([tool("Bash", "ls", true), tool("Bash", "pwd", true)]).errors, 2);
	assert.equal(exposed([tool("Bash", "ls", true), tool("Bash", "pwd", false)]).errors, 1);
});

test("名字去重、按先后", () => {
	assert.deepEqual(exposed([tool("Read", "a", false), tool("Bash", "b", false), tool("Read", "c", false)]).names, ["Read", "Bash"]);
});

test("在跑的那一步露出来：蓝点带耗时，标题是「N 次工具调用」", () => {
	const a = tool("Read", "a.ts", false);
	const b = tool("Bash", "make", undefined);
	const e = exposed([a, b], { node: b, since: 42 });
	assert.deepEqual(e.head, { k: "label" });
	assert.deepEqual(e.rows, [{ k: "last", key: "last", mark: "running", name: "Bash", summary: "make", mono: true, since: 42, agent: null }]);
});

test("工具之后正在想：露出来的是「思考」和最新一句，不是等宽的", () => {
	const a = tool("Read", "a.ts", false);
	const t = think("先看看\n\n再改一下\n");
	const e = exposed([a, t], { node: t, since: 7 });
	assert.deepEqual(e.head, { k: "label" });
	assert.deepEqual(e.rows, [{ k: "last", key: "last", mark: "running", name: "思考", summary: "再改一下", mono: false, since: 7, agent: null }]);
});

test("只有思考的一组正在想：标题上直接带最新一句和耗时，下面不另露", () => {
	const t = think("一\n二");
	const e = exposed([t], { node: t, since: 3 });
	assert.deepEqual(e.head, { k: "thinking", text: "二", since: 3 });
	assert.deepEqual(e.rows, []);
	assert.equal(e.count, 0);
});

test("没想完、也没在想的思考组 / 最后一步没结果（被打断）：只有「N 次工具调用」", () => {
	assert.deepEqual(exposed([think("x")]), { head: { k: "label" }, count: 0, names: [], errors: 0, rows: [] });
	const e = exposed([tool("Read", "a", false), tool("Bash", "b", undefined)]);
	assert.deepEqual(e.head, { k: "label" });
	assert.deepEqual(e.rows, []);
});

test("在跑的子代理每个都露出来（带它在做什么），最多 3 个，再多「还有 N 个」；最后一步要是其中之一就不另画", () => {
	const ts = [1, 2, 3, 4, 5].map((i) => tool("Agent", `活 ${i}`, false));
	const spawns = new Map(ts.map((t, i) => [t.id, spawn(true, `a${i}`, i, i === 0 ? null : `在做 ${i}`)]));
	const e = exposed(ts, null, spawns);
	assert.deepEqual(e.head, { k: "label" });
	assert.deepEqual(e.rows.map((r) => r.k), ["sub", "sub", "sub", "more"]);
	assert.deepEqual(e.rows[0], { k: "sub", key: ts[0].id, mark: "running", name: "Agent", summary: "活 1", mono: true, since: 0, agent: "a0", latest: null });
	assert.deepEqual(e.rows[3], { k: "more", key: "more", n: 2 });
});

test("子代理在跑、最后一步是别的：两样都露出来", () => {
	const ag = tool("Agent", "查", false);
	const rd = tool("Read", "b.ts", false);
	const e = exposed([ag, rd], null, new Map([[ag.id, spawn(true)]]));
	assert.deepEqual(e.head, { k: "label" });
	assert.deepEqual(e.rows.map((r) => r.k), ["sub", "last"]);
	assert.deepEqual(e.rows[1], { k: "last", key: "last", mark: "ok", name: "Read", summary: "b.ts", mono: true, agent: null });
});

test("前台子代理在跑（就是正在执行的那一步）：只画成子代理那一行", () => {
	const ag = tool("Agent", "查", undefined);
	const e = exposed([ag], { node: ag, since: 9 }, new Map([[ag.id, spawn(true, "a1", 4)]]));
	assert.deepEqual(e.rows.map((r) => r.k), ["sub"]);
	assert.equal(e.rows[0].k === "sub" && e.rows[0].since, 4, "耗时从子代理开始算");
});

test("子代理跑完了：最后一步当标题，带着它（点了看对话）；记录里有 agent 的先用它", () => {
	const ag = tool("Agent", "查", false);
	const e = exposed([ag], null, new Map([[ag.id, spawn(false, "a9")]]));
	assert.deepEqual(e.head, { k: "step", line: { mark: "ok", name: "Agent", summary: "查", mono: true, agent: "a9" } });
	const own = tool("Agent", "查", false, "own");
	const f = exposed([own], null, new Map([[own.id, spawn(false, "a9")]]));
	assert.equal(f.head.k === "step" && f.head.line.agent, "own");
	// 没给 spawns（组里没有 Agent 调用）就不带
	const g = exposed([tool("Agent", "查", false, "own")]);
	assert.equal(g.head.k === "step" && g.head.line.agent, null);
});
