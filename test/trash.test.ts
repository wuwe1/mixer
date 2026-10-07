// trash.ts：删掉会话（挪进废纸篓），删不得的 409；sessions.ts 的 expires（cleanupPeriodDays）
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 不碰这台机器的 ~/.claude、~/.Trash、data/
const tmp = mkdtempSync(join(tmpdir(), "mixer-trash-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
const PROJECT = "-tmp-demo";
const dir = join(tmp, ".claude", "projects", PROJECT);
mkdirSync(dir, { recursive: true });

const trash = await import("../server/trash.ts");
const { listSessions, parse, row } = await import("../server/sessions.ts");
const state = await import("../server/state.ts");
const terminals = await import("../server/terminals.ts");

const line = (r: object) => `${JSON.stringify(r)}\n`;
const old = (f: string) => utimesSync(f, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
/** 一个 Claude 会话：标题、一句话，子代理放在旁边的文件夹里。默认一小时前写的 */
function claude(id: string, title: string, fresh = false) {
	const file = join(dir, `${id}.jsonl`);
	writeFileSync(file, line({ type: "ai-title", aiTitle: title }) + line({ type: "user", uuid: `u-${id}`, parentUuid: null, timestamp: new Date().toISOString(), message: { role: "user", content: "问" } }));
	mkdirSync(join(dir, id, "subagents"), { recursive: true });
	writeFileSync(join(dir, id, "subagents", "agent-a1.jsonl"), "");
	if (!fresh) old(file);
	return file;
}
const rejects = (p: Promise<unknown>, status: number, re: RegExp) => assert.rejects(p, (e: Error & { status?: number }) => e.status === status && re.test(e.message));

test("Claude：jsonl 和旁边的文件夹挪进废纸篓，写下原来的位置；移出工作区、忘掉状态和缓存", async () => {
	const id = "aaaaaaaa-0000-4000-8000-000000000001";
	const file = claude(id, "改一下: 登录/注册");
	await parse(file);
	state.addToWorkspace(PROJECT, "/tmp/demo", id);
	state.finished(PROJECT, id, false);
	assert.equal(state.unread(id), "done");
	await trash.remove(PROJECT, id);
	assert.equal(existsSync(file), false);
	assert.equal(existsSync(join(dir, id)), false);
	const to = join(tmp, ".Trash", "mixer 删除的会话 改一下 登录 注册 (aaaaaaaa)");
	assert.deepEqual(readdirSync(to).sort(), [`${id}.jsonl`, id, "原来的位置.txt"].sort());
	assert.ok(existsSync(join(to, id, "subagents", "agent-a1.jsonl")));
	const where = readFileSync(join(to, "原来的位置.txt"), "utf8");
	assert.ok(where.includes(file) && where.includes(join(dir, id)));
	assert.equal(id in (state.workspace()?.sessions ?? {}), false);
	assert.equal(state.unread(id), null);
	assert.equal(await row(PROJECT, id), null);
	assert.equal((await listSessions(PROJECT)).some((m) => m.id === id), false);
	// 同名的再删一个：文件夹加编号
	const id2 = "aaaaaaaa-0000-4000-8000-000000000002";
	claude(id2, "改一下: 登录/注册");
	await trash.remove(PROJECT, id2);
	assert.ok(existsSync(join(tmp, ".Trash", "mixer 删除的会话 改一下 登录 注册 (aaaaaaaa) 2", `${id2}.jsonl`)));
});

test("终端里开着（~/.claude/sessions 登记着、进程活着）：409，什么都不动；关了马上能删，刚写过也不挡", async () => {
	const id = "bbbbbbbb-0000-4000-8000-000000000001";
	const file = claude(id, "开着的", true);
	// 这个测试进程当成开着它的 claude：启动时间照 ps 的
	const procStart = (await terminals.starts([process.pid]))?.get(process.pid);
	const reg = join(terminals.REGISTRY, `${process.pid}.json`);
	mkdirSync(terminals.REGISTRY, { recursive: true });
	writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: id, cwd: "/tmp/demo", procStart, status: "idle", kind: "interactive", entrypoint: "cli" }));
	await rejects(trash.remove(PROJECT, id), 409, /终端里开着/);
	assert.ok(existsSync(file));
	rmSync(reg);
	await trash.remove(PROJECT, id);
	assert.equal(existsSync(file), false);
});

test("没有这个会话：404", async () => {
	await rejects(trash.remove(PROJECT, "cccccccc-0000-4000-8000-000000000001"), 404, /没有/);
});

test("expires：最后修改 + cleanupPeriodDays（默认 30，settings.json 改了重读）", async () => {
	const id = "ffffffff-0000-4000-8000-000000000001";
	const file = claude(id, "过期");
	const m = await row(PROJECT, id);
	const mtime = Date.parse(m?.mtime ?? "");
	assert.equal(m?.expires, new Date(mtime + 30 * 86_400_000).toISOString());
	writeFileSync(join(tmp, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 7 }));
	assert.equal((await row(PROJECT, id))?.expires, new Date(mtime + 7 * 86_400_000).toISOString());
	assert.equal((await listSessions(PROJECT)).find((s) => s.id === id)?.expires, new Date(mtime + 7 * 86_400_000).toISOString());
	assert.ok(existsSync(file));
});

test("撤销「移出整个文件夹」：文件夹连同里面的会话一起放回", () => {
	state.addToWorkspace("-tmp-undo", "/tmp/undo", "s1");
	state.addToWorkspace("-tmp-undo", "/tmp/undo", "s2");
	state.removeFromWorkspace("-tmp-undo");
	assert.equal(state.workspace()?.groups.some((g) => g.id === "-tmp-undo"), false);
	assert.equal(state.addToWorkspace("-tmp-undo", "/tmp/undo", ["s1", "s2"]), true);
	assert.equal(state.workspace()?.groups[0].id, "-tmp-undo");
	assert.equal(state.workspace()?.sessions.s1, "-tmp-undo");
	assert.equal(state.workspace()?.sessions.s2, "-tmp-undo");
	assert.equal(state.addToWorkspace("-tmp-undo", "/tmp/undo", ["s1", "s2"]), false);
});
