// sessions.ts：Claude Code 的会话记录拼成显示节点，CLAUDE.md「会话记录的坑」里的每一条
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 不碰这台机器的 ~/.claude、~/.codex、data/
const tmp = mkdtempSync(join(tmpdir(), "mixer-sessions-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
const { parse, thought } = await import("../server/sessions.ts");

const FIXTURE = join(import.meta.dirname, "fixtures", "claude.jsonl");
const { nodes } = await parse(FIXTURE);
const by = (uuid: string) => nodes.find((n) => n.uuid === uuid);

test("显示的节点和顺序", () => {
	assert.deepEqual(
		nodes.map((n) => `${n.k}:${n.uuid}`),
		["user:u1", "assistant:a2", "tool:a3", "assistant:a4", "event:u3", "user:u6", "event:c1", "user:u10", "assistant:a5", "user:q1"],
	);
});

test("行里的 U+2028 不切断记录", () => {
	const u = by("u1");
	assert.ok(u?.k === "user");
	assert.equal(u.text, "第一行\u2028第二行");
	const t = by("a3");
	assert.ok(t?.k === "tool");
	assert.equal(t.result?.text, "a\u2028b");
});

test("同一个 uuid 重复追加：按第一次的", () => {
	const n = by("a2");
	assert.ok(n?.k === "assistant");
	assert.equal(n.text, "我先看看");
	assert.equal(nodes.filter((x) => x.uuid === "a2").length, 1);
});

test("空的思考不显示，但算一段：key 是「消息 id : 第几段」", () => {
	assert.equal(nodes.some((n) => n.uuid === "a1"), false);
	assert.equal((by("a2") as { key?: string }).key, "msg_1:1");
	assert.equal((by("a3") as { key?: string }).key, "msg_1:2");
	assert.equal((by("a4") as { key?: string }).key, "msg_2:0");
	assert.equal((by("a5") as { key?: string }).key, "msg_3:0");
});

test("parent 跳过不显示的记录，指向最近的显示节点", () => {
	assert.equal(by("u1")?.parent, null);
	// a1（空思考）不显示
	assert.equal(by("a2")?.parent, "u1");
});

test("工具：结果挂在调用上，记下结果那条 user 记录", () => {
	const t = by("a3");
	assert.ok(t?.k === "tool");
	assert.equal(t.name, "Bash");
	assert.equal(t.summary, "列出文件");
	assert.equal(t.resultUuid, "u2");
	assert.equal(t.result?.error, false);
	assert.deepEqual(t.ctx, { used: 1210, model: "claude-test-1" });
});

test("parentUuid 指向后面才写的记录：读到了再接上", () => {
	// a4 → att1（后写的附带记录）→ u2（工具结果，不显示）→ a3
	assert.equal(by("a4")?.parent, "a3");
});

test("task-notification 是事件，system-reminder 不显示", () => {
	const e = by("u3");
	assert.ok(e?.k === "event");
	assert.equal(e.kind, "task");
	assert.equal(e.text, "后台命令跑完了");
	assert.equal(e.status, "completed");
	assert.equal(e.detail, "输出");
	assert.equal(by("u4"), undefined);
});

test("skill：命令记录 + isMeta 的正文显示成人说的「/名字 参数」；/clear 不显示", () => {
	const s = by("u6");
	assert.ok(s?.k === "user");
	assert.equal(s.text, "/review main");
	assert.equal(s.parent, "u3");
	for (const id of ["u5", "u7", "u8"]) assert.equal(by(id), undefined);
});

test("压缩：接在前面最后一个显示节点上，摘要挂在它上面", () => {
	const c = by("c1");
	assert.ok(c?.k === "event");
	assert.equal(c.kind, "compact");
	assert.equal(c.text, "上下文已压缩（自动 · 15.0 万 → 2.0 万 token）");
	assert.equal(c.parent, "u6");
	assert.equal(c.detail, "压缩前的摘要");
	// 摘要不是人说的话
	assert.equal(by("u9"), undefined);
	assert.equal(by("u10")?.parent, "c1");
});

test("运行中插进来的 queued_command 是人说的话", () => {
	const q = by("q1");
	assert.ok(q?.k === "user");
	assert.equal(q.queued, true);
	assert.equal(q.text, "运行中插进来的话");
	assert.equal(q.parent, "a5");
});

test("接着读：只读新写的；先到的回复等它挂着的记录写进来再接上", async () => {
	const file = join(tmp, "grow.jsonl");
	const line = (r: object) => `${JSON.stringify(r)}\n`;
	writeFileSync(file, line({ type: "user", uuid: "x1", parentUuid: null, timestamp: "t", message: { role: "user", content: "问" } }));
	appendFileSync(file, line({ type: "assistant", uuid: "x2", parentUuid: "x9", timestamp: "t", message: { id: "m", content: [{ type: "text", text: "答" }] } }));
	// 最后没有 \n 的半行不读
	appendFileSync(file, '{"type":"user","uuid":"half"');
	const p1 = await parse(file);
	assert.deepEqual(p1.nodes.map((n) => n.uuid), ["x1", "x2"]);
	assert.equal(p1.nodes[1].parent, null);
	const rev = p1.rev;
	appendFileSync(file, `,"parentUuid":"x2","timestamp":"t","message":{"role":"user","content":"半行写完了"}}\n`);
	appendFileSync(file, line({ type: "attachment", uuid: "x9", parentUuid: "x1", timestamp: "t", attachment: { type: "x" } }));
	const p2 = await parse(file);
	assert.deepEqual(p2.nodes.map((n) => n.uuid), ["x1", "x2", "half"]);
	assert.equal(p2.nodes[1].parent, "x1");
	// 接上的节点记了新的 rev，网页按 since 能拿到
	assert.ok((p2.revs.get("x2") ?? 0) > rev);
});

test("同一个文件没变：直接用缓存", async () => {
	const copy = join(tmp, "copy.jsonl");
	copyFileSync(FIXTURE, copy);
	const a = await parse(copy);
	const b = await parse(copy);
	assert.equal(a, b);
	assert.equal(a.rev, b.rev);
});

test("网页缓存靠的：同一个 epoch 里节点只增不删；文件变短（重写）换 epoch", async () => {
	const file = join(tmp, "epoch.jsonl");
	const line = (r: object) => `${JSON.stringify(r)}\n`;
	writeFileSync(file, line({ type: "user", uuid: "e1", parentUuid: null, timestamp: "t", message: { role: "user", content: "一" } }));
	const a = await parse(file);
	const { epoch } = a;
	const before = a.nodes.map((n) => n.uuid);
	appendFileSync(file, line({ type: "assistant", uuid: "e2", parentUuid: "e1", timestamp: "t", message: { id: "m", content: [{ type: "text", text: "二" }] } }));
	const b = await parse(file);
	assert.equal(b.epoch, epoch);
	for (const u of before) assert.ok(b.nodes.some((n) => n.uuid === u));
	writeFileSync(file, line({ type: "user", uuid: "f1", parentUuid: null, timestamp: "t", message: { role: "user", content: "重" } }));
	const c = await parse(file);
	assert.notEqual(c.epoch, epoch);
	assert.deepEqual(c.nodes.map((n) => n.uuid), ["f1"]);
});

test("思考只给开头（cut），全文点开再拿", async () => {
	const dir = join(tmp, ".claude", "projects", "-tmp-think");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "think.jsonl");
	const line = (r: object) => `${JSON.stringify(r)}\n`;
	const long = `想${"很久".repeat(400)}`;
	writeFileSync(file, line({ type: "user", uuid: "t1", parentUuid: null, timestamp: "t", message: { role: "user", content: "问" } }));
	appendFileSync(file, line({ type: "assistant", uuid: "t2", parentUuid: "t1", timestamp: "t", message: { id: "m", content: [{ type: "thinking", thinking: long }] } }));
	appendFileSync(file, line({ type: "assistant", uuid: "t3", parentUuid: "t2", timestamp: "t", message: { id: "m", content: [{ type: "thinking", thinking: "短的" }] } }));
	const { nodes } = await parse(file);
	const [a, b] = nodes.filter((n) => n.k === "thinking");
	assert.ok(a?.k === "thinking" && b?.k === "thinking");
	assert.equal(a.cut, true);
	assert.ok(a.text.length < long.length && long.startsWith(a.text));
	// key 照旧：正在写的那段写进记录后还能对上
	assert.equal(a.key, "m:0");
	assert.equal(await thought("-tmp-think", "think", "t2"), long);
	assert.equal(b.cut, false);
	assert.equal(b.text, "短的");
	// 没截短的不另存：网页不会来要
	assert.equal(await thought("-tmp-think", "think", "t3"), null);
});
