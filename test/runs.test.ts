// runs.ts 的 claude 运行：一条消息一次运行，按命令行报的下落（command_lifecycle）开始、结束，不看 idle。
// idle 要等后台子代理全跑完才来，只拿来关进程。用一个假的 claude（PATH 里），照 2.1.289 实测的顺序出事件：
//   bg：开两个后台子代理（t1、t2），result、completed 之后不 idle
//   hi：一轮跑完；后台子代理都没了才 idle
//   slow：开始写，等 interrupt：result（出错）、cancelled
//   fail：result 出错（errors）、completed
//   keep：开一个后台命令（t9，不挡 idle）
//   fold：叫醒的那一轮先出了字才轮到这条（并进那一轮），result 带两个 uuid（一个是别人的）
//   stop_task：拿掉任务；停的是 t2 就当它跑完了、通知叫醒 Claude（没有 running）；没有后台子代理了补一个 idle
//   early：后台命令 e1 的 task_started 先于 background_tasks_changed
//   amb：一个 ambient 的监听 a1 和一个后台命令 b1（a1 一直在表里）
//   get_task_output：e1 回截过的一段，b1 回整段，别的回 error
//   refuse：不接（refused），不写进记录
// 会话 id 照命令行参数：--session-id（新会话、分叉，mixer 定的），不然 --resume。参数一行一个记进 argv.jsonl。
// 记录照真的写：消息用写进 stdin 时带的 uuid，回复各一条；都在 result 之前写完（真的 claude 也是）
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "mixer-runs-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
/** 第一个测试开的新会话（mixer 定的 id），后面的都接着它 */
let SID = "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bin = join(tmp, "bin");
mkdirSync(bin);
const script = join(tmp, "fake-claude.mjs");
writeFileSync(script, `
import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(tmp, "argv.jsonl"))}, JSON.stringify(argv) + "\\n");
const arg = (k) => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
const sid = arg("--session-id") ?? arg("--resume");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const dir = process.env.HOME + "/.claude/projects/-tmp-demo";
mkdirSync(dir, { recursive: true });
let prev = null;
const record = (r) => {
	const uuid = r.uuid ?? randomUUID();
	appendFileSync(dir + "/" + sid + ".jsonl", JSON.stringify({ ...r, uuid, parentUuid: prev, timestamp: new Date().toISOString(), sessionId: sid }) + "\\n");
	prev = uuid;
};
const life = (u, state) => out({ type: "command_lifecycle", command_uuid: u, state });
let tasks = [];
let busy = false;
let slow = null;
let n = 0;
const holds = () => tasks.some((t) => t.task_type === "local_agent");
const say = (text) => {
	const id = "msg_" + ++n;
	out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id } } });
	out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
	out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
	out({ type: "assistant", parent_tool_use_id: null, message: { id, content: [{ type: "text", text }] } });
	record({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });
};
const setTasks = (t) => { tasks = t; out({ type: "system", subtype: "background_tasks_changed", tasks }); };
const quiet = () => { if (!holds()) { busy = false; out({ type: "system", subtype: "session_state_changed", state: "idle" }); } };
const begin = (u) => {
	if (!busy) { busy = true; out({ type: "system", subtype: "session_state_changed", state: "running" }); }
	life(u, "queued");
	life(u, "started");
	out({ type: "system", subtype: "init", session_id: sid });
};
const end = (u, r = {}) => {
	out({ type: "result", is_error: false, result: "ok", user_message_uuids: [u], ...r });
	life(u, r.is_error && r.subtype === "error_during_execution" ? "cancelled" : "completed");
	quiet();
};
for await (const line of createInterface({ input: process.stdin })) {
	const m = JSON.parse(line);
	if (m.type === "control_request" && m.request.subtype === "interrupt" && slow) {
		const u = slow;
		slow = null;
		end(u, { is_error: true, subtype: "error_during_execution" });
	}
	if (m.type === "control_request" && m.request.subtype === "get_task_output") {
		const id = m.request.task_id;
		const response = id === "e1" ? { output: "half\\nline9\\n", total_bytes: 9000, truncated: true } : id === "b1" ? { output: "line1\\nline2\\n", total_bytes: 12, truncated: false } : null;
		out({ type: "control_response", response: response ? { subtype: "success", request_id: m.request_id, response } : { subtype: "error", request_id: m.request_id, error: "get_task_output: no shell or Monitor task with that task_id in this session" } });
	}
	if (m.type === "control_request" && m.request.subtype === "stop_task") {
		const id = m.request.task_id;
		setTasks(tasks.filter((t) => t.task_id !== id));
		if (id === "t2") {
			// 跑完了、通知叫醒 Claude：会话没 idle 过，所以没有 running
			out({ type: "system", subtype: "task_notification", task_id: "t2" });
			out({ type: "system", subtype: "init", session_id: sid });
			say("woke");
			out({ type: "result", is_error: false, result: "woke", origin: { kind: "task-notification" } });
		}
		quiet();
	}
	if (m.type !== "user") continue;
	const u = m.uuid;
	const text = m.message.content;
	if (text !== "refuse") record({ type: "user", uuid: u, message: m.message });
	if (text === "refuse") {
		// 不接这条：没写进记录
		life(u, "refused");
		quiet();
		continue;
	}
	if (text === "fold") {
		// 叫醒的那一轮已经开始在写，这条并进去
		say("folded");
		life(u, "queued");
		life(u, "started");
		out({ type: "result", is_error: false, result: "ok", user_message_uuids: ["99999999-0000-0000-0000-000000000000", u], origin: { kind: "task-notification" } });
		life("99999999-0000-0000-0000-000000000000", "completed");
		life(u, "completed");
		continue;
	}
	begin(u);
	if (text === "bg") {
		setTasks([{ task_id: "t1", task_type: "local_agent", description: "子代理一" }, { task_id: "t2", task_type: "local_agent", description: "子代理二" }]);
		say("launched");
		end(u);
	} else if (text === "keep") {
		setTasks([...tasks, { task_id: "t9", task_type: "local_bash", description: "后台命令" }]);
		end(u);
	} else if (text === "early") {
		out({ type: "system", subtype: "task_started", task_id: "e1", tool_use_id: "toolu_e1", description: "后台命令", task_type: "local_bash", is_backgrounded: true });
		setTasks([...tasks, { task_id: "e1", task_type: "local_bash", description: "后台命令" }]);
		end(u);
	} else if (text === "amb") {
		setTasks([...tasks, { task_id: "a1", task_type: "monitor_ws", description: "监听", ambient: true }, { task_id: "b1", task_type: "local_bash", description: "后台命令" }]);
		end(u);
	} else if (text === "slow") {
		say("writing");
		slow = u;
	} else if (text === "fail") {
		end(u, { is_error: true, errors: ["boom"] });
	} else {
		say("re: " + text);
		end(u);
	}
}
`);
writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
chmodSync(join(bin, "claude"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const runs = await import("../server/runs.ts");
const state = await import("../server/state.ts");
const sessions = await import("../server/sessions.ts");
/** 最近一次起的 claude 的参数 */
const lastArgv = (): string[] => JSON.parse(readFileSync(join(tmp, "argv.jsonl"), "utf8").trim().split("\n").pop() ?? "[]");
const events: { type: string; data: any }[] = []; // biome-ignore lint: 推出去的事件
runs.onEvent((type, data) => void events.push({ type, data }));

const until = async (f: () => boolean, what: string) => {
	for (let i = 0; i < 100; i++) {
		if (f()) return;
		await new Promise((ok) => setTimeout(ok, 50));
	}
	assert.fail(`等不到：${what}`);
};
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const host = () => runs.snapshot().hosts[0];
const ran = (id: string) => runs.list().find((r) => r.id === id);
const running = () => runs.list().filter((r) => r.status === "running");
const started = (r: Awaited<ReturnType<typeof runs.start>>) => ("queued" in r ? assert.fail("不该排队") : r);
const go = async (prompt: string, session: string | null = SID || null, more: { uuid?: string; images?: { media: string; data: string }[] } = {}) => started(await runs.start({ project: "-tmp-demo", cwd: tmp, session, mode: session ? "resume" : "new", prompt, permission: "auto", ...more }));
const later = (prompt: string, uuid: string) => runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "resume", prompt, permission: "auto", uuid });
/** 会话记录现在的样子 */
const record = () => sessions.session("-tmp-demo", SID);
const text = (id: string) => runs.tail(id)?.blocks.map((b) => ("text" in b ? b.text : "")).join("");

test("后台子代理开着进程：result 之后没有 idle，运行在 completed 结束；接着说不排队，直接写进去马上跑", async () => {
	const first = await go("bg", null);
	// 新会话的 id 是 mixer 定的：一开始就有，进程、工作区里也是它，--session-id 给了命令行
	assert.match(first.session ?? "", UUID);
	SID = first.session as string;
	assert.equal(host().session, SID);
	assert.equal(state.workspace()?.sessions[SID], "-tmp-demo");
	await until(() => ran(first.id)?.status === "done", "第一条结束");
	assert.equal(lastArgv()[lastArgv().indexOf("--session-id") + 1], SID);
	assert.equal(lastArgv().includes("--resume"), false);
	assert.equal(ran(first.id)?.session, SID);
	assert.equal(text(first.id), "launched");
	// Claude 闲着、后台子代理开着进程：没有在跑的运行（网页上是「后台任务在跑」），进程还在
	assert.equal(running().length, 0);
	assert.equal(host().turn, null);
	assert.deepEqual(host().tasks.map((t) => t.id), ["t1", "t2"]);
	// 子代理的输出看不了（get_task_output 只认后台命令、Monitor）
	assert.ok(host().tasks.every((t) => !t.output));
	const second = await go("hi");
	assert.equal(runs.queued().length, 0);
	await until(() => ran(second.id)?.status === "done", "第二条结束");
	assert.equal(text(second.id), "re: hi");
	assert.equal(runs.snapshot().hosts.length, 1);
	// 出错的 result：completed 时按它算
	const bad = await go("fail");
	await until(() => ran(bad.id)?.status !== "running", "出错的结束");
	assert.equal(ran(bad.id)?.status, "error");
	assert.equal(ran(bad.id)?.error, "boom");
});

test("通知叫醒的一轮：没有 running 也认得（从它的输出开始），到它的 result 结束；后台子代理都完了的 idle 才关进程", async () => {
	const before = new Set(runs.list().map((r) => r.id));
	assert.equal(runs.stopTask(host().id, "t2"), true);
	await until(() => runs.list().some((r) => !before.has(r.id) && r.status === "done"), "叫醒的那一轮结束");
	const woke = runs.list().find((r) => !before.has(r.id));
	assert.ok(woke);
	assert.equal(woke.prompt, "");
	assert.equal(woke.session, SID);
	assert.equal(text(woke.id), "woke");
	// t1 还开着：不 idle，进程留着
	await pause(200);
	assert.equal(runs.snapshot().hosts.length, 1);
	assert.equal(runs.stopTask(host().id, "t1"), true);
	await until(() => !runs.snapshot().hosts.length, "进程关掉");
	assert.equal(running().length, 0);
});

test("停止：interrupt 之后是 cancelled，算停止；运行中发的排队，停下来后接着发", async () => {
	const slow = await go("slow");
	await until(() => host()?.turn === slow.id, "开始跑");
	await until(() => text(slow.id) === "writing", "写了字");
	const q = await runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "resume", prompt: "later", permission: "auto" });
	assert.ok("queued" in q);
	assert.equal(runs.stop(slow.id), true);
	await until(() => ran(slow.id)?.status === "stopped", "停下来");
	await until(() => runs.list().some((r) => r.prompt === "later" && r.status === "done"), "排队的发出去跑完");
	assert.equal(runs.queued().length, 0);
	// 没有后台任务：idle 之后关进程
	await until(() => !runs.snapshot().hosts.length, "进程关掉");
});

test("Claude 闲着、后台命令开着：idle 不关进程；任务停了补的 idle 才关", async () => {
	const keep = await go("keep");
	await until(() => ran(keep.id)?.status === "done", "结束");
	await pause(200);
	assert.equal(runs.snapshot().hosts.length, 1);
	assert.deepEqual(host().tasks.map((t) => t.id), ["t9"]);
	assert.equal(runs.stopTask(host().id, "t9"), true);
	await until(() => !runs.snapshot().hosts.length, "进程关掉");
});

test("写进去时叫醒的一轮已经开始：输出归这条，不另起一轮；result 带几个 uuid 的，各自 completed 时结束", async () => {
	const bg = await go("bg");
	await until(() => ran(bg.id)?.status === "done", "开后台子代理");
	const before = runs.list().length;
	const fold = await go("fold");
	await until(() => ran(fold.id)?.status === "done", "并进去的结束");
	assert.equal(runs.list().length, before + 1);
	assert.equal(text(fold.id), "folded");
	assert.equal(running().length, 0);
	// 收尾：停掉两个后台子代理（停 t2 会叫醒一轮），idle 后进程关掉
	runs.stopTask(host().id, "t2");
	await until(() => running().length === 0 && host()?.tasks.length === 1, "叫醒的那一轮结束");
	runs.stopTask(host().id, "t1");
	await until(() => !runs.snapshot().hosts.length, "进程关掉");
	assert.ok(events.some((e) => e.type === "host" && e.data.gone));
});

test("task_started 先于整张表来：开它的工具调用照样对上；输出问命令行（get_task_output），截过的去掉不完整的头一行", async () => {
	const early = await go("early");
	await until(() => ran(early.id)?.status === "done", "结束");
	assert.deepEqual(host().tasks.map((t) => [t.id, t.tool, t.output]), [["e1", "toolu_e1", true]]);
	assert.deepEqual(await runs.taskOutput(host().id, "e1"), { text: "line9\n", cut: true });
	// 不认识的任务、命令行回 error：null
	assert.equal(await runs.taskOutput(host().id, "nope"), null);
	assert.equal(await runs.taskOutput("nobody", "e1"), null);
	runs.stopTask(host().id, "e1");
	await until(() => !runs.snapshot().hosts.length, "进程关掉");
});

test("ambient 的任务不算：不列、不挡删、不留着进程", async () => {
	const amb = await go("amb");
	await until(() => ran(amb.id)?.status === "done", "结束");
	assert.deepEqual(host().tasks.map((t) => t.id), ["b1"]);
	assert.match(runs.busy(SID) ?? "", /后台任务/);
	assert.deepEqual(await runs.taskOutput(host().id, "b1"), { text: "line1\nline2\n", cut: false });
	// 停了 b1，表里只剩 ambient 的 a1：idle 之后关进程
	runs.stopTask(host().id, "b1");
	await until(() => !runs.snapshot().hosts.length, "进程关掉");
	assert.equal(runs.busy(SID), null);
});

test("分叉：新会话 id 是 mixer 定的（--fork-session --session-id），从哪分叉的当场记下", async () => {
	const at = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	const fork = started(await runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "fork", at, prompt: "hi", permission: "auto" }));
	assert.match(fork.session ?? "", UUID);
	assert.notEqual(fork.session, SID);
	assert.equal(fork.from, SID);
	assert.deepEqual(state.forkOf(fork.session as string), { session: SID, at });
	assert.equal(state.workspace()?.sessions[fork.session as string], "-tmp-demo");
	await until(() => ran(fork.id)?.status === "done", "结束");
	const a = lastArgv();
	assert.equal(a[a.indexOf("--resume") + 1], SID);
	assert.ok(a.includes("--fork-session"));
	assert.equal(a[a.indexOf("--resume-session-at") + 1], at);
	assert.equal(a[a.indexOf("--session-id") + 1], fork.session);
	// 删掉会话时一起忘掉
	state.forget(fork.session as string);
	assert.equal(state.forkOf(fork.session as string), null);
	await until(() => !runs.snapshot().hosts.length, "进程关掉");
});

test("消息的 uuid 是网页给的：写进 stdin、记录里那条就是它；不像 UUID 的、发过的不收；结束时给会话写到哪了", async () => {
	const uuid = randomUUID();
	const png = { media: "image/png", data: "aGk=" };
	const r = await go("hi", SID, { uuid, images: [png] });
	assert.equal(r.uuid, uuid);
	assert.deepEqual(r.merged, [uuid]);
	assert.equal(r.images, 1);
	// 记录里还没有时，网页先画的那条从运行拿图
	assert.deepEqual(runs.runImage(uuid, 0), png);
	await assert.rejects(later("again", uuid), /发过/);
	await assert.rejects(later("bad", "not-a-uuid"), /uuid/);
	await until(() => ran(r.id)?.status === "done", "结束");
	await until(() => ran(r.id)?.version !== undefined, "算出 version");
	const s = await record();
	assert.equal(ran(r.id)?.version, s.version);
	assert.ok(s.nodes.some((n) => n.k === "user" && n.uuid === uuid));
	// 先推结束、再推带 version 的
	const mine = events.filter((e) => e.type === "run" && e.data.id === r.id && e.data.status === "done");
	assert.deepEqual(mine.map((e) => e.data.version === undefined), [true, false]);
	// 记录里有了，图不用留了
	assert.equal(runs.runImage(uuid, 0), null);
	await until(() => !runs.snapshot().hosts.length, "进程关掉");
});

test("排着的几条合成一条：另给一个 uuid，merged 记着是哪几条；带着它们的运行先推、队列后推。只有一条的用它自己的", async () => {
	const slow = await go("slow");
	await until(() => text(slow.id) === "writing", "写了字");
	const [a, b] = [randomUUID(), randomUUID()];
	const qa = await later("one", a);
	assert.ok("queued" in qa && qa.queued.uuid === a);
	await later("two", b);
	const from = events.length;
	runs.stop(slow.id);
	await until(() => runs.list().some((r) => r.merged.includes(a) && r.status === "done"), "合成的那条跑完");
	const m = runs.list().find((r) => r.merged.includes(a));
	assert.ok(m);
	assert.deepEqual(m.merged, [a, b]);
	assert.match(m.uuid ?? "", UUID);
	assert.ok(m.uuid !== a && m.uuid !== b);
	assert.equal(m.prompt, "one\n\ntwo");
	const after = events.slice(from);
	const runAt = after.findIndex((e) => e.type === "run" && e.data.id === m.id);
	const queueAt = after.findIndex((e) => e.type === "queue" && !e.data.length);
	assert.ok(runAt >= 0 && runAt < queueAt, "带着它们的运行先推");
	await until(() => ran(m.id)?.version !== undefined, "算出 version");
	assert.ok((await record()).nodes.some((n) => n.uuid === m.uuid));
	// 只有一条
	const slow2 = await go("slow");
	await until(() => text(slow2.id) === "writing", "写了字");
	const c = randomUUID();
	await later("three", c);
	runs.stop(slow2.id);
	await until(() => runs.list().some((r) => r.uuid === c && r.status === "done"), "排着的那条跑完");
	assert.deepEqual(runs.list().find((r) => r.uuid === c)?.merged, [c]);
	await until(() => !runs.snapshot().hosts.length, "进程关掉");
});

test("命令行没接的那条：出错结束，记录里没有它，version 照样给（网页的发件箱据此放回输入框）", async () => {
	const u = randomUUID();
	const r = await go("refuse", SID, { uuid: u });
	await until(() => ran(r.id)?.status === "error", "出错结束");
	await until(() => ran(r.id)?.version !== undefined, "算出 version");
	const s = await record();
	assert.equal(ran(r.id)?.version, s.version);
	assert.ok(!s.nodes.some((n) => n.uuid === u));
	await until(() => !runs.snapshot().hosts.length, "进程关掉");
});

test("新会话一开始就出错（起不来）：记录没写出来，工作区里不留这个 id", async () => {
	const bad = started(await runs.start({ project: "-tmp-nope", cwd: join(tmp, "nope"), session: null, mode: "new", prompt: "hi", permission: "auto" }));
	assert.equal(state.workspace()?.sessions[bad.session as string], "-tmp-nope");
	await until(() => ran(bad.id)?.status === "error", "出错结束");
	// 没有记录：version 当场是 null（网页据此说「启动失败」）
	assert.equal(ran(bad.id)?.version, null);
	assert.equal(bad.session && state.workspace()?.sessions[bad.session], undefined);
	assert.equal(state.unread(bad.session as string), null);
});
