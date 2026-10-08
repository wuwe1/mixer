// state.ts：跑完没看（unread）、分叉的来处、删掉会话时整份忘掉；老的 state.json（每样东西一张表、claudeModels、以前猜「终端中打开」用的 sizes）读进来换成现在的样子
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 不碰这台机器的 data/
const tmp = mkdtempSync(join(tmpdir(), "mixer-state-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
mkdirSync(join(tmp, "data"));
const old = {
	sizes: { s0: 100 },
	finished: { s0: { project: "-p", at: "2026-01-02T00:00:00.000Z", error: true } },
	seen: { s0: "2026-01-01T00:00:00.000Z", o1: "2026-01-03T00:00:00.000Z" },
	models: { o1: "opus" },
	efforts: { o1: "high" },
	permissions: { o1: "plan" },
	forks: { o1: { session: "s0", at: "u0" } },
	claudeModels: { at: "2026-01-01T00:00:00.000Z", version: "2.1.0", models: [{ value: "default" }] },
	windows: { opus: 200000 },
	workspace: { groups: [{ id: "-p", path: "/p" }], sessions: { s0: "-p" } },
};
writeFileSync(join(tmp, "data", "state.json"), JSON.stringify(old));
const state = await import("../server/state.ts");
const saved = () => JSON.parse(readFileSync(join(tmp, "data", "state.json"), "utf8"));

test("老的 state.json：每个会话的几张表并成一份，claudeModels 改叫 modelList，sizes 不要了；存的时候老的键都没了", () => {
	assert.equal(state.unread("s0"), "error");
	assert.equal(state.chosenModel("o1"), "opus");
	assert.equal(state.chosenEffort("o1"), "high");
	assert.equal(state.chosenPermission("o1"), "plan");
	assert.deepEqual(state.forkOf("o1"), { session: "s0", at: "u0" });
	assert.equal(state.modelList()?.version, "2.1.0");
	assert.deepEqual(state.windows(), { opus: 200000 });
	assert.equal(state.workspace()?.sessions.s0, "-p");
	state.seen("s1");
	const s = saved();
	for (const k of ["sizes", "finished", "seen", "models", "efforts", "permissions", "forks", "claudeModels"]) assert.equal(k in s, false, k);
	assert.deepEqual(s.sessions.o1, { seen: "2026-01-03T00:00:00.000Z", model: "opus", effort: "high", permission: "plan", fork: { session: "s0", at: "u0" } });
	assert.deepEqual(s.sessions.s0, { finished: { at: "2026-01-02T00:00:00.000Z", error: true }, seen: "2026-01-01T00:00:00.000Z" });
	assert.equal(s.modelList.version, "2.1.0");
});

test("跑完了没看是 done / error，看过了是 null", async () => {
	state.finished("s2", false);
	assert.equal(state.unread("s2"), "done");
	state.finished("s3", true);
	assert.equal(state.unread("s3"), "error");
	assert.ok(state.unreadSessions().includes("s2"));
	await new Promise((r) => setTimeout(r, 5));
	state.seen("s2");
	assert.equal(state.unread("s2"), null);
	assert.equal(state.unreadSessions().includes("s2"), false);
});

test("选的模型：选回默认就忘掉，只换权限时模型不动", () => {
	state.chooseModel("s5", "opus", "high", "plan");
	state.choosePermission("s5", "auto");
	assert.equal(state.chosenModel("s5"), "opus");
	assert.equal(state.chosenPermission("s5"), "auto");
	state.chooseModel("s5", null, null, "auto");
	assert.deepEqual(saved().sessions.s5, {});
});

test("删掉会话：跑完没看、看过、选过的模型整份忘掉", () => {
	state.finished("s4", false);
	state.chooseModel("s4", "opus", "high", "plan");
	state.forget("s4");
	assert.equal(state.unread("s4"), null);
	assert.equal(state.chosenModel("s4"), null);
	assert.equal(state.chosenEffort("s4"), null);
	assert.equal("s4" in saved().sessions, false);
});

test("分叉的来处：记下、重启后照读，删掉会话时忘掉", () => {
	assert.equal(state.forkOf("c1"), null);
	state.fork("c1", { session: "p1", at: "u1" });
	state.fork("c2", { session: "p1", at: null });
	assert.deepEqual(state.forkOf("c1"), { session: "p1", at: "u1" });
	assert.deepEqual(saved().sessions.c2.fork, { session: "p1", at: null });
	state.forget("c1");
	assert.equal(state.forkOf("c1"), null);
	assert.deepEqual(state.forkOf("c2"), { session: "p1", at: null });
});
