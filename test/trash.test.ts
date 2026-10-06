// trash.ts：删掉会话（Claude 的挪进废纸篓、Codex 的 codex archive），删不得的 409；sessions.ts 的 expires（cleanupPeriodDays）
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 不碰这台机器的 ~/.claude、~/.codex、~/.Trash、data/；codex 换成假的，只记下参数
const tmp = mkdtempSync(join(tmpdir(), "mixer-trash-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
const PROJECT = "-tmp-demo";
const dir = join(tmp, ".claude", "projects", PROJECT);
mkdirSync(dir, { recursive: true });
const day = join(tmp, ".codex", "sessions", "2026", "01", "01");
mkdirSync(day, { recursive: true });
mkdirSync(join(tmp, ".codex", "archived_sessions"), { recursive: true });
const ARGS = join(tmp, "codex-args");
const fake = (name: string, body: string) => {
	const f = join(tmp, name);
	writeFileSync(f, `#!/bin/sh\necho "$@" >> "${ARGS}"\n${body}\n`);
	chmodSync(f, 0o755);
	return f;
};
// 真的 codex archive 把文件挪去 archived_sessions
const ok = fake("codex-ok", `find "$HOME/.codex/sessions" -name "*$2.jsonl" -exec mv {} "$HOME/.codex/archived_sessions/" \\;`);
const bad = fake("codex-bad", `echo "no such session" >&2\nexit 1`);
process.env.MIXER_CODEX = ok;

const trash = await import("../server/trash.ts");
const { listSessions, parse, row } = await import("../server/sessions.ts");
const state = await import("../server/state.ts");
const codex = await import("../server/codex.ts");

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

test("90 秒内有不是 mixer 的写入（终端里可能开着）：409，什么都不动", async () => {
	const id = "bbbbbbbb-0000-4000-8000-000000000001";
	const file = claude(id, "开着的", true);
	await rejects(trash.remove(PROJECT, id), 409, /90 秒/);
	assert.ok(existsSync(file));
	// mixer 自己刚跑完的放行
	state.finished(PROJECT, id, false);
	await trash.remove(PROJECT, id);
	assert.equal(existsSync(file), false);
});

test("没有这个会话：404", async () => {
	await rejects(trash.remove(PROJECT, "cccccccc-0000-4000-8000-000000000001"), 404, /没有/);
});

test("Codex：codex archive <id>，find 不再认它；codex 失败回 500 带上它说的", async () => {
	const ID = "dddddddd-0000-4000-8000-000000000001";
	const BAD = "dddddddd-0000-4000-8000-000000000002";
	const fix = readFileSync(join(import.meta.dirname, "fixtures", "codex", "old.jsonl"), "utf8");
	for (const id of [ID, BAD]) {
		const f = join(day, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
		writeFileSync(f, fix.replaceAll("11111111-1111-4111-8111-111111111111", id));
		old(f);
		// 刚建的文件：监视到时由 fromPath 记下（find 扫目录两秒最多一次）
		assert.ok(codex.fromPath(`2026/01/01/rollout-2026-01-01T00-00-00-${id}.jsonl`));
	}
	state.addToWorkspace("-tmp-demo", "/tmp/demo", ID);
	await trash.remove("-tmp-demo", ID);
	assert.equal(readFileSync(ARGS, "utf8").trim(), `archive ${ID}`);
	assert.equal(codex.find(ID), null);
	assert.equal(ID in (state.workspace()?.sessions ?? {}), false);
	process.env.MIXER_CODEX = bad;
	await rejects(trash.remove("-tmp-demo", BAD), 500, /no such session/);
	assert.ok(codex.find(BAD));
	process.env.MIXER_CODEX = ok;
});

test("Codex 也守着 90 秒：不调 codex", async () => {
	const ID = "eeeeeeee-0000-4000-8000-000000000001";
	const rel = `2026/01/01/rollout-2026-01-01T00-00-00-${ID}.jsonl`;
	writeFileSync(join(tmp, ".codex", "sessions", rel), readFileSync(join(import.meta.dirname, "fixtures", "codex", "old.jsonl"), "utf8").replaceAll("11111111-1111-4111-8111-111111111111", ID));
	assert.ok(codex.fromPath(rel));
	const before = readFileSync(ARGS, "utf8");
	await rejects(trash.remove("-tmp-demo", ID), 409, /90 秒/);
	assert.equal(readFileSync(ARGS, "utf8"), before);
});

test("expires：最后修改 + cleanupPeriodDays（默认 30，settings.json 改了重读）；Codex 是 null", async () => {
	const id = "ffffffff-0000-4000-8000-000000000001";
	const file = claude(id, "过期");
	const m = await row(PROJECT, id);
	const mtime = Date.parse(m?.mtime ?? "");
	assert.equal(m?.expires, new Date(mtime + 30 * 86_400_000).toISOString());
	writeFileSync(join(tmp, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 7 }));
	assert.equal((await row(PROJECT, id))?.expires, new Date(mtime + 7 * 86_400_000).toISOString());
	assert.equal((await listSessions(PROJECT)).find((s) => s.id === id)?.expires, new Date(mtime + 7 * 86_400_000).toISOString());
	assert.ok(existsSync(file));
	const cx = (await listSessions("-tmp-demo")).find((s) => s.agent === "codex");
	assert.ok(cx);
	assert.equal(cx.expires, null);
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
