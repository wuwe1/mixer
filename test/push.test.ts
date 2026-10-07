// push.ts：订阅存进 data/push.json；有页面看着不推；推送服务说订阅没了（410）就删；
// 来了确认请求、跑完、出错推一条（同一个会话一个 tag），点了停止的、同一次运行第二次的不推
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 不碰这台机器的 ~/.claude、data/
const tmp = mkdtempSync(join(tmpdir(), "mixer-push-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");

const push = await import("../server/push.ts");
type Sent = { endpoint: string; payload: Record<string, unknown> };
let sent: Sent[] = [];
let fail: number | null = null;
push.sender(async (sub, payload) => {
	if (fail) throw Object.assign(new Error("gone"), { statusCode: fail });
	sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
});
const saved = () => JSON.parse(readFileSync(join(tmp, "data", "push.json"), "utf8"));
const SUB = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };
const approval = (id: string) => ({ id, project: "-tmp-demo", cwd: "/tmp/demo", session: "s1", tool: "Bash", input: { command: "rm -rf build" }, at: "", toolUse: null, agent: null });
const run = (id: string, status: string, error: string | null = null) => ({ id, project: "-tmp-demo", cwd: "/tmp/demo", from: null, session: "s1", mode: "resume", at: null, prompt: "", permission: "auto", model: null, effort: null, status, started: "", ended: "", error, uuid: null, merged: [], images: 0 });

test("公钥第一次要时生成、存下；订阅要像样（https 的 endpoint、带 keys），subject 用页面的 https 地址", () => {
	const k = push.key();
	assert.match(k, /^[\w-]{80,}$/);
	assert.equal(push.key(), k);
	assert.equal(saved().vapid.publicKey, k);
	assert.throws(() => push.subscribe({ endpoint: "http://x" }, null), /订阅不对/);
	push.subscribe(SUB, "https://mixer.example");
	push.subscribe(SUB, "https://mixer.example");
	assert.equal(saved().subs.length, 1);
	assert.equal(saved().subs[0].subject, "https://mixer.example");
});

test("确认请求、跑完、出错各推一条；同一个会话一个 tag；点了停止的、同一次运行第二次的不推", async () => {
	sent = [];
	await push.watch("approval", approval("a1"));
	assert.equal(sent.length, 1);
	assert.match(String(sent[0].payload.title), /^待确认 · /);
	assert.equal(sent[0].payload.body, "Bash：rm -rf build");
	assert.equal(sent[0].payload.tag, "s:s1");
	await push.watch("run", run("r1", "running"));
	await push.watch("run", run("r2", "stopped"));
	assert.equal(sent.length, 1);
	await push.watch("run", run("r3", "done"));
	await push.watch("run", { ...run("r3", "done"), version: "1:2" });
	assert.equal(sent.length, 2);
	assert.match(String(sent[1].payload.title), /^跑完了 · /);
	await push.watch("run", run("r4", "error", "529 overloaded"));
	assert.match(String(sent[2].payload.title), /^出错了 · /);
	assert.equal(sent[2].payload.body, "529 overloaded");
});

test("有页面在前台看着就不推；走了、45 秒没报就推", async (t) => {
	sent = [];
	push.presence("page", true);
	await push.watch("approval", approval("a2"));
	assert.equal(sent.length, 0);
	push.presence("page", false);
	await push.watch("approval", approval("a3"));
	assert.equal(sent.length, 1);
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	push.presence("page", true);
	t.mock.timers.tick(46_000);
	await push.watch("approval", approval("a4"));
	assert.equal(sent.length, 2);
	push.presence("page", false);
});

test("推送服务说订阅没了（410）：删掉", async () => {
	fail = 410;
	await push.watch("approval", approval("a5"));
	fail = null;
	assert.equal(saved().subs.length, 0);
});
