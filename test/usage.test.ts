// usage.ts：各个账号拼成一样的样子（Claude 的 rate_limit_event、Codex 的 account/rateLimits/read）、旧的 limits 换过来、hello 里带着；
// pi 的花费：按 provider、本地日期加起来，增量读、半行不算、换月重算；
// web/src/lib/usage.ts：挑最紧的窗口（过了重置时间的不算）、输入框旁边的提醒、钱怎么写
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Account, money, nearLimit, tightest } from "../web/src/lib/usage.ts";

// 不碰这台机器的 ~/.claude、~/.codex、data/。state.json 里是旧版本记的 limits
const tmp = mkdtempSync(join(tmpdir(), "mixer-usage-"));
process.env.HOME = tmp;
process.env.MIXER_DATA = join(tmp, "data");
mkdirSync(join(tmp, "data"), { recursive: true });
const OLD_AT = "2026-10-01T08:00:00.000Z";
writeFileSync(join(tmp, "data", "state.json"), JSON.stringify({ limits: { five_hour: { utilization: 0.3, resetsAt: 1791269435 }, seven_day: { utilization: 0.55, resetsAt: 1791800240 }, at: OLD_AT } }));

const usage = await import("../server/usage.ts");
const sse = await import("../server/sse.ts");
const { hello } = await import("../server/workspace.ts");

const saved = () => JSON.parse(readFileSync(join(tmp, "data", "state.json"), "utf8"));

test("旧的 limits 换成 Claude 的账号，旧字段不再留", () => {
	assert.deepEqual(usage.list(), [{ id: "claude", label: "Claude", kind: "quota", at: OLD_AT, windows: [{ label: "5 小时", used: 0.3, resetsAt: 1791269435_000 }, { label: "本周", used: 0.55, resetsAt: 1791800240_000 }] }]);
	const s = saved();
	assert.equal("limits" in s, false);
	assert.equal(s.usage.claude.at, OLD_AT);
});

test("窗口多长 → 叫什么", () => {
	assert.equal(usage.windowLabel(300), "5 小时");
	assert.equal(usage.windowLabel(10080), "本周");
	assert.equal(usage.windowLabel(60), "1 小时");
	assert.equal(usage.windowLabel(1440), "1 天");
	assert.equal(usage.windowLabel(43200), "30 天");
	assert.equal(usage.windowLabel(30), "30 分钟");
	assert.equal(usage.windowLabel(null), "窗口");
});

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

/** account/rateLimits/read 回来的样子（真的 app-server 回的，去掉了账号 id 这些） */
const READ = {
	rateLimits: {
		limitId: "codex", limitName: null,
		primary: { usedPercent: 82, windowDurationMins: 300, resetsAt: 1791269435 },
		secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1791800240 },
		credits: { hasCredits: false, unlimited: false, balance: "0" },
		individualLimit: null, spendControlReached: false, planType: "plus", rateLimitReachedType: null,
	},
	rateLimitsByLimitId: null,
	rateLimitResetCredits: { availableCount: 2, credits: null },
	accountId: null, rateLimitUpsell: null,
};

test("Codex 的 account/rateLimits/read → 账号：百分比换成 0–1，窗口按时长起名，余额、免费重置写在 note", () => {
	const at = "2026-10-06T00:00:00.000Z";
	assert.deepEqual(usage.codexAccount(READ, at), {
		id: "codex", label: "Codex", kind: "quota", at, note: "还能免费重置 2 次",
		windows: [{ label: "5 小时", used: 0.82, resetsAt: 1791269435_000 }, { label: "本周", used: 0.01, resetsAt: 1791800240_000 }],
	});
	const rich = usage.codexAccount({ rateLimits: { ...READ.rateLimits, secondary: null, credits: { hasCredits: true, unlimited: false, balance: "12.5" } } }, at);
	assert.ok(rich?.kind === "quota");
	assert.equal(rich.note, "余额 12.5");
	assert.equal(rich.windows.length, 1);
	const unlimited = usage.codexAccount({ rateLimits: { ...READ.rateLimits, credits: { hasCredits: false, unlimited: true, balance: null } } }, at);
	assert.equal(unlimited?.kind === "quota" && unlimited.note, "额度不限");
	assert.equal(usage.codexAccount({}, at), null);
});

test("最紧的窗口：所有账号里用得最多的，过了重置时间的不算；输入框只看自己那个 agent 的、80% 起", () => {
	const now = 1_000_000;
	const q = (id: string, windows: [string, number, number | null][]): Account => ({ id, label: id, kind: "quota", at: "", windows: windows.map(([label, used, resetsAt]) => ({ label, used, resetsAt })) });
	const accounts: Account[] = [
		q("claude", [["5 小时", 0.95, now - 1], ["本周", 0.4, now + 1]]),
		q("codex", [["5 小时", 0.82, now + 60_000], ["本周", 0.5, null]]),
		{ id: "pi", label: "pi", kind: "spend", at: "", spend: { today: 1, month: 2, currency: "USD", budget: 1 } },
	];
	const t = tightest(accounts, now);
	assert.equal(t?.account.id, "codex");
	assert.equal(t?.window.label, "5 小时");
	assert.equal(nearLimit(accounts, "codex", now)?.used, 0.82);
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
