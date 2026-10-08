// runs.ts 的确认请求（--permission-prompt-tool stdio）：命令行在 stdout 发 can_use_tool 的 control_request，mixer 在 stdin 回 control_response。
// 归会话、不归哪一轮：claude 的这一轮完了还挂着（后台子代理闲着时也会问，带 agent_id），control_cancel_request 收掉，claude 退出了作废。
// 用一个假的 claude（PATH 里），照 2.1.289 实测的帧（/tmp/g-verify 那次）出事件；stdin 收到的每行记进 stdin.jsonl：
//   hi：init、开一个后台子代理 ag1（task_started 带说明、background_tasks_changed），主线问一次 r1（Bash），子代理问一次 r2（Edit，带 agent_id），
//       不等回音就 result、completed、idle（后台子代理开着，进程不退）
//   cancel：问 r3，过一会儿 control_cancel_request
//   elicit：发一个 mixer 答不了的 control_request（r4）
//   again：问 r5，不管
//   slow：问 r6，不管（测 10 分钟）
//   plan：问 r7（ExitPlanMode），批准时带 setMode 就照它发 status（permissionMode），和真的一样
//   ask：问 r8（AskUserQuestion）
//   deny：问 r9（Bash）
//   bye：退出
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "mixer-approvals-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
const bin = join(tmp, "bin");
mkdirSync(bin);
const stdin = join(tmp, "stdin.jsonl");
const script = join(tmp, "fake-claude.mjs");
writeFileSync(script, `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1]; };
const sid = arg("--session-id") ?? arg("--resume");
appendFileSync(${JSON.stringify(join(tmp, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
const ask = (id, tool_name, input, tool_use_id, extra = {}) => out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name, display_name: tool_name, input, description: "x", permission_suggestions: [], tool_use_id, ...extra } });
for await (const line of createInterface({ input: process.stdin })) {
	appendFileSync(${JSON.stringify(stdin)}, line + "\\n");
	const m = JSON.parse(line);
	const mode = m.type === "control_response" && m.response.response?.updatedPermissions?.[0]?.mode;
	if (mode) out({ type: "system", subtype: "status", status: null, permissionMode: mode });
	if (m.type !== "user") continue;
	const say = m.message.content;
	if (say === "bye") process.exit(0);
	out({ type: "system", subtype: "session_state_changed", state: "running" });
	out({ type: "command_lifecycle", command_uuid: m.uuid, state: "started" });
	if (say === "hi") {
		out({ type: "system", subtype: "init", session_id: sid });
		out({ type: "system", subtype: "task_started", task_id: "ag1", tool_use_id: "toolu_agent", description: "查资料", subagent_type: "general-purpose", is_backgrounded: true });
		out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "ag1", task_type: "local_agent", description: "查资料" }] });
		ask("r1", "Bash", { command: "rm -rf build" }, "toolu_1");
		ask("r2", "Edit", { file_path: "/x/a.ts", old_string: "a", new_string: "b" }, "toolu_2", { agent_id: "ag1" });
	}
	if (say === "cancel") {
		ask("r3", "Write", { file_path: "/x/c.txt", content: "c" }, "toolu_3");
		await new Promise((ok) => setTimeout(ok, 100));
		out({ type: "control_cancel_request", request_id: "r3" });
	}
	if (say === "elicit") out({ type: "control_request", request_id: "r4", request: { subtype: "elicitation", mcp_server_name: "foo", message: "?" } });
	if (say === "again") ask("r5", "Bash", { command: "ls" }, "toolu_5");
	if (say === "slow") ask("r6", "Bash", { command: "make" }, "toolu_6");
	if (say === "plan") ask("r7", "ExitPlanMode", { plan: "1. 改 a" }, "toolu_7");
	if (say === "deny") ask("r9", "Bash", { command: "rm -rf build" }, "toolu_9");
	if (say === "ask") ask("r8", "AskUserQuestion", { questions: [{ question: "哪个颜色？", header: "颜色", options: [{ label: "红" }, { label: "蓝" }], multiSelect: false }] }, "toolu_8");
	out({ type: "result", is_error: false, result: "ok", user_message_uuids: [m.uuid] });
	out({ type: "command_lifecycle", command_uuid: m.uuid, state: "completed" });
	out({ type: "system", subtype: "session_state_changed", state: "idle" });
}
`);
writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
chmodSync(join(bin, "claude"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const runs = await import("../server/runs.ts");
const state = await import("../server/state.ts");
const events: { type: string; data: any }[] = []; // biome-ignore lint: 推出去的事件
runs.onEvent((type, data) => void events.push({ type, data }));

/** 等到 f 成立。用 setImmediate 转：测 10 分钟时 setTimeout 是假的 */
const until = async (f: () => boolean, what: string) => {
	const end = performance.now() + 5000;
	while (performance.now() < end) {
		if (f()) return;
		await new Promise((ok) => setImmediate(ok));
	}
	assert.fail(`等不到：${what}`);
};
const host = () => runs.snapshot().hosts[0];
const ran = (id: string) => runs.list().find((r) => r.id === id);
/** start 回的是这次运行（排队的另说，这里不会排队） */
const started = (r: Awaited<ReturnType<typeof runs.start>>) => ("queued" in r ? assert.fail("不该排队") : r);
/** mixer 写进 stdin 的 control_response，按 request_id */
const answers = () => {
	const all = existsSync(stdin) ? readFileSync(stdin, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
	return new Map(all.filter((m) => m.type === "control_response").map((m) => [m.response.request_id, m.response]));
};
const asked = (tool: string) => runs.pending().find((a) => a.tool === tool);
let SID = "";

test("can_use_tool：卡片归会话、带工具调用和子代理；允许原样回参数，拒绝带原因；这一轮完了不作废", async () => {
	const first = started(await runs.start({ project: "-tmp-demo", cwd: tmp, session: null, mode: "new", prompt: "hi", permission: "default" }));
	SID = first.session as string;
	assert.match(SID, /^[0-9a-f-]{36}$/);
	// 确认走 stdio，不再带 MCP 配置
	await until(() => existsSync(join(tmp, "argv.json")), "起了 claude");
	const argv: string[] = JSON.parse(readFileSync(join(tmp, "argv.json"), "utf8"));
	assert.equal(argv[argv.indexOf("--permission-prompt-tool") + 1], "stdio");
	assert.equal(argv.includes("--mcp-config"), false);
	await until(() => runs.pending().length === 2, "两个确认请求");
	const main = asked("Bash");
	const sub = asked("Edit");
	assert.ok(main && sub);
	assert.equal(main.session, SID);
	assert.equal(main.cwd, tmp);
	assert.equal(main.project, "-tmp-demo");
	assert.equal(main.toolUse, "toolu_1");
	assert.equal(main.agent, null);
	assert.deepEqual(main.input, { command: "rm -rf build" });
	assert.equal(sub.toolUse, "toolu_2");
	assert.deepEqual(sub.agent, { id: "ag1", description: "查资料" });
	// 推给网页的不带内部的 by、req
	const pushed = events.filter((e) => e.type === "approval");
	assert.equal(pushed.length, 2);
	assert.equal("by" in pushed[0].data, false);
	assert.equal("req" in pushed[0].data, false);
	// 这一轮跑完了（completed）：进程开着等后台子代理，确认请求还在、挡着删和重启
	await until(() => ran(first.id)?.status === "done", "这一轮结束");
	assert.equal(host().turn, null);
	assert.equal(runs.pending().length, 2);
	assert.match(runs.busy(SID) ?? "", /待确认/);
	assert.equal(runs.idle(), false);
	// 允许：behavior allow，updatedInput 是原样的参数
	assert.equal(runs.answer(main.id, { allow: true }), true);
	await until(() => answers().has("r1"), "回 r1");
	assert.deepEqual(answers().get("r1"), { request_id: "r1", subtype: "success", response: { behavior: "allow", updatedInput: { command: "rm -rf build" } } });
	assert.ok(events.some((e) => e.type === "approval-done" && e.data.id === main.id && e.data.allow === true));
	// 拒绝：behavior deny，带原因（没给原因用默认的）
	assert.equal(runs.answer(sub.id, { allow: false }), true);
	await until(() => answers().has("r2"), "回 r2");
	assert.deepEqual(answers().get("r2"), { request_id: "r2", subtype: "success", response: { behavior: "deny", message: "在 mixer 里被拒绝了" } });
	assert.equal(runs.pending().length, 0);
	// 答过的再答一次不算
	assert.equal(runs.answer(sub.id, { allow: true }), false);
});

test("control_cancel_request：卡片收掉，不回；mixer 答不了的 control_request 回 error", async () => {
	const r = started(await runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "resume", prompt: "cancel", permission: "default" }));
	await until(() => !!asked("Write"), "r3 来了");
	const id = asked("Write")?.id;
	await until(() => runs.pending().length === 0, "r3 收掉");
	assert.ok(events.some((e) => e.type === "approval-done" && e.data.id === id && e.data.allow === false));
	await until(() => ran(r.id)?.status === "done", "这一轮结束");
	const e = started(await runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "resume", prompt: "elicit", permission: "default" }));
	await until(() => answers().has("r4"), "回 r4");
	assert.equal(answers().get("r4")?.subtype, "error");
	assert.match(String(answers().get("r4")?.error), /elicitation/);
	assert.equal(runs.pending().length, 0);
	await until(() => ran(e.id)?.status === "done", "这一轮结束");
	assert.equal(answers().has("r3"), false);
});

test("10 分钟没人点：拒绝，回 deny", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		await runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "resume", prompt: "slow", permission: "default" });
		await until(() => !!asked("Bash"), "r6 来了");
		mock.timers.tick(10 * 60_000);
		await until(() => answers().has("r6"), "回 r6");
		assert.deepEqual(answers().get("r6")?.response, { behavior: "deny", message: "10 分钟没人确认，拒绝了" });
		assert.equal(runs.pending().length, 0);
	} finally {
		mock.timers.reset();
	}
});

test("回答提问：答案放进 updatedInput 的 answers；批准计划：带 setMode，命令行报了新的权限就记下（下一轮不再换）；拒绝带上说明", async () => {
	await runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "resume", prompt: "ask", permission: "plan" });
	await until(() => !!asked("AskUserQuestion"), "r8 来了");
	runs.answer(asked("AskUserQuestion")?.id ?? "", { allow: true, answers: { "哪个颜色？": "蓝" } });
	await until(() => answers().has("r8"), "回 r8");
	assert.deepEqual(answers().get("r8")?.response, { behavior: "allow", updatedInput: { questions: [{ question: "哪个颜色？", header: "颜色", options: [{ label: "红" }, { label: "蓝" }], multiSelect: false }], answers: { "哪个颜色？": "蓝" } } });
	await runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "resume", prompt: "plan", permission: "plan" });
	await until(() => !!asked("ExitPlanMode"), "r7 来了");
	runs.answer(asked("ExitPlanMode")?.id ?? "", { allow: true });
	await until(() => answers().has("r7"), "回 r7");
	assert.deepEqual(answers().get("r7")?.response, { behavior: "allow", updatedInput: { plan: "1. 改 a" }, updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] });
	await until(() => state.chosenPermission(SID) === "auto", "记下新的权限");
	await runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "resume", prompt: "deny", permission: "auto" });
	await until(() => !!asked("Bash"), "r9 来了");
	const sent = readFileSync(stdin, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(sent.filter((m) => m.request?.subtype === "set_permission_mode").at(-1)?.request.mode, "plan", "批准计划之后没再发 set_permission_mode auto");
	runs.answer(asked("Bash")?.id ?? "", { allow: false, message: "先别删，看看 build 里有什么" });
	await until(() => answers().has("r9"), "回 r9");
	assert.deepEqual(answers().get("r9")?.response, { behavior: "deny", message: "先别删，看看 build 里有什么" });
});

test("claude 退出了：没答的作废，不回", async () => {
	await runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "resume", prompt: "again", permission: "default" });
	await until(() => !!asked("Bash"), "r5 来了");
	const id = asked("Bash")?.id;
	await runs.start({ project: "-tmp-demo", cwd: tmp, session: SID, mode: "resume", prompt: "bye", permission: "default" });
	await until(() => !runs.snapshot().hosts.length, "进程拿掉");
	assert.equal(runs.pending().length, 0);
	assert.ok(events.some((e) => e.type === "approval-done" && e.data.id === id && e.data.allow === false));
	assert.equal(answers().has("r5"), false);
	assert.equal(runs.busy(SID), null);
});
