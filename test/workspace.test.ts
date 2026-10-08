// workspace.ts：工作区变了推 workspace，带整个工作区（页面拿它整个换掉）；算的时候又变了，最后推的是最新的
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Group } from "../shared/api.ts";

// 不碰这台机器的 ~/.claude、data/
const tmp = mkdtempSync(join(tmpdir(), "mixer-workspace-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");

const sse = await import("../server/sse.ts");
const state = await import("../server/state.ts");
const workspace = await import("../server/workspace.ts");

test("推 workspace 带整个工作区；连着变了几次，最后一条是最新的", async () => {
	const got: string[] = [];
	const c = { write: (m: string) => void got.push(m), end: () => {} };
	await sse.join(c, async () => ({}));
	state.addToWorkspace("-tmp-a", "/tmp/a");
	const first = workspace.push();
	state.addToWorkspace("-tmp-b", "/tmp/b");
	void workspace.push();
	await first;
	sse.leave(c);
	const pushed = got.filter((m) => m.startsWith("event: workspace")).map((m) => JSON.parse(m.split("data: ")[1]) as Group[]);
	assert.ok(pushed.length >= 1);
	assert.deepEqual(pushed.at(-1)?.map((g) => [g.id, g.path, g.sessions]), [["-tmp-b", "/tmp/b", []], ["-tmp-a", "/tmp/a", []]]);
});
