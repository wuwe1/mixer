// arrival.ts：发出去的那条到没到（按 uuid 认，不比字、不看时间）、数据到没到某个版本
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Queued, Run } from "../shared/api.ts";
import { fate, type Item, type Known, later, reached } from "../web/src/lib/arrival.ts";

const TAB = "tab-1";
const item = (uuid: string, more: Partial<Item> = {}): Item => ({ uuid, session: "s", text: "继续", state: "sent", where: "run", tab: TAB, gen: 1, mark: later("100:5"), ...more });
const run = (merged: string[], more: Partial<Run> = {}): Run => ({
	id: `r-${merged[0]}`, project: "p", cwd: "/p", from: "s", session: "s", mode: "resume", at: null, prompt: "继续", permission: "auto", model: null, effort: null,
	status: "running", started: "2026-01-01T00:00:00Z", ended: null, error: null, uuid: merged.length === 1 ? merged[0] : "m", merged, images: 0, ...more,
});
const queued = (uuid: string): Queued => ({ id: `q-${uuid}`, uuid, project: "p", session: "s", prompt: "继续", images: 0, permission: "auto", model: null, effort: null, at: "2026-01-01T00:00:00Z" });
const known = (more: Partial<Known> = {}): Known => ({ ids: new Set(), version: "100:5", runs: [], queue: [], synced: 1, tab: TAB, ...more });

test("reached：同一个 epoch 比 rev，后给的 epoch 新；null 是没什么可等的，还不知道的不算到", () => {
	assert.equal(reached("100:5", "100:5"), true);
	assert.equal(reached("100:4", "100:5"), false);
	assert.equal(reached("101:0", "100:5"), true);
	assert.equal(reached("99:9", "100:5"), false);
	assert.equal(reached("100:5", null), true);
	assert.equal(reached("100:5", undefined), false);
	assert.equal(reached(null, "100:5"), false);
	// 服务端改版前的 epoch（8 位十六进制）：比不了，不算到
	assert.equal(reached("a1b2c3d4:9", "100:5"), false);
	// later：要从头重读过（新的 epoch）才到
	assert.equal(reached("100:99999", later("100:5")), false);
	assert.equal(reached("101:0", later("100:5")), true);
});

test("同样的字连发两条、第二条被拒：第一条到了不算第二条到了（原来按字认，会把输入框里的第二条清掉）", () => {
	const k = known({ ids: new Set(["a"]) });
	assert.equal(fate(item("a"), k).f, "arrived");
	assert.notEqual(fate(item("b", { state: "unknown", where: undefined, mark: undefined }), k).f, "arrived");
});

test("到了：记录里有它的 uuid（运行中插进来的认 source，tree 那边已经合进 ids），或者合成它的那条", () => {
	assert.equal(fate(item("a"), known({ ids: new Set(["a"]) })).f, "arrived");
	assert.equal(fate(item("a"), known({ ids: new Set(["m"]), runs: [run(["a", "b"])] })).f, "arrived");
});

test("在跑：等；跑完了等数据到它结束时的 version，到了还没有就是没写进去", () => {
	assert.deepEqual(fate(item("a"), known({ runs: [run(["a"])] })), { f: "wait", where: "run", seen: true, mark: "100:Infinity" });
	// 刚结束、version 还没算出来
	assert.deepEqual(fate(item("a"), known({ runs: [run(["a"], { status: "error", version: undefined })] })), { f: "wait", where: "run", seen: true });
	const ended = run(["a"], { status: "error", version: "100:7" });
	assert.deepEqual(fate(item("a"), known({ runs: [ended] })), { f: "wait", where: "run", seen: true, mark: "100:7" });
	assert.equal(fate(item("a"), known({ runs: [ended], version: "100:7" })).f, "lost");
	// 一开始就出错、没有记录
	assert.equal(fate(item("a"), known({ runs: [run(["a"], { status: "error", version: null })] })).f, "lost");
	// 停下来的：记录里有它（停之前就写进去了）
	assert.equal(fate(item("a"), known({ ids: new Set(["a"]), runs: [run(["a"], { status: "stopped", version: "100:7" })], version: "100:7" })).f, "arrived");
});

test("运行没了（服务重启过）：等数据从头重读过（新的 epoch）还没有它，才算丢了", () => {
	const x = item("a", { seen: true, mark: later("100:5") });
	assert.equal(fate(x, known({ version: "100:9" })).f, "wait");
	assert.equal(fate(x, known({ version: "200:1" })).f, "lost");
	assert.equal(fate(x, known({ version: "200:1", ids: new Set(["a"]) })).f, "arrived");
});

test("排队：在队列里等；见过又没了（取消、没发出去、服务重启）放回；回复说排上了、还没见过，同一个页面等下一次 hello", () => {
	const q = item("a", { where: "queue", mark: undefined });
	assert.deepEqual(fate(q, known({ queue: [queued("a")] })), { f: "wait", where: "queue", seen: true });
	assert.equal(fate({ ...q, seen: true }, known()).f, "lost");
	assert.equal(fate(q, known({ synced: 1 })).f, "wait");
	assert.equal(fate(q, known({ synced: 2 })).f, "lost");
	// 别的页面发的（刷新过）：这次的 hello 就作数
	assert.equal(fate({ ...q, tab: "tab-0" }, known()).f, "lost");
	// 排队的发出去了：带着它的运行先推过来
	assert.equal(fate({ ...q, seen: true }, known({ runs: [run(["a", "b"])] })).f, "wait");
});

test("请求还在路上、还没连上：等；请求没回来、服务端那边也没有：忘掉（字还在输入框里，不放回）", () => {
	const x = item("a", { state: "sending", where: undefined, mark: undefined });
	assert.equal(fate(x, known()).f, "wait");
	assert.equal(fate({ ...x, state: "unknown" }, known({ synced: 0 })).f, "wait");
	assert.equal(fate({ ...x, state: "unknown" }, known()).f, "gone");
	assert.equal(fate({ ...x, tab: "tab-0" }, known()).f, "gone");
	// 其实收下了：照样跟着运行走
	assert.equal(fate({ ...x, state: "unknown" }, known({ runs: [run(["a"])] })).f, "wait");
});
