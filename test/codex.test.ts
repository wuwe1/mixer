// codex.ts：Codex 的会话记录（老格式按 response_item、新格式按 item_completed、分叉、内部会话）
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
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
const open = async (id: string) => {
	const i = codex.find(id);
	assert.ok(i, `找不到 ${id}`);
	return { info: i, ...(await codex.session(i)) };
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
	const d = await codex.toolDetail(info, "exec-1");
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
});

test("内部会话不列；不是 Codex 的 id 认不出", async () => {
	assert.equal(codex.find(HIDDEN), null);
	assert.equal(codex.find("00000000-0000-4000-8000-000000000000"), null);
	const list = await codex.list("-tmp-demo");
	assert.deepEqual(list.map((m) => m.id).sort(), [OLD, NEW, FORK]);
	assert.deepEqual(codex.projects().map((p) => [p.id, p.path, p.sessions]), [["-tmp-demo", "/tmp/demo", 3]]);
});

test("没变：只回「没变」", async () => {
	const i = codex.find(OLD);
	assert.ok(i);
	const a = await codex.session(i);
	const b = await codex.session(i, a.version);
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
