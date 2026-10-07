// sessions.ts：Claude Code 的会话记录拼成显示节点，CLAUDE.md「会话记录的坑」里的每一条
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolNode } from "../shared/api.ts";

// 不碰这台机器的 ~/.claude、~/.codex、data/
const tmp = mkdtempSync(join(tmpdir(), "mixer-sessions-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
const { forget, listSessions, parse, row, session, thought } = await import("../server/sessions.ts");

const FIXTURE = join(import.meta.dirname, "fixtures", "claude.jsonl");
const { nodes } = await parse(FIXTURE);
const by = (uuid: string) => nodes.find((n) => n.uuid === uuid);

test("显示的节点和顺序", () => {
	assert.deepEqual(
		nodes.map((n) => `${n.k}:${n.uuid}`),
		["user:u1", "assistant:a2", "tool:a3", "assistant:a4", "event:u3", "user:u5", "event:c1", "user:u10", "assistant:a5", "user:q1", "event:i1"],
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

test("skill：命令记录 + isMeta 的正文显示成人说的「/名字 参数」，uuid 用命令那条的（写进 stdin 时带的 uuid 落在它上面）；/clear 不显示", () => {
	const s = by("u5");
	assert.ok(s?.k === "user");
	assert.equal(s.text, "/review main");
	assert.equal(s.parent, "u3");
	for (const id of ["u6", "u7", "u8"]) assert.equal(by(id), undefined);
});

test("压缩：接在前面最后一个显示节点上，摘要挂在它上面", () => {
	const c = by("c1");
	assert.ok(c?.k === "event");
	assert.equal(c.kind, "compact");
	assert.equal(c.text, "上下文已压缩（自动 · 15.0 万 → 2.0 万 token）");
	assert.equal(c.parent, "u5");
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
	// 写进 stdin 时带的 uuid：网页认自己发的那条
	assert.equal(q.source, "s-q1");
});

test("停止后补的「[Request interrupted by user]」是事件，不是人说的话", async () => {
	const i = by("i1");
	assert.ok(i?.k === "event");
	assert.equal(i.text, "被打断了");
	assert.equal(i.parent, "q1");
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

test("Claude 的分叉：row 也给 parent（第一句的 uuid 相同的一家，最早建的是原会话），新分叉、删掉的就地改", async () => {
	const P = "-tmp-fork";
	const dir = join(tmp, ".claude", "projects", P);
	mkdirSync(dir, { recursive: true });
	const line = (r: object) => `${JSON.stringify(r)}\n`;
	const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
	/** 分叉的文件里原会话的记录原样复制：第一句的 uuid 一样。建立时间错开一点 */
	const make = async (n: number, root: string) => {
		writeFileSync(join(dir, `${id(n)}.jsonl`), line({ type: "user", uuid: root, parentUuid: null, timestamp: new Date().toISOString(), message: { role: "user", content: "问" } }) + line({ type: "assistant", uuid: `a${n}`, parentUuid: root, timestamp: "t", message: { id: `m${n}`, content: [{ type: "text", text: "答" }] } }));
		await new Promise((r) => setTimeout(r, 20));
	};
	await make(1, "r1");
	await make(2, "r1");
	await make(3, "r1");
	await make(4, "r2");
	const parent = async (n: number) => (await row(P, id(n)))?.parent ?? null;
	// 项目还没扫过：row 先扫一遍
	assert.equal(await parent(2), id(1));
	const listed = Object.fromEntries((await listSessions(P)).map((m) => [m.id, m.parent]));
	assert.deepEqual(listed, { [id(1)]: null, [id(2)]: id(1), [id(3)]: id(1), [id(4)]: null });
	for (const n of [1, 2, 3, 4]) assert.equal(await parent(n), listed[id(n)]);
	// 之后建的分叉：扫到它时就地记上
	await make(5, "r1");
	assert.equal(await parent(5), id(1));
	// 原会话删了（trash.ts 调 forget）：一家里剩下最早的那个当原会话
	rmSync(join(dir, `${id(1)}.jsonl`));
	forget(P, id(1));
	assert.equal(await parent(2), null);
	assert.equal(await parent(3), id(2));
	// 别处删掉的（没经过 forget）：文件不在了就跳过
	rmSync(join(dir, `${id(2)}.jsonl`));
	assert.equal(await parent(3), null);
	assert.equal(await parent(5), id(3));
});

test("terminal：只看 ~/.claude/sessions 的登记（进程活着、启动时间对得上），刚写过不算；在跑闲着照登记的", async () => {
	const terminals = await import("../server/terminals.ts");
	const P = "-tmp-term";
	const dir = join(tmp, ".claude", "projects", P);
	mkdirSync(dir, { recursive: true });
	const ID = "00000000-0000-4000-8000-0000000000aa";
	writeFileSync(join(dir, `${ID}.jsonl`), `${JSON.stringify({ type: "user", uuid: "t1", parentUuid: null, timestamp: new Date().toISOString(), message: { role: "user", content: "问" } })}\n`);
	assert.equal((await row(P, ID))?.terminal, null);
	// 这个测试进程当成终端里开着它的 claude
	mkdirSync(terminals.REGISTRY, { recursive: true });
	const reg = join(terminals.REGISTRY, `${process.pid}.json`);
	const procStart = (await terminals.starts([process.pid]))?.get(process.pid);
	writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: ID, cwd: "/tmp/term", procStart, status: "busy" }));
	await terminals.refresh();
	assert.equal((await row(P, ID))?.terminal, "busy");
	writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: ID, cwd: "/tmp/term", procStart, status: "idle" }));
	await terminals.refresh();
	assert.equal((await listSessions(P)).find((m) => m.id === ID)?.terminal, "idle");
	// 终端里 /resume、/clear 换了会话：登记的 sessionId 跟着变，原来的马上空出来
	writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: "00000000-0000-4000-8000-0000000000bb", cwd: "/tmp/term", procStart, status: "idle" }));
	await terminals.refresh();
	assert.equal((await row(P, ID))?.terminal, null);
	rmSync(reg);
});

const line = (r: object) => `${JSON.stringify(r)}\n`;
const user = (uuid: string, parentUuid: string | null, text: string, extra: object = {}) => line({ type: "user", uuid, parentUuid, timestamp: new Date().toISOString(), message: { role: "user", content: text }, ...extra });
const said = (uuid: string, parentUuid: string, text: string, extra: object = {}) => line({ type: "assistant", uuid, parentUuid, timestamp: new Date().toISOString(), message: { id: `m-${uuid}`, content: [{ type: "text", text }] }, ...extra });
const sid = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;

test("第几段：记录带 apiBlockIndex 就照它（前面的段没写进记录也不错位），老记录才数", async () => {
	const file = join(tmp, "blocks.jsonl");
	const a = (uuid: string, parentUuid: string, text: string, i?: number) => line({ type: "assistant", uuid, parentUuid, timestamp: "t", message: { id: "m", content: [{ type: "text", text }] }, ...(i === undefined ? {} : { apiBlockIndex: i }) });
	writeFileSync(file, user("b0", null, "问") + a("b1", "b0", "第二段", 1) + a("b2", "b1", "第三段", 2) + a("b3", "b2", "老的接着数"));
	const { nodes } = await parse(file);
	assert.deepEqual(nodes.flatMap((n) => ("key" in n && n.key ? [n.key] : [])), ["m:1", "m:2", "m:3"]);
});

test("工具结果照结构化的 toolUseResult：子代理、后台、后台任务、改了的文件", async () => {
	const file = join(tmp, "facts.jsonl");
	const call = (uuid: string, parentUuid: string, id: string, name: string, input: object) => line({ type: "assistant", uuid, parentUuid, timestamp: "t", message: { id: `m-${uuid}`, content: [{ type: "tool_use", id, name, input }] } });
	const res = (uuid: string, parentUuid: string, id: string, text: string, r: unknown, error = false) => line({ type: "user", uuid, parentUuid, timestamp: "t", cwd: "/repo", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: error }] }, toolUseResult: r });
	writeFileSync(
		file,
		user("f0", null, "做") +
			call("f1", "f0", "t1", "Agent", { description: "查" }) + res("f2", "f1", "t1", "Async agent launched successfully.\nagentId: aaa1", { isAsync: true, status: "async_launched", agentId: "aaa1", outputFile: "/tmp/x.output" }) +
			call("f3", "f2", "t2", "Agent", { description: "查" }) + res("f4", "f3", "t2", "做完了。agentId: a999（文字里的不算）", { status: "completed", agentId: "aaa2", content: [] }) +
			call("f5", "f4", "t3", "Skill", { skill: "review" }) + res("f6", "f5", "t3", "Running in the background", { success: true, status: "forked", background: true, agentId: "aaa3" }) +
			call("f7", "f6", "t4", "Bash", { command: "sleep 9", run_in_background: true }) + res("f8", "f7", "t4", "", { stdout: "", backgroundTaskId: "bt1" }) +
			call("f9", "f8", "t5", "Monitor", { command: "tail" }) + res("f10", "f9", "t5", "", { taskId: "bt2", timeoutMs: 1 }) +
			call("f11", "f10", "t6", "Edit", { file_path: "/repo/a.ts", old_string: "x", new_string: "y" }) + res("f12", "f11", "t6", "ok", { filePath: "/repo/a.ts", structuredPatch: [] }) +
			call("f13", "f12", "t7", "Edit", { file_path: "/repo/b.ts" }) + res("f14", "f13", "t7", "没找到", "Error: String not found", true) +
			call("f15", "f14", "t8", "Bash", { command: "sed -i '' s/a/b/ c.ts d.ts" }) + res("f16", "f15", "t8", "", { stdout: "", bashEditDiff: { files: [{ filePath: "/repo/c.ts", hunks: [] }], moreFiles: 1, changedFiles: ["/repo/c.ts", "d.ts"] } }) +
			call("f17", "f16", "t9", "Bash", { command: "git pull" }) + res("f18", "f17", "t9", "", { stdout: "", bashEditDiff: { files: [{ filePath: "/repo/e.ts", hunks: [] }], moreFiles: 0, shared: true } }) +
			call("f19", "f18", "t10", "Read", { file_path: "/repo/r.ts" }) + res("f20", "f19", "t10", "内容", { type: "text", file: { filePath: "/repo/r.ts" } }),
	);
	const { nodes } = await parse(file);
	const t = (id: string) => nodes.find((n) => n.k === "tool" && n.id === id) as ToolNode;
	assert.deepEqual([t("t1").agent, t("t1").async], ["aaa1", { agentId: "aaa1" }]);
	// 前台跑完的：有 agentId、不是后台的；文字里的 agentId 不认
	assert.deepEqual([t("t2").agent, t("t2").async], ["aaa2", undefined]);
	assert.deepEqual(t("t3").async, { agentId: "aaa3" });
	assert.equal(t("t4").task, "bt1");
	assert.equal(t("t5").task, "bt2");
	assert.deepEqual([t("t6").file, t("t6").files], ["/repo/a.ts", ["/repo/a.ts"]]);
	// 出错的没改：只知道它碰的是哪个文件
	assert.deepEqual([t("t7").file, t("t7").files], ["/repo/b.ts", undefined]);
	// 命令改的：changedFiles 是全部，相对路径按 cwd 补全
	assert.deepEqual(t("t8").files, ["/repo/c.ts", "/repo/d.ts"]);
	// 同一个工作区里别的进程也在改：分不清，不算
	assert.equal(t("t9").files, undefined);
	assert.deepEqual([t("t10").file, t("t10").files], ["/repo/r.ts", undefined]);
});

test("会话改过的文件连子代理的；leaf 照 last-prompt", async () => {
	const P = "-tmp-touched";
	const dir = join(tmp, ".claude", "projects", P);
	const id = sid(1);
	mkdirSync(join(dir, id, "subagents"), { recursive: true });
	const edit = (uuid: string, parentUuid: string, path: string, extra: object = {}) =>
		line({ type: "assistant", uuid, parentUuid, timestamp: "t", message: { id: `m-${uuid}`, content: [{ type: "tool_use", id: `tool-${uuid}`, name: "Write", input: { file_path: path } }] }, ...extra }) +
		line({ type: "user", uuid: `${uuid}r`, parentUuid: uuid, timestamp: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${uuid}`, content: "ok" }] }, toolUseResult: { type: "create", filePath: path, structuredPatch: [] }, ...extra });
	writeFileSync(join(dir, `${id}.jsonl`), user("p1", null, "改") + edit("p2", "p1", "/repo/main.ts"));
	writeFileSync(join(dir, id, "subagents", "agent-a1.jsonl"), user("s1", null, "子代理改", { isSidechain: true }) + edit("s2", "s1", "/repo/sub.ts", { isSidechain: true }));
	// 在自己的 worktree 里干活的子代理：那份检出里的改动不算
	writeFileSync(join(dir, id, "subagents", "agent-a2.meta.json"), JSON.stringify({ worktreePath: "/repo/.claude/worktrees/agent-a2" }));
	writeFileSync(join(dir, id, "subagents", "agent-a2.jsonl"), user("w1", null, "在 worktree 里改", { isSidechain: true }) + edit("w2", "w1", "/repo/.claude/worktrees/agent-a2/x.ts", { isSidechain: true }));
	const s = await session(P, id);
	assert.deepEqual(s.touched.sort(), ["/repo/main.ts", "/repo/sub.ts"]);
	// 还没写 last-prompt：网页走最新的叶子
	assert.equal(s.leaf, null);
	// 子代理接着写：只读新写的那几行
	appendFileSync(join(dir, id, "subagents", "agent-a1.jsonl"), edit("s3", "s2r", "/repo/sub2.ts", { isSidechain: true }));
	assert.deepEqual((await session(P, id)).touched.sort(), ["/repo/main.ts", "/repo/sub.ts", "/repo/sub2.ts"]);
});

test("leaf：最后的 last-prompt；之后接着往下写的是最后那条；终端里回退过（explicit）照它；压缩之后作废", async () => {
	const P = "-tmp-leaf";
	const dir = join(tmp, ".claude", "projects", P);
	mkdirSync(dir, { recursive: true });
	const id = sid(2);
	const file = join(dir, `${id}.jsonl`);
	const prompt = (leafUuid: string, explicit = false) => line({ type: "last-prompt", lastPrompt: "问", leafUuid, sessionId: id, ...(explicit ? { explicit: true, rewound: true } : {}) });
	// 两个版本：l1 → l2 → l3（旧的），l1 → l4 → l5（新的，时间最晚）
	writeFileSync(file, user("l1", null, "问") + said("l2", "l1", "旧") + user("l3", "l2", "旧的接着问") + said("l4", "l1", "新") + user("l5", "l4", "新的接着问"));
	appendFileSync(file, prompt("l3"));
	// 附带记录不显示：换成最近的显示节点
	appendFileSync(file, line({ type: "attachment", uuid: "l3x", parentUuid: "l3", timestamp: "t", attachment: { type: "x" } }));
	assert.equal((await session(P, id)).leaf, "l3");
	// 接着往下写：最后写的那条
	appendFileSync(file, said("l6", "l3x", "接着答"));
	assert.equal((await session(P, id)).leaf, "l6");
	// 最后写的不是它的后代（别处挂着的附带记录）：还是它
	appendFileSync(file, prompt("l6") + line({ type: "attachment", uuid: "l7", parentUuid: "l5", timestamp: "t", attachment: { type: "x" } }));
	assert.equal((await session(P, id)).leaf, "l6");
	// 终端里回退到 l2：照它，哪怕它下面还有旧的
	appendFileSync(file, prompt("l2", true));
	assert.equal((await session(P, id)).leaf, "l2");
	// 回退之后接着问了：照常往下
	appendFileSync(file, user("l8", "l2", "回退后问的"));
	assert.equal((await session(P, id)).leaf, "l8");
	// 压缩之后（还没写新的 last-prompt）：不认了
	appendFileSync(file, line({ type: "system", subtype: "compact_boundary", uuid: "c9", parentUuid: null, timestamp: "t" }));
	assert.equal((await session(P, id)).leaf, null);
});

test("标题：/rename、/branch 起的名字（custom-title）比 ai-title 优先", async () => {
	const P = "-tmp-title";
	const dir = join(tmp, ".claude", "projects", P);
	mkdirSync(dir, { recursive: true });
	const id = sid(3);
	const file = join(dir, `${id}.jsonl`);
	writeFileSync(file, line({ type: "ai-title", aiTitle: "自动的", sessionId: id }) + user("t1", null, "问"));
	assert.equal((await row(P, id))?.title, "自动的");
	appendFileSync(file, line({ type: "custom-title", customTitle: "起的名字", sessionId: id }) + line({ type: "ai-title", aiTitle: "后来自动的", sessionId: id }));
	assert.equal((await row(P, id))?.title, "起的名字");
});

test("分叉：mixer 里分叉的照 state、/branch 的照 forkedFrom，都是直接的原会话；自己问的第一句按 uuid 认，不看时间", async () => {
	const { fork } = await import("../server/state.ts");
	const P = "-tmp-lineage";
	const dir = join(tmp, ".claude", "projects", P);
	mkdirSync(dir, { recursive: true });
	const write = (n: number, body: string) => writeFileSync(join(dir, `${sid(n)}.jsonl`), body);
	const base = user("r1", null, "原来的问题") + said("r2", "r1", "答") + user("r3", "r2", "原会话第二问");
	write(10, base);
	// mixer 里从 r2 分叉（state 记下的）：复制的记录 uuid 一样，自己问的那句时间和原会话的挨着也认得出。停止后补的那句不算问的
	write(11, user("r1", null, "原来的问题") + said("r2", "r1", "答") + user("i1", "r2", "[Request interrupted by user]") + user("k1", "i1", "分叉后问的"));
	fork(sid(11), { session: sid(10), at: "r2" });
	// 分叉的分叉：直接的原会话是 11，不是一家最早的 10
	write(12, user("r1", null, "原来的问题") + said("r2", "r1", "答") + user("k1", "r2", "分叉后问的") + said("k2", "k1", "答") + user("g1", "k2", "再分叉后问的"));
	fork(sid(12), { session: sid(11), at: "k2" });
	// 终端里 /branch 的：复制过来的记录带 forkedFrom
	const ff = (uuid: string) => ({ forkedFrom: { sessionId: sid(10), messageUuid: uuid } });
	write(13, line({ type: "custom-title", customTitle: "原来的 (2)", sessionId: sid(13) }) + user("r1", null, "原来的问题", ff("r1")) + said("r2", "r1", "答", ff("r2")) + user("b1", "r2", "branch 后问的"));
	// 终端里 --fork-session 的：什么标记都没有，猜一家里最早的那个
	write(14, base + said("x2", "r3", "答") + user("x3", "x2", "fork-session 后问的"));
	const metas = Object.fromEntries((await listSessions(P)).map((m) => [m.id, m]));
	assert.deepEqual([metas[sid(10)].parent, metas[sid(10)].fresh], [null, null]);
	assert.deepEqual([metas[sid(11)].parent, metas[sid(11)].fresh], [sid(10), "分叉后问的"]);
	assert.deepEqual([metas[sid(12)].parent, metas[sid(12)].fresh], [sid(11), "再分叉后问的"]);
	assert.deepEqual([metas[sid(13)].parent, metas[sid(13)].fresh, metas[sid(13)].title, metas[sid(13)].custom], [sid(10), "branch 后问的", "原来的 (2)", true]);
	assert.equal(metas[sid(11)].custom, false);
	assert.deepEqual([metas[sid(14)].parent, metas[sid(14)].fresh], [sid(10), "fork-session 后问的"]);
	// row 给的一样
	for (const n of [10, 11, 12, 13, 14]) assert.deepEqual((await row(P, sid(n)))?.parent, metas[sid(n)].parent);
	// 原会话删了：有确切来处的还指着它（侧栏里就到这为止），自己问的第一句不知道了
	rmSync(join(dir, `${sid(10)}.jsonl`));
	forget(P, sid(10));
	const after = await row(P, sid(11));
	assert.deepEqual([after?.parent, after?.fresh], [sid(10), null]);
	// 猜的那个：有确切来处的（11、12、13）不当原会话，剩下它自己
	assert.equal((await row(P, sid(14)))?.parent, null);
});

test("leaf：并行的工具调用是一体；leafUuid 指着后写的附带记录时走到它下面的回复", async () => {
	const P = "-tmp-leaf2";
	const dir = join(tmp, ".claude", "projects", P);
	mkdirSync(dir, { recursive: true });
	const id = sid(4);
	const file = join(dir, `${id}.jsonl`);
	const call = (uuid: string, parentUuid: string, tid: string, i: number) => line({ type: "assistant", uuid, parentUuid, timestamp: new Date().toISOString(), apiBlockIndex: i, message: { id: "mb", content: [{ type: "tool_use", id: tid, name: "Edit", input: {} }] } });
	const res = (uuid: string, parentUuid: string, tid: string) => line({ type: "user", uuid, parentUuid, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: "ok" }] } });
	// 一条消息里两个 Edit：e1 → e2；e1 的结果 r1 之后接着跑了 e3；e2 的结果 r2 是 leafUuid
	writeFileSync(file, user("p0", null, "改两个") + call("e1", "p0", "t1", 0) + call("e2", "e1", "t2", 1) + res("r1", "e1", "t1") + call("e3", "r1", "t3", 0).replace('"mb"', '"mc"') + res("r2", "e2", "t2"));
	appendFileSync(file, line({ type: "last-prompt", leafUuid: "r2", sessionId: id }) + res("r3", "e3", "t3"));
	assert.equal((await session(P, id)).leaf, "e3");
	// 先写的回复挂在后写的附带记录上，leafUuid 指着那条附带记录
	appendFileSync(file, said("z1", "att9", "推好了") + line({ type: "attachment", uuid: "att9", parentUuid: "r3", timestamp: new Date().toISOString(), attachment: { type: "x" } }) + line({ type: "last-prompt", leafUuid: "att9", sessionId: id }));
	assert.equal((await session(P, id)).leaf, "z1");
});
