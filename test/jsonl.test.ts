// jsonl.ts 的 lru：超出 budget 丢最久没用的，一分钟内用过的不丢（比 budget 还大的会话不会被旁边的子代理挤掉、一直整份重读）
import assert from "node:assert/strict";
import { test } from "node:test";
import { lru } from "../server/jsonl.ts";

test("lru：超出就丢最久没用的；刚用过的不丢，可以暂时超出", () => {
	const m = lru<{ size: number }>(100, 0);
	m.keep("a", { size: 60 });
	m.keep("b", { size: 30 });
	m.keep("c", { size: 30 });
	assert.deepEqual([...m.keys()], ["b", "c"]);
	// 自己就比 budget 大：留着，别的都丢
	m.keep("big", { size: 300 });
	assert.deepEqual([...m.keys()], ["big"]);
});

test("lru：一分钟内用过的不被挤掉，过了才丢", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 0 });
	const m = lru<{ size: number }>(100);
	m.keep("big", { size: 300 });
	t.mock.timers.tick(1000);
	m.keep("agent", { size: 1 });
	assert.deepEqual([...m.keys()], ["big", "agent"]);
	t.mock.timers.tick(60_000);
	m.keep("agent", m.get("agent") ?? { size: 1 });
	assert.deepEqual([...m.keys()], ["agent"]);
});
