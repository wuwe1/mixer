// spawns.ts：Agent 调用开出来的子代理还在不在跑。mixer 开着进程时看它报的后台任务，没有进程才按记录猜
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Node, Sub, ToolNode } from "../shared/api.ts";
import { FRESH, spawner, spawns } from "../web/src/lib/spawns.ts";

const LAUNCHED = "Async agent launched successfully.";
const NOW = Date.parse("2026-01-01T01:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
let n = 0;
const user = (ts = at(-600_000)): Node => ({ uuid: `u${++n}`, parent: null, ts, k: "user", text: "做", images: 0 });
/** result：null 是还没结果（前台在跑），LAUNCHED 是后台开的（服务端照 toolUseResult 标了 async），别的字符串是前台跑完了的结果 */
const agent = (id: string, result: string | null, agentId: string | null = null): ToolNode => ({
	uuid: `u${++n}`, parent: null, ts: at(-500_000), k: "tool", id, name: "Agent", summary: "", input: "{}", agent: agentId, resultUuid: null,
	result: result === null ? null : { text: result, error: false, cut: false, images: 0 },
	...(result === LAUNCHED && agentId ? { async: { agentId } } : {}),
});
const notice = (agentId: string, ms: number): Node => ({ uuid: `u${++n}`, parent: null, ts: at(ms), k: "event", kind: "task", text: "完成", agent: agentId });
const sub = (toolUseId: string, agentId: string, mtime: number): Sub => ({ agentId, toolUseId, agentType: null, description: null, latest: "Read a.ts", mtime: NOW + mtime });
const subsOf = (...l: Sub[]) => new Map(l.map((a) => [a.toolUseId as string, a]));

test("开着进程：后台子代理在不在跑只看进程报的后台任务", () => {
	// 两分钟没写记录（老办法会当成跑完了），进程里还有它：在跑
	const path = [user(), agent("t1", LAUNCHED, "a1")];
	const subs = subsOf(sub("t1", "a1", -120_000));
	assert.equal(spawns(path, subs, false, [{ id: "a1", tool: "t1" }], NOW).get("t1")?.running, true);
	// task_started 先于整张表来、tool 没对上：按任务 id = agentId 认
	assert.equal(spawns(path, subs, false, [{ id: "a1", tool: null }], NOW).get("t1")?.running, true);
	// 刚写过记录、会话也在跑，但进程里没有它了：跑完了
	const fresh = subsOf(sub("t1", "a1", -1000));
	assert.equal(spawns(path, fresh, true, [{ id: "b9", tool: "t9" }], NOW).get("t1")?.running, false);
	assert.equal(spawns(path, fresh, true, [], NOW).get("t1")?.running, false);
});

test("没有进程：照旧按记录猜", () => {
	const path = [user(), agent("t1", LAUNCHED, "a1")];
	assert.equal(spawns(path, subsOf(sub("t1", "a1", -1000)), false, null, NOW).get("t1")?.running, true);
	assert.equal(spawns(path, subsOf(sub("t1", "a1", -FRESH - 1000)), false, null, NOW).get("t1")?.running, false);
	// 结束通知之后没再写：跑完了
	const ended = [...path, notice("a1", -500)];
	assert.equal(spawns(ended, subsOf(sub("t1", "a1", -1000)), true, null, NOW).get("t1")?.running, false);
});

test("前台的：开着进程也照旧（会话在跑、是这一轮的）", () => {
	const path = [user(), agent("t1", null)];
	assert.equal(spawns(path, new Map(), true, [], NOW).get("t1")?.running, true);
	assert.equal(spawns(path, new Map(), false, [], NOW).get("t1")?.running, false);
	// 上一轮没结果的：不算
	assert.equal(spawns([...path, user()], new Map(), true, [], NOW).get("t1")?.running, false);
	// 有结果、不是后台开的：跑完了，进程里有同 id 的任务也不算
	assert.equal(spawns([user(), agent("t1", "完成了", "a1")], new Map(), true, [{ id: "a1", tool: "t1" }], NOW).get("t1")?.running, false);
});

test("后台的只认结构化的 async，结果的文字不算；forked 的 Skill 也是开子代理的", () => {
	// 前台跑完的结果里正好写着那句话：不是后台的
	const said: ToolNode = { ...agent("t1", "Async agent launched", "a1") };
	assert.equal(spawns([user(), said], subsOf(sub("t1", "a1", -1000)), true, null, NOW).get("t1")?.running, false);
	const skill: ToolNode = { ...agent("t2", "Running in the background as @review", "a2"), name: "Skill", async: { agentId: "a2" } };
	assert.equal(spawner(skill), true);
	assert.equal(spawner({ ...skill, async: undefined }), false);
	assert.equal(spawns([user(), skill], new Map(), false, [{ id: "a2", tool: null }], NOW).get("t2")?.running, true);
});
