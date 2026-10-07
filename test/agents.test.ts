// sessions.ts 的子代理：<会话>/subagents/ 里的列表（meta 的 toolUseId 对上 Agent 工具调用）、在做什么（latest）、带 since 的增量
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 不碰这台机器的 ~/.claude、data/
const tmp = mkdtempSync(join(tmpdir(), "mixer-agents-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
const { agent, sub, subs } = await import("../server/sessions.ts");

const PROJECT = "-tmp-demo";
const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
const dir = join(tmp, ".claude", "projects", PROJECT, SESSION, "subagents");
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, ".claude", "projects", PROJECT, `${SESSION}.jsonl`), "");

const line = (r: object) => `${JSON.stringify(r)}\n`;
let n = 0;
const ts = () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString();
const ask = (uuid: string) => line({ type: "user", uuid, parentUuid: null, isSidechain: true, timestamp: ts(), message: { role: "user", content: "去看看" } });
const say = (uuid: string, parent: string, mid: string, block: object) => line({ type: "assistant", uuid, parentUuid: parent, isSidechain: true, timestamp: ts(), message: { id: mid, role: "assistant", model: "claude-test-1", content: [block] } });
const result = (uuid: string, parent: string, id: string, text: string) => line({ type: "user", uuid, parentUuid: parent, isSidechain: true, timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
function make(id: string, meta: object, body: string) {
	writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
	writeFileSync(join(dir, `agent-${id}.jsonl`), body);
}

// 最后是工具调用（还在跑）
make("a01", { agentType: "Explore", description: "找文件", toolUseId: "toolu_1" },
	ask("x1") + say("x2", "x1", "m1", { type: "text", text: "先看看目录" }) + say("x3", "x2", "m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/r/src/session.tsx" } }));
// 最后是回复：第一行
make("a02", { agentType: "general-purpose", description: "写测试", toolUseId: "toolu_2" },
	ask("y1") + say("y2", "y1", "m2", { type: "tool_use", id: "t2", name: "mcp__foo__bar", input: { query: "q" } }) + result("y3", "y2", "t2", "ok") + say("y4", "y3", "m3", { type: "text", text: `\n  都改好了，测试过了\n第二行 ${"长".repeat(100)}` }));
// 只有 meta（刚开，记录还没写）
writeFileSync(join(dir, "agent-a03.meta.json"), JSON.stringify({ agentType: "Plan", description: "想想", toolUseId: "toolu_3" }));
// 别的东西不算
writeFileSync(join(dir, "agent-a04.forked-skill.json"), "{}");
writeFileSync(join(dir, "notes.txt"), "");

test("列表：每个子代理的 toolUseId、类型、描述来自 meta；只有 meta 的也在", async () => {
	const list = (await subs(PROJECT, SESSION)).sort((a, b) => a.agentId.localeCompare(b.agentId));
	assert.deepEqual(list.map((a) => [a.agentId, a.toolUseId, a.agentType, a.description]), [
		["a01", "toolu_1", "Explore", "找文件"],
		["a02", "toolu_2", "general-purpose", "写测试"],
		["a03", "toolu_3", "Plan", "想想"],
	]);
	assert.ok(list.every((a) => a.mtime > 0));
	assert.equal(list[2].latest, null);
	assert.deepEqual(await subs(PROJECT, "bbbbbbbb-0000-4000-8000-000000000002"), []);
});

test("在做什么：最后是工具调用就是工具名 + 摘要（mcp 前缀去掉），最后是回复就是它的第一行、截到 80 字", async () => {
	assert.equal((await sub(PROJECT, SESSION, "a01"))?.latest, "Read /r/src/session.tsx");
	assert.equal((await sub(PROJECT, SESSION, "a02"))?.latest, "都改好了，测试过了");
	appendFileSync(join(dir, "agent-a02.jsonl"), say("y5", "y4", "m4", { type: "text", text: "长".repeat(100) }));
	assert.equal((await sub(PROJECT, SESSION, "a02"))?.latest, `${"长".repeat(80)}…`);
	appendFileSync(join(dir, "agent-a02.jsonl"), say("y6", "y5", "m4", { type: "tool_use", id: "t3", name: "mcp__foo__bar", input: { query: "再搜一次" } }));
	assert.equal((await sub(PROJECT, SESSION, "a02"))?.latest, "bar 再搜一次");
	assert.equal(await sub(PROJECT, SESSION, "a09"), null);
});

test("10 分钟没动的不读记录：latest 是 null", async () => {
	const old = new Date(Date.now() - 3600_000);
	utimesSync(join(dir, "agent-a01.jsonl"), old, old);
	utimesSync(join(dir, "agent-a01.meta.json"), old, old);
	const a = await sub(PROJECT, SESSION, "a01");
	assert.equal(a?.latest, null);
	assert.equal(a?.toolUseId, "toolu_1");
});

test("子代理的对话带 since：同一个 epoch 只给之后变了的，对不上给全部", async () => {
	const full = await agent(PROJECT, SESSION, "a01");
	assert.ok(full);
	assert.equal(full.delta, false);
	assert.equal(full.info.description, "找文件");
	assert.deepEqual(full.nodes.map((x) => x.uuid), ["x1", "x2", "x3"]);
	// 工具有了结果（x3 改了）、又写了一段
	appendFileSync(join(dir, "agent-a01.jsonl"), result("x4", "x3", "t1", "内容") + say("x5", "x4", "m5", { type: "text", text: "看完了" }));
	const d = await agent(PROJECT, SESSION, "a01", full.version);
	assert.ok(d);
	assert.equal(d.delta, true);
	assert.deepEqual(d.nodes.map((x) => x.uuid), ["x3", "x5"]);
	const t = d.nodes[0];
	assert.ok(t.k === "tool" && t.result?.text === "内容");
	// 没变：空的增量
	const same = await agent(PROJECT, SESSION, "a01", d.version);
	assert.equal(same?.delta, true);
	assert.deepEqual(same?.nodes, []);
	// 别的 epoch（服务重启过、文件重写过）：全部
	const other = await agent(PROJECT, SESSION, "a01", "zzzz:1");
	assert.equal(other?.delta, false);
	assert.equal(other?.nodes.length, 4);
	assert.equal(await agent(PROJECT, SESSION, "a03"), null);
});
