// terminals.ts：在 mixer 外面开着的会话，照 ~/.claude/sessions/<pid>.json（进程活着、启动时间对得上、不是 mixer 自己的）。
// HOME 是临时目录，登记文件都是假的
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "mixer-terminals-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
const t = await import("../server/terminals.ts");
mkdirSync(t.REGISTRY, { recursive: true });

const A = "aaaaaaaa-0000-4000-8000-000000000001";
/** 照 Claude Code 写的样子登记一个进程 */
const register = (pid: number, sessionId: string, more: Record<string, unknown> = {}) =>
	writeFileSync(join(t.REGISTRY, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: "/tmp/demo", startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status: "idle", ...more }));
const unregister = (pid: number) => rmSync(join(t.REGISTRY, `${pid}.json`), { force: true });
const startOf = async (pid: number) => {
	const s = (await t.starts([pid]))?.get(pid);
	assert.ok(s, "ps 查不到启动时间");
	return s;
};
/** 一个活着的子进程（不是这个测试进程：可以登记成 mixer 自己的） */
const child = () => {
	const c = spawn("sleep", ["30"], { stdio: "ignore" });
	assert.ok(c.pid);
	return { pid: c.pid, kill: () => c.kill() };
};

test("登记文件：<pid>.json 才认，pid 要对得上，停放了的不算，status busy / idle", () => {
	const ok = { pid: 12, sessionId: A, procStart: "Thu Oct  1 11:56:04 2026", status: "busy", cwd: "/x" };
	assert.deepEqual(t.entry("12.json", JSON.stringify(ok)), { pid: 12, session: A, start: "Thu Oct 1 11:56:04 2026", state: "busy", cwd: "/x" });
	assert.equal(t.entry("12.json", JSON.stringify({ ...ok, status: "idle" }))?.state, "idle");
	assert.equal(t.entry("13.json", JSON.stringify(ok)), null);
	assert.equal(t.entry("12.1735287a.key", JSON.stringify(ok)), null);
	assert.equal(t.entry("12.json", "{\"pid\":12,\"sess"), null);
	assert.equal(t.entry("12.json", JSON.stringify({ ...ok, parkedJobId: "j1" })), null);
	assert.equal(t.entry("12.json", JSON.stringify({ ...ok, sessionId: undefined })), null);
	assert.equal(t.entry("12.json", "null"), null);
});

test("Claude：进程活着、启动时间对得上才算开着；在跑闲着照登记的", async () => {
	register(process.pid, A, { procStart: await startOf(process.pid), status: "busy" });
	assert.equal(await t.held(A), true);
	assert.equal(t.of(A), "busy");
	register(process.pid, A, { procStart: await startOf(process.pid), status: "idle" });
	await t.refresh();
	assert.equal(t.of(A), "idle");
	// pid 被别的进程复用了：启动时间对不上
	register(process.pid, A, { procStart: "Thu Jan  1 00:00:00 1970", status: "busy" });
	assert.equal(await t.held(A), false);
	assert.equal(t.of(A), null);
	unregister(process.pid);
});

test("Claude：进程没了（被杀、崩了，文件留着）不算", async () => {
	const c = spawn("true");
	await new Promise((r) => c.on("exit", r));
	assert.ok(c.pid);
	register(c.pid, A, { procStart: "Thu Oct  1 11:56:04 2026" });
	assert.equal(await t.held(A), false);
	// 老版本没有 procStart：只看进程在不在
	register(c.pid, A);
	assert.equal(await t.held(A), false);
	unregister(c.pid);
});

test("Claude：mixer 自己起的 claude 不算；退出了从 mine 拿掉，别人再开就算", async () => {
	const c = child();
	register(c.pid, A, { procStart: await startOf(c.pid) });
	t.mine.add(c.pid);
	assert.equal(await t.held(A), false);
	t.mine.delete(c.pid);
	assert.equal(await t.held(A), true);
	c.kill();
	unregister(c.pid);
	assert.equal(await t.held(A), false);
});

test("Claude：登记文件读到一半（正在写）用上次的，不当成关了", async () => {
	const c = child();
	register(c.pid, A, { procStart: await startOf(c.pid) });
	assert.equal(await t.held(A), true);
	writeFileSync(join(t.REGISTRY, `${c.pid}.json`), "{\"pid\":");
	assert.equal(await t.held(A), true);
	c.kill();
	unregister(c.pid);
	assert.equal(await t.held(A), false);
});

test("开着、关了、在跑闲着换了：告诉 start 给的（带 Claude 登记的 cwd）", async () => {
	const seen: [string, string | null][] = [];
	t.start((id, cwd) => seen.push([id, cwd]));
	await t.refresh();
	seen.length = 0;
	const c = child();
	const start = await startOf(c.pid);
	register(c.pid, A, { procStart: start, status: "idle" });
	await t.refresh();
	register(c.pid, A, { procStart: start, status: "idle" });
	await t.refresh();
	register(c.pid, A, { procStart: start, status: "busy" });
	await t.refresh();
	c.kill();
	unregister(c.pid);
	await t.refresh();
	assert.deepEqual(seen, [[A, "/tmp/demo"], [A, "/tmp/demo"], [A, "/tmp/demo"]]);
});

test("登记的文件夹没有：谁都没开着", async () => {
	rmSync(t.REGISTRY, { recursive: true, force: true });
	assert.equal(await t.held(A), false);
});
