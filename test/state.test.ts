// state.ts：跑完没看（unread）、分叉的来处、删掉会话时忘掉；老的 state.json 里以前猜「终端中打开」用的 sizes 读进来就扔掉
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
writeFileSync(join(tmp, "data", "state.json"), JSON.stringify({ sizes: { s0: 100 }, seen: { s0: "2026-01-01T00:00:00.000Z" } }));
const state = await import("../server/state.ts");
const saved = () => JSON.parse(readFileSync(join(tmp, "data", "state.json"), "utf8"));

test("老的 state.json：sizes 不要了，别的照读", () => {
	state.seen("s1");
	assert.equal("sizes" in saved(), false);
	assert.equal(saved().seen.s0, "2026-01-01T00:00:00.000Z");
});

test("跑完了没看是 done / error，看过了是 null", async () => {
	state.finished("-p", "s2", false);
	assert.equal(state.unread("s2"), "done");
	state.finished("-p", "s3", true);
	assert.equal(state.unread("s3"), "error");
	await new Promise((r) => setTimeout(r, 5));
	state.seen("s2");
	assert.equal(state.unread("s2"), null);
});

test("删掉会话：跑完没看、看过、选过的模型一起忘掉", () => {
	state.finished("-p", "s4", false);
	state.chooseModel("s4", "opus", "high");
	state.forget("s4");
	assert.equal(state.unread("s4"), null);
	assert.equal(state.chosenModel("s4"), null);
	assert.equal(state.chosenEffort("s4"), null);
});

test("分叉的来处：记下、重启后照读，删掉会话时忘掉", () => {
	assert.equal(state.forkOf("c1"), null);
	state.fork("c1", { session: "p1", at: "u1" });
	state.fork("c2", { session: "p1", at: null });
	assert.deepEqual(state.forkOf("c1"), { session: "p1", at: "u1" });
	assert.deepEqual(saved().forks.c2, { session: "p1", at: null });
	state.forget("c1");
	assert.equal(state.forkOf("c1"), null);
	assert.deepEqual(state.forkOf("c2"), { session: "p1", at: null });
});
