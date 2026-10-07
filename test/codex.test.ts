// codex.ts：Codex 的会话记录（老格式按 response_item、新格式按 item_completed、分叉、内部会话）；经 sessions.ts 分派出去的会话、详情
import assert from "node:assert/strict";
import { appendFileSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const FORK = "33333333-3333-4333-8333-333333333333";
const HIDDEN = "44444444-4444-4444-8444-444444444444";

// 假的 ~/.codex：fixtures 放进 sessions/年/月/日/rollout-…-<id>.jsonl
const tmp = mkdtempSync(join(tmpdir(), "mixer-codex-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
const FIX = join(import.meta.dirname, "fixtures", "codex");
const day = join(tmp, ".codex", "sessions", "2026", "01", "01");
mkdirSync(day, { recursive: true });
for (const [name, id] of [["old", OLD], ["new", NEW], ["fork", FORK], ["hidden", HIDDEN]]) copyFileSync(join(FIX, `${name}.jsonl`), join(day, `rollout-2026-01-01T00-00-00-${id}.jsonl`));
copyFileSync(join(FIX, "session_index.jsonl"), join(tmp, ".codex", "session_index.jsonl"));

const codex = await import("../server/codex.ts");
const sessions = await import("../server/sessions.ts");
const P = "-tmp-demo";
const open = async (id: string) => {
	const i = codex.find(id);
	assert.ok(i, `找不到 ${id}`);
	return { info: i, ...(await sessions.session(P, id)) };
};

test("老格式：人说的话从 user_message 拿，回复、推理、工具从 response_item 拿", async () => {
	const { nodes, meta, windows } = await open(OLD);
	assert.deepEqual(nodes.map((n) => n.k), ["user", "thinking", "tool", "assistant", "user", "assistant"]);
	const [u, th, tool, a, answer] = nodes;
	assert.ok(u.k === "user" && th.k === "thinking" && tool.k === "tool" && a.k === "assistant" && answer.k === "user");
	assert.equal(u.text, "列一下文件");
	assert.equal(th.text, "想一想");
	assert.equal(tool.name, "shell");
	assert.equal(tool.summary, "bash -lc ls");
	// 输出里写着退出码 1
	assert.equal(tool.result?.error, true);
	assert.equal(a.text, "没找到");
	assert.deepEqual(a.ctx, { used: 120, model: "gpt-test" });
	// 回答 Codex 的提问：显示 answer
	assert.equal(answer.text, "是的");
	// 一条直线：每个挂在上一个下面
	for (const [i, n] of nodes.entries()) assert.equal(n.parent, i ? nodes[i - 1].uuid : null);
	assert.deepEqual(windows, { "gpt-test": 200000 });
	// 标题：session_index 里同一个 id 后写的算
	assert.equal(meta.title, "老格式的会话");
	assert.equal(meta.prompts, 2);
	assert.equal(meta.agent, "codex");
});

test("新格式：按 item 拼，key 是「item id:0」，response_item 不用", async () => {
	const { nodes, info } = await open(NEW);
	assert.deepEqual(nodes.map((n) => `${n.k}:${n.uuid}`), ["user:5b0e7c2a-0000-4000-8000-000000000001", "thinking:rs_1", "tool:exec-1", "assistant:msg_1", "tool:exec-2"]);
	const [, th, ok, a, bad] = nodes;
	assert.ok(th.k === "thinking" && ok.k === "tool" && a.k === "assistant" && bad.k === "tool");
	assert.equal(th.key, "rs_1:0");
	assert.equal(a.key, "msg_1:0");
	assert.equal(a.text, "都过了");
	// 命令只留 zsh -lc 里面那句
	assert.equal(ok.name, "exec_command");
	assert.equal(ok.summary, "pnpm test");
	assert.equal(ok.key, "exec-1:0");
	assert.deepEqual(ok.result, { text: "ok", error: false, cut: false, images: 0 });
	assert.equal(bad.summary, "false");
	assert.equal(bad.result?.error, true);
	// 分叉按轮
	assert.equal(await codex.turnOf(info, "msg_1"), "turn-1");
	assert.equal(await codex.turnOf(info, "exec-2"), "turn-2");
	const d = await sessions.toolDetail(P, NEW, "exec-1");
	assert.deepEqual(d, { input: '{\n  "command": "pnpm test"\n}', result: "ok", cut: false });
});

test("分叉：前面接上原会话 ordinal 之前的节点，挂在原会话下面", async () => {
	const { nodes, meta } = await open(FORK);
	assert.deepEqual(nodes.map((n) => n.k), ["user", "thinking", "tool", "assistant", "user", "assistant"]);
	const own = nodes.slice(4);
	assert.ok(own[0].k === "user" && own[1].k === "assistant");
	assert.equal(own[0].text, "换个问法");
	assert.equal(own[0].parent, nodes[3].uuid);
	assert.equal(own[1].text, "新的回复");
	assert.equal(meta.parent, OLD);
	assert.equal(meta.first, "列一下文件");
	assert.equal(meta.last, "换个问法");
	// 接上的是复制的一份：token_count 改 ctx 时改不到原会话缓存里的节点
	const { nodes: base } = await open(OLD);
	assert.notEqual(nodes[3], base[3]);
	assert.deepEqual(nodes[3], base[3]);
});

test("内部会话不列；不是 Codex 的 id 认不出", async () => {
	assert.equal(codex.find(HIDDEN), null);
	assert.equal(codex.find("00000000-0000-4000-8000-000000000000"), null);
	const list = await codex.list("-tmp-demo");
	assert.deepEqual(list.map((m) => m.id).sort(), [OLD, NEW, FORK]);
	assert.deepEqual(codex.projects().map((p) => [p.id, p.path, p.sessions]), [["-tmp-demo", "/tmp/demo", 3]]);
});

test("没变：只回「没变」", async () => {
	const a = await sessions.session(P, OLD);
	const b = await sessions.session(P, OLD, a.version);
	assert.equal(b.delta, true);
	assert.deepEqual(b.nodes, []);
});

test("shellInner / toolOf：记录里的 PascalCase 和流里的 camelCase 都认", () => {
	assert.equal(codex.shellInner("/bin/zsh -lc 'git status'"), "git status");
	assert.equal(codex.shellInner(["/bin/bash", "-lc", "ls"]), "ls");
	assert.equal(codex.shellInner(["git", "status"]), "git status");
	assert.deepEqual(codex.toolOf({ type: "commandExecution", command: "/bin/zsh -lc 'ls'" }), { name: "exec_command", input: { command: "ls" } });
	assert.deepEqual(codex.toolOf({ type: "FileChange", changes: { "a.ts": {}, "b.ts": {} } }), { name: "apply_patch", input: { file_path: "a.ts", files: ["a.ts", "b.ts"] } });
	assert.deepEqual(codex.toolOf({ type: "fileChange", changes: [{ path: "c.ts" }] }), { name: "apply_patch", input: { file_path: "c.ts" } });
	assert.equal(codex.toolOf({ type: "AgentMessage" }), null);
});

test("增量（epoch:rev）：接着写只给新的、改过的节点；文件重写（之前的节点没了）换 epoch、整份给", async () => {
	const ID = "55555555-5555-4555-8555-555555555555";
	const rel = `2026/01/01/rollout-2026-01-01T00-00-00-${ID}.jsonl`;
	const file = join(tmp, ".codex", "sessions", rel);
	const all = readFileSync(join(FIX, "new.jsonl"), "utf8").replaceAll(NEW, ID).trimEnd().split("\n");
	writeFileSync(file, `${all.slice(0, -1).join("\n")}\n`);
	assert.ok(codex.fromPath(rel));
	const a = await sessions.session(P, ID);
	appendFileSync(file, `${all.at(-1)}\n`);
	const b = await sessions.session(P, ID, a.version);
	assert.equal(b.delta, true);
	assert.ok(b.nodes.length > 0);
	const before = new Map(a.nodes.map((n) => [n.uuid, JSON.stringify(n)]));
	for (const n of b.nodes) assert.notEqual(before.get(n.uuid), JSON.stringify(n));
	assert.deepEqual((await sessions.session(P, ID, b.version)).nodes, []);
	writeFileSync(file, `${all.slice(0, 3).join("\n")}\n`);
	const c = await sessions.session(P, ID, b.version);
	assert.equal(c.delta, false);
	assert.notEqual(c.version.split(":")[0], b.version.split(":")[0]);
	// 后给的 epoch 大：网页靠它比谁新
	assert.ok(Number(c.version.split(":")[0]) > Number(b.version.split(":")[0]));
});

test("跑完一轮算会话写到哪了：等记录里这一轮收尾（task_complete）再算，最多等那么久", async () => {
	const ID = "99999999-9999-4999-8999-999999999999";
	const rel = `2026/01/01/rollout-2026-01-01T00-00-00-${ID}.jsonl`;
	const file = join(tmp, ".codex", "sessions", rel);
	writeFileSync(file, readFileSync(join(FIX, "new.jsonl"), "utf8").replaceAll(NEW, ID));
	assert.ok(codex.fromPath(rel));
	const before = (await sessions.session(P, ID)).version;
	const ev = (payload: object) => `${JSON.stringify({ timestamp: "2026-01-01T00:01:00.000Z", type: "event_msg", payload })}\n`;
	// turn/completed 之后最后几行才写进来
	setTimeout(() => appendFileSync(file, ev({ type: "item_completed", turn_id: "turn-9", item: { type: "AgentMessage", id: "msg_9", content: [{ type: "Text", text: "晚到的" }] } }) + ev({ type: "task_complete", turn_id: "turn-9" })), 300);
	const v = await sessions.version(P, ID, "turn-9", 3000);
	const after = await sessions.session(P, ID);
	assert.equal(v, after.version);
	assert.notEqual(v, before);
	assert.ok(after.nodes.some((n) => n.uuid === "msg_9"));
	// 等不到：到点照现在的给
	const t = Date.now();
	assert.equal(await sessions.version(P, ID, "turn-nope", 300), after.version);
	assert.ok(Date.now() - t >= 300);
	// 没有这个会话
	assert.equal(await sessions.version(P, "88888888-8888-4888-8888-888888888888"), null);
});

test("推理摘要只给开头（cut），全文点开再拿", async () => {
	const ID = "66666666-6666-4666-8666-666666666666";
	const rel = `2026/01/01/rollout-2026-01-01T00-00-00-${ID}.jsonl`;
	const long = `先看看${"再想想".repeat(200)}`;
	const recs = [
		{ timestamp: "t", type: "session_meta", payload: { id: ID, cwd: "/tmp/think" } },
		{ timestamp: "t", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "u-1", content: [{ type: "text", text: "想一下" }] } } },
		{ timestamp: "t", type: "event_msg", payload: { type: "item_completed", item: { type: "Reasoning", id: "rs_long", summary_text: [long] } } },
	];
	writeFileSync(join(tmp, ".codex", "sessions", rel), `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
	assert.ok(codex.fromPath(rel));
	const th = (await sessions.session("-tmp-think", ID)).nodes.find((n) => n.uuid === "rs_long");
	assert.ok(th?.k === "thinking");
	assert.equal(th.cut, true);
	assert.equal(th.key, "rs_long:0");
	assert.ok(long.startsWith(th.text) && th.text.length < long.length);
	assert.equal(await sessions.thought("-tmp-think", ID, "rs_long"), long);
	// 短的不截
	const { nodes } = await open(NEW);
	const short = nodes.find((n) => n.uuid === "rs_1");
	assert.ok(short?.k === "thinking" && !short.cut && short.text === "先看看");
});

test("选过的模型给回来；刚写过不算终端中打开（只认线程锁）", async () => {
	const state = await import("../server/state.ts");
	const ID = "77777777-7777-4777-8777-777777777777";
	const rel = `2026/01/01/rollout-2026-01-01T00-00-00-${ID}.jsonl`;
	writeFileSync(join(tmp, ".codex", "sessions", rel), readFileSync(join(FIX, "old.jsonl"), "utf8").replaceAll(OLD, ID).replaceAll('"/tmp/demo"', '"/tmp/model"'));
	assert.ok(codex.fromPath(rel));
	const M = "-tmp-model";
	const a = await sessions.session(M, ID);
	assert.equal(a.meta.terminal, null);
	assert.equal(a.model, null);
	state.chooseModel(ID, "gpt-test", "high");
	state.finished(M, ID, false);
	const b = await sessions.session(M, ID);
	assert.equal(b.model, "gpt-test");
	assert.equal(b.effort, "high");
	assert.equal(b.meta.terminal, null);
	assert.equal(b.meta.unread, "done");
	const m = (await sessions.listSessions(M)).find((x) => x.id === ID);
	assert.equal(m?.terminal, null);
	assert.equal(m?.unread, "done");
	// 别的进程（这里是测试自己）开着它的线程锁：在 mixer 外面开着，看不出在不在跑，算 idle
	const terminals = await import("../server/terminals.ts");
	mkdirSync(terminals.LOCKS, { recursive: true });
	const fd = openSync(join(terminals.LOCKS, `${ID}.lock`), "w");
	try {
		assert.equal(await terminals.held(ID), true);
		assert.equal((await sessions.session(M, ID)).meta.terminal, "idle");
	} finally {
		closeSync(fd);
	}
	assert.equal(await terminals.held(ID), false);
	assert.equal((await sessions.session(M, ID)).meta.terminal, null);
});

test("改了的文件：新版本 FileChange 的 changes（改名的连新名字），老版本 apply_patch 的补丁头；出错的不算", async () => {
	const write = (id: string, recs: object[]) => {
		const rel = `2026/01/01/rollout-2026-01-01T00-00-00-${id}.jsonl`;
		writeFileSync(join(tmp, ".codex", "sessions", rel), `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
		assert.ok(codex.fromPath(rel));
	};
	const NEWER = "77777777-7777-4777-8777-777777777777";
	const item = (it: object) => ({ timestamp: "t", type: "event_msg", payload: { type: "item_completed", item: it } });
	write(NEWER, [
		{ timestamp: "t", type: "session_meta", payload: { id: NEWER, cwd: "/tmp/patch" } },
		item({ type: "UserMessage", id: "u-1", content: [{ type: "text", text: "改" }] }),
		item({ type: "FileChange", id: "p-1", status: "completed", changes: { "/tmp/patch/a.ts": { type: "update", unified_diff: "", move_path: "/tmp/patch/b.ts" }, "c.ts": { type: "add", content: "" } } }),
		item({ type: "FileChange", id: "p-2", status: "failed", changes: { "/tmp/patch/d.ts": { type: "update", unified_diff: "" } } }),
	]);
	const s = await sessions.session("-tmp-patch", NEWER);
	const p1 = s.nodes.find((n) => n.uuid === "p-1");
	const p2 = s.nodes.find((n) => n.uuid === "p-2");
	assert.ok(p1?.k === "tool" && p2?.k === "tool");
	assert.deepEqual([p1.file, p1.files], ["/tmp/patch/a.ts", ["/tmp/patch/a.ts", "/tmp/patch/b.ts", "/tmp/patch/c.ts"]]);
	assert.deepEqual([p2.file, p2.files], ["/tmp/patch/d.ts", undefined]);
	assert.deepEqual(s.touched.sort(), ["/tmp/patch/a.ts", "/tmp/patch/b.ts", "/tmp/patch/c.ts"]);
	assert.equal(s.leaf, null);

	const OLDER = "88888888-8888-4888-8888-888888888888";
	const patch = "*** Begin Patch\n*** Update File: /tmp/patch/x.ts\n@@\n-a\n+b\n*** Add File: y.ts\n+new\n*** End Patch";
	write(OLDER, [
		{ timestamp: "t", type: "session_meta", payload: { id: OLDER, cwd: "/tmp/patch" } },
		{ timestamp: "t", type: "event_msg", payload: { type: "user_message", message: "改" } },
		{ timestamp: "t", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c1", input: patch } },
		{ timestamp: "t", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: "Success. Updated the following files:\nM /tmp/patch/x.ts" } },
	]);
	const o = await sessions.session("-tmp-patch", OLDER);
	const t = o.nodes.find((n) => n.k === "tool");
	assert.ok(t?.k === "tool");
	assert.deepEqual(t.files, ["/tmp/patch/x.ts", "/tmp/patch/y.ts"]);
	assert.deepEqual(o.touched.sort(), ["/tmp/patch/x.ts", "/tmp/patch/y.ts"]);
});
