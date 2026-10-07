// models.ts：问命令行能选哪些模型（initialize 的 models）：默认放第一个、别名（value ≠ resolvedModel）是各系列最新的、固定版本、支持的思考强度；
// 头一回读的不算新，之后多出来的型号（别名换了新版也算）标「新」；存进 state.json。
// 同一个进程顺便问 get_usage 交给 usage.ts（0–100 换成 0–1）；旧版命令行不认识 get_usage 时模型照读、用量不动
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 不碰这台机器的 claude、data/：PATH 最前面放一个假的 claude，initialize 回 FAKE 里写的 models，get_usage 回 USAGE 里写的（文件没有就回 error，像旧版）
const tmp = mkdtempSync(join(tmpdir(), "mixer-models-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
const bin = join(tmp, "bin");
mkdirSync(bin);
const FAKE = join(tmp, "models.json");
const USAGE = join(tmp, "usage.json");
writeFileSync(join(bin, "claude"), `#!/bin/sh
echo '{"type":"system","subtype":"hook_started"}'
while read line; do
	case "$line" in
	*initialize*) printf '{"type":"control_response","response":{"subtype":"success","request_id":"models","response":{"models":%s}}}\\n' "$(cat '${FAKE}')" ;;
	*get_usage*) if [ -f '${USAGE}' ]; then printf '{"type":"control_response","response":{"subtype":"success","request_id":"usage","response":%s}}\\n' "$(cat '${USAGE}')"; else echo '{"type":"control_response","response":{"subtype":"error","request_id":"usage","error":"Unsupported control request subtype: get_usage"}}'; fi ;;
	esac
done
`);
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
const saved = () => JSON.parse(readFileSync(join(tmp, "data", "state.json"), "utf8"));
/** get_usage 的回复和模型分开到，等它一会儿 */
async function until(f: () => boolean) {
	for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
	assert.ok(f());
}

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
	assert.equal(saved().claudeModels.models.length, 4);
	// 旧版命令行（get_usage 回 error）：模型照读，用量不记
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(saved().usage?.claude, undefined);
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

test("别名看 value 和 resolvedModel 一不一样，不看名字；没有 resolvedModel 的才按名字猜", () => {
	const list = m.fromInit([
		{ value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
		{ value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5" },
		{ value: "glm-5", resolvedModel: "glm-5", displayName: "GLM 5" },
		{ value: "claude-opus-latest", resolvedModel: "claude-opus-5-5", displayName: "Opus latest" },
		{ value: "sonnet", displayName: "Sonnet" },
		{ value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
	], {});
	assert.deepEqual(list.map((x) => [x.id, x.latest]), [
		["fable", true],
		["claude-sonnet-5", false],
		["glm-5", false],
		["claude-opus-latest", true],
		["sonnet", true],
		["claude-haiku-4-5", false],
	]);
});

test("同一个进程问 get_usage：0–100 换成 0–1、ISO 时间换成毫秒，记下；没登录（没有 rate_limits）不动", async () => {
	writeFileSync(USAGE, JSON.stringify({
		subscription_type: "max", rate_limits_available: true,
		rate_limits: {
			five_hour: { utilization: 16, resets_at: "2026-10-07T15:29:59.837832+00:00", limit_dollars: null },
			seven_day: { utilization: 25, resets_at: "2026-10-10T23:59:59.837862+00:00", limit_dollars: null },
			seven_day_opus: null,
		},
	}));
	await m.refresh();
	await until(() => !!saved().usage?.claude);
	assert.deepEqual(saved().usage.claude.windows, [
		{ label: "5 小时", used: 0.16, resetsAt: Date.parse("2026-10-07T15:29:59.837Z") },
		{ label: "本周", used: 0.25, resetsAt: Date.parse("2026-10-10T23:59:59.837Z") },
	]);
	const at = saved().usage.claude.at;
	writeFileSync(USAGE, JSON.stringify({ rate_limits_available: false, rate_limits: null }));
	await m.refresh();
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(saved().usage.claude.at, at);
});
