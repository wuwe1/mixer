// usage.ts：各个账号拼成一样的样子（Claude 的 rate_limit_event、get_usage）、hello 里带着；
// pi 的花费：按 provider、本地日期加起来，增量读、半行不算、换月重算；
// shared/usage.ts：挑最紧的窗口（过了重置时间的不算）、输入框旁边的提醒、钱怎么写
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Account, money, nearLimit, tightest } from "../shared/usage.ts";

// 不碰这台机器的 ~/.claude、data/
const tmp = mkdtempSync(join(tmpdir(), "mixer-usage-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");

const usage = await import("../server/usage.ts");
const sse = await import("../server/sse.ts");
const { hello } = await import("../server/workspace.ts");

const saved = () => JSON.parse(readFileSync(join(tmp, "data", "state.json"), "utf8"));

test("Claude 的 rate_limit_event → 账号：秒换成毫秒，缺的窗口不写；记下、推 usage", () => {
	const a = usage.claudeAccount({ five_hour: { utilization: 0.82, resetsAt: 100 }, seven_day: null, other: { utilization: 1 } }, "2026-10-06T00:00:00.000Z");
	assert.deepEqual(a, { id: "claude", label: "Claude", kind: "quota", at: "2026-10-06T00:00:00.000Z", windows: [{ label: "5 小时", used: 0.82, resetsAt: 100_000 }] });

	const got: string[] = [];
	const c = { write: (m: string) => void got.push(m), end: () => {} };
	return sse.join(c, async () => ({})).then(() => {
		usage.claude({ five_hour: { utilization: 0.1, resetsAt: 200 }, seven_day: { utilization: 0.2, resetsAt: 300 } });
		sse.leave(c);
		const ev = got.find((m) => m.startsWith("event: usage"));
		assert.ok(ev);
		const list = JSON.parse(ev.split("data: ")[1]) as Account[];
		assert.deepEqual(list.map((x) => x.kind === "quota" && x.windows.map((w) => w.used)), [[0.1, 0.2]]);
		assert.deepEqual(saved().usage.claude.windows.map((w: { used: number }) => w.used), [0.1, 0.2]);
	});
});

test("Claude 的 get_usage → 账号：0–100 换成 0–1、ISO 时间换成毫秒；只要 5 小时、本周；没登录、没有窗口是 null", () => {
	const at = "2026-10-07T00:00:00.000Z";
	// 真的命令行回的（2.1.289，去掉了不用的）
	const r = {
		subscription_type: "max", rate_limits_available: true,
		rate_limits: {
			five_hour: { utilization: 16, resets_at: "2026-10-07T15:29:59.837832+00:00" },
			seven_day: { utilization: 25, resets_at: "2026-10-10T23:59:59.837862+00:00" },
			seven_day_opus: null,
			iguana_necktie: { utilization: 7.9, resets_at: "2026-11-05T07:59:00+00:00", limit_dollars: 250 },
		},
	};
	assert.deepEqual(usage.claudeUsageAccount(r, at), {
		id: "claude", label: "Claude", kind: "quota", at,
		windows: [{ label: "5 小时", used: 0.16, resetsAt: Date.parse("2026-10-07T15:29:59.837Z") }, { label: "本周", used: 0.25, resetsAt: Date.parse("2026-10-10T23:59:59.837Z") }],
	});
	const one = usage.claudeUsageAccount({ rate_limits: { five_hour: { utilization: 50, resets_at: null }, seven_day: null } }, at);
	assert.deepEqual(one?.kind === "quota" && one.windows, [{ label: "5 小时", used: 0.5, resetsAt: null }]);
	assert.equal(usage.claudeUsageAccount({ rate_limits_available: false, rate_limits: null }, at), null);
	assert.equal(usage.claudeUsageAccount({ rate_limits: { five_hour: null, seven_day: null } }, at), null);
	assert.equal(usage.claudeUsageAccount(null as never, at), null);
});

/** account/rateLimits/read 回来的样子（真的 app-server 回的，去掉了账号 id 这些） */
test("最紧的窗口：所有账号里用得最多的，过了重置时间的不算；输入框只看自己那个 agent 的、80% 起", () => {
	const now = 1_000_000;
	const q = (id: string, windows: [string, number, number | null][]): Account => ({ id, label: id, kind: "quota", at: "", windows: windows.map(([label, used, resetsAt]) => ({ label, used, resetsAt })) });
	const accounts: Account[] = [
		q("claude", [["5 小时", 0.95, now - 1], ["本周", 0.4, now + 1]]),
		q("other", [["5 小时", 0.82, now + 60_000], ["本周", 0.5, null]]),
		{ id: "pi", label: "pi", kind: "spend", at: "", spend: { today: 1, month: 2, currency: "USD", budget: 1 } },
	];
	const t = tightest(accounts, now);
	assert.equal(t?.account.id, "other");
	assert.equal(t?.window.label, "5 小时");
	assert.equal(nearLimit(accounts, "other", now)?.used, 0.82);
	// Claude 的 95% 已经过了重置时间：剩下的 40% 不到 80%
	assert.equal(nearLimit(accounts, "claude", now), null);
	assert.equal(tightest([q("claude", [["5 小时", 0.9, now - 1]])], now), null);
	assert.equal(tightest([], now), null);
});

/** pi 会话记录的一行（样子照真的：外面的 timestamp 是写入时间，message.timestamp 是这条回复的毫秒） */
const piLine = (provider: string, at: Date, total: number, role = "assistant") => `${JSON.stringify({ type: "message", id: Math.random().toString(16).slice(2, 10), parentId: null, timestamp: new Date(at.getTime() + 90_000).toISOString(), message: { role, api: "openai-completions", provider, model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total } }, stopReason: "stop", timestamp: at.getTime() } })}\n`;

test("pi：每个 provider 今天、本月花了多少（本地时间），增量读，没写完的半行等写完，换天换月重算，文件没了不算", async () => {
	const dir = join(tmp, ".pi", "agent", "sessions", "--Users-me-proj--");
	mkdirSync(dir, { recursive: true });
	const a = join(dir, "2026-10-01T00-00-00-000Z_a.jsonl");
	const b = join(dir, "2026-09-30T00-00-00-000Z_b.jsonl");
	const at = (m: number, d: number, h = 12) => new Date(2026, m - 1, d, h);
	writeFileSync(a, [
		`${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: at(10, 1).toISOString(), cwd: "/Users/me/proj" })}\n`,
		`${JSON.stringify({ type: "model_change", id: "x", parentId: null, timestamp: at(10, 1).toISOString(), provider: "deepseek", modelId: "m" })}\n`,
		piLine("deepseek", at(10, 6, 9), 0.5),
		piLine("deepseek", at(10, 6, 0), 0.25), // 今天零点
		piLine("deepseek", at(10, 5, 23), 1),
		piLine("deepseek", at(9, 30, 23), 4), // 上个月
		piLine("kimi", at(10, 6), 0), // 订阅的，不花钱
		piLine("deepseek", at(10, 6), 9, "toolResult"),
		`${JSON.stringify({ type: "compaction", id: "y", parentId: "x", timestamp: at(10, 6).toISOString(), usage: { cost: { total: 7 } } })}\n`,
		"not json\n",
	].join(""));
	writeFileSync(b, [piLine("moonshotai-cn", at(9, 30), 2), piLine("moonshotai-cn", at(10, 2), 3)].join(""));

	const got: string[] = [];
	const c = { write: (m: string) => void got.push(m), end: () => {} };
	await sse.join(c, async () => ({}));
	const pushed = () => got.filter((m) => m.startsWith("event: usage")).length;
	const pi = () => usage.list().filter((x) => x.id.startsWith("pi:")).map((x) => x.kind === "spend" && [x.id, x.label, x.spend.today, x.spend.month, x.spend.currency, x.spend.budget]);

	await usage.readPi(at(10, 6, 15));
	// 本月花得多的在前，排在 Claude 后面；kimi 本月没花钱，没有
	assert.deepEqual(pi(), [["pi:moonshotai-cn", "pi · moonshotai-cn", 0, 3, "USD", undefined], ["pi:deepseek", "pi · deepseek", 0.75, 1.75, "USD", undefined]]);
	assert.deepEqual(usage.list().map((x) => x.id), ["claude", "pi:moonshotai-cn", "pi:deepseek"]);
	assert.equal(pushed(), 1);
	// pi 的不进 state.json
	assert.deepEqual(Object.keys(saved().usage), ["claude"]);

	// 什么都没变：不推
	await usage.readPi(at(10, 6, 15));
	assert.equal(pushed(), 1);

	// 追加：只读新写的；最后没写完的半行先不算
	const tail = piLine("deepseek", at(10, 6, 16), 2);
	appendFileSync(a, tail.slice(0, 40));
	await usage.readPi(at(10, 6, 17));
	assert.deepEqual(pi()[1], ["pi:deepseek", "pi · deepseek", 0.75, 1.75, "USD", undefined]);
	assert.equal(pushed(), 1);
	appendFileSync(a, tail.slice(40) + piLine("moonshotai-cn", at(10, 6, 16), 0.004));
	await usage.readPi(at(10, 6, 17));
	assert.deepEqual(pi(), [["pi:deepseek", "pi · deepseek", 2.75, 3.75, "USD", undefined], ["pi:moonshotai-cn", "pi · moonshotai-cn", 0.004, 3.004, "USD", undefined]]);
	assert.equal(pushed(), 2);

	// 第二天：今天归零，本月不变
	await usage.readPi(at(10, 7, 1));
	assert.deepEqual(pi(), [["pi:deepseek", "pi · deepseek", 0, 3.75, "USD", undefined], ["pi:moonshotai-cn", "pi · moonshotai-cn", 0, 3.004, "USD", undefined]]);
	assert.equal(pushed(), 3);
	// 下个月：都没花钱，账号没了
	await usage.readPi(at(11, 1, 1));
	assert.deepEqual(pi(), []);
	// 倒回 9 月看：9/30 那天的还在（按天记着）
	await usage.readPi(at(9, 30, 23));
	assert.deepEqual(pi(), [["pi:deepseek", "pi · deepseek", 4, 4, "USD", undefined], ["pi:moonshotai-cn", "pi · moonshotai-cn", 2, 2, "USD", undefined]]);

	// 文件没了不算；变短了（重写）从头读
	rmSync(b);
	writeFileSync(a, piLine("deepseek", at(10, 6), 0.1));
	await usage.readPi(at(10, 6, 17));
	assert.deepEqual(pi(), [["pi:deepseek", "pi · deepseek", 0.1, 0.1, "USD", undefined]]);
	sse.leave(c);

	// 没有 pi 的文件夹：什么都没有
	rmSync(join(tmp, ".pi"), { recursive: true });
	await usage.readPi(at(10, 6, 17));
	assert.deepEqual(pi(), []);
});

test("钱：美元两位小数，不到一分写 <$0.01", () => {
	assert.equal(money(0.42, "USD"), "$0.42");
	assert.equal(money(12.3, "USD"), "$12.30");
	assert.equal(money(1234.5, "USD"), "$1,234.50");
	assert.equal(money(0, "USD"), "$0.00");
	assert.equal(money(0.004, "USD"), "<$0.01");
	assert.equal(money(3, "CNY"), "¥3.00");
});

test("hello 里带着用量（整张表），没有 limits", async () => {
	const h = await hello();
	assert.deepEqual(h.usage, usage.list());
	assert.equal("limits" in h, false);
	assert.ok(Array.isArray(h.runs));
});
