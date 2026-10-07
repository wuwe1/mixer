// models.ts：问命令行能选哪些模型（initialize 的 models）：默认放第一个、别名是各系列最新的、固定版本、支持的思考强度；
// 头一回读的不算新，之后多出来的型号（别名换了新版也算）标「新」；存进 state.json
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 不碰这台机器的 claude、data/：PATH 最前面放一个假的 claude，回 FAKE 里写的 models
const tmp = mkdtempSync(join(tmpdir(), "mixer-models-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
const bin = join(tmp, "bin");
mkdirSync(bin);
const FAKE = join(tmp, "models.json");
writeFileSync(join(bin, "claude"), `#!/bin/sh\nread line\necho '{"type":"system","subtype":"hook_started"}'\nprintf '{"type":"control_response","response":{"subtype":"success","request_id":"models","response":{"models":%s}}}\\n' "$(cat '${FAKE}')"\ncat >/dev/null\n`);
chmodSync(join(bin, "claude"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const models = (opus: string) => [
	{ value: "default", resolvedModel: opus, displayName: "Default (recommended)", supportedEffortLevels: EFFORTS },
	{ value: "opus", resolvedModel: opus, displayName: opus === "claude-opus-6" ? "Opus 6" : "Opus 5.5", supportedEffortLevels: EFFORTS },
	{ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
	{ value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", supportedEffortLevels: EFFORTS },
];
writeFileSync(FAKE, JSON.stringify(models("claude-opus-5-5")));

const m = await import("../server/models.ts");

test("第一次：等命令行回，默认在第一个，别名和固定版本分开，头一回的都不算新", async () => {
	const list = await m.claude();
	assert.deepEqual(list.map((x) => [x.id, x.label, x.latest, x.isNew]), [
		["", "默认", false, false],
		["opus", "Opus 5.5", true, false],
		["haiku", "Haiku 4.5", true, false],
		["claude-opus-4-8", "Opus 4.8", false, false],
	]);
	assert.deepEqual(list[1].efforts, EFFORTS);
	assert.deepEqual(list[2].efforts, []);
	const saved = JSON.parse(readFileSync(join(tmp, "data", "state.json"), "utf8"));
	assert.equal(saved.claudeModels.models.length, 4);
});

test("出了新版：别名指向新型号，标新；存着的直接给，不再问", async () => {
	writeFileSync(FAKE, JSON.stringify(models("claude-opus-6")));
	assert.equal((await m.claude())[1].label, "Opus 5.5");
	const list = await m.refresh();
	assert.deepEqual(list.map((x) => [x.id, x.label, x.isNew]), [
		["", "默认", false],
		["opus", "Opus 6", true],
		["haiku", "Haiku 4.5", false],
		["claude-opus-4-8", "Opus 4.8", false],
	]);
});
