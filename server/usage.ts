// 用量：各个账号用了多少，拼成一样的样子（web/src/lib/usage.ts 的 Account）给网页：侧栏最底下一行、点开的「用量」、输入框旁边快满了的提醒。
//   Claude：mixer 里每次运行的 rate_limit_event（runs.ts → claude()）。终端里用掉的要等下次 mixer 运行才知道，网页写明多久前更新
//   Codex：codex app-server 的 account/rateLimits/read（连接是 codex-run.ts 那个）：起来 15 秒后、之后每 10 分钟、
//     它推 account/rateLimits/updated（零碎的，按它的说法重新读一次）、每跑完一轮
//   pi（按花的钱算，kind: "spend"）：~/.pi/agent/sessions 里每条回复记下的花费，按 provider 加起来（今天、本月），见 readPi
// Claude、Codex 最后的样子记在 state.json（重启后接着显示）；pi 的每次从记录算，不记。变了推 usage（整张表）
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account, Spend } from "../web/src/lib/usage.ts";
import * as codexRun from "./codex-run.ts";
import { lines } from "./jsonl.ts";
import { emit } from "./sse.ts";
import * as state from "./state.ts";

type Raw = Record<string, any>; // biome-ignore lint: app-server 的回复
const say = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

/** 侧栏、面板里的先后：Claude、Codex，然后按花的钱的本月花得多的在前 */
const ORDER = ["claude", "codex"];
const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
const month = (a: Account) => (a.kind === "spend" ? a.spend.month : 0);
export const list = (): Account[] => [...Object.values(state.usage()), ...pi].sort((a, b) => rank(a.id) - rank(b.id) || month(b) - month(a) || a.id.localeCompare(b.id));

function put(a: Account) {
	state.setUsage(a);
	emit("usage", list());
}

/** 窗口多长（分钟）→ 叫什么：300「5 小时」、10080「本周」，别的「N 小时」「N 天」 */
export function windowLabel(mins: number | null | undefined): string {
	if (!mins || mins <= 0) return "窗口";
	if (mins === 10080) return "本周";
	if (mins < 60) return `${Math.round(mins)} 分钟`;
	if (mins < 1440) return `${Math.round(mins / 60)} 小时`;
	return `${Math.round(mins / 1440)} 天`;
}

/** Claude 的 unifiedWindows（five_hour、seven_day：utilization 0–1、resetsAt 秒）→ 账号。旧的 state.json 里的 limits 也是这个样子 */
export function claudeAccount(w: Record<string, unknown>, at = new Date().toISOString()): Account {
	const win = (label: string, x: unknown) => {
		const v = x as { utilization?: unknown; resetsAt?: unknown } | null | undefined;
		return typeof v?.utilization === "number" ? [{ label, used: v.utilization, resetsAt: typeof v.resetsAt === "number" ? v.resetsAt * 1000 : null }] : [];
	};
	return { id: "claude", label: "Claude", kind: "quota", windows: [...win("5 小时", w.five_hour), ...win("本周", w.seven_day)], at };
}
/** mixer 里的运行带回来的 rate_limit_event */
export const claude = (w: Record<string, unknown>) => put(claudeAccount(w));

/**
 * account/rateLimits/read 的回复 → 账号。rateLimits 的 primary、secondary 是两个窗口（usedPercent 0–100、windowDurationMins、resetsAt 秒）。
 * 有余额（credits）、还能免费重置（rateLimitResetCredits）的写一句 note。没有 rateLimits 是 null
 */
export function codexAccount(r: Raw, at = new Date().toISOString()): Account | null {
	const s = r?.rateLimits as Raw | null | undefined;
	if (!s) return null;
	const windows = [s.primary, s.secondary].filter((w): w is Raw => typeof w?.usedPercent === "number").map((w) => ({ label: windowLabel(w.windowDurationMins), used: w.usedPercent / 100, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null }));
	const c = s.credits as Raw | null | undefined;
	const resets = Number(r.rateLimitResetCredits?.availableCount ?? 0);
	const note = [c?.unlimited ? "额度不限" : c?.hasCredits && c.balance ? `余额 ${c.balance}` : null, resets > 0 ? `还能免费重置 ${resets} 次` : null].filter(Boolean).join(" · ");
	return { id: "codex", label: "Codex", kind: "quota", windows, at, ...(note ? { note } : {}) };
}

/** 读一次 Codex 的：没登录的不读；出错不吵（同样的错只记一次） */
let reading: Promise<void> | null = null;
let lastError = "";
export function readCodex() {
	reading ??= (async () => {
		if (!(await codexRun.request("account/read", {})).account) return;
		const a = codexAccount(await codexRun.request("account/rateLimits/read"));
		if (a) put(a);
		lastError = "";
	})().catch((e: Error) => {
		if (e.message !== lastError) say(`读 Codex 用量失败：${e.message}`);
		lastError = e.message;
	}).finally(() => { reading = null; });
	return reading;
}

/**
 * pi：~/.pi/agent/sessions/<目录>/<时间>_<id>.jsonl，每条回复（type message、role assistant）带 provider 和 usage.cost.total。
 * 钱是美元：pi 的价目（models-store.json 的 cost）是每百万 token 多少，它自己底栏写成「$」。
 * 按 provider 把今天、本月（本地时间，按回复自己的 timestamp）加起来，一个 provider 一个账号（pi:<provider>），本月花了钱的才有。
 * 压缩、分支小结的花费记录里没有 provider，不算（pi 自己也是另算的）。
 * 每个文件记读到第几个字节，长了只读新写的，最后没写完的半行下次再读；变短了、换了（ino）从头读，没了就不算它
 */
type PiFile = { ino: number; size: number; offset: number; cost: Map<string, number> }; // cost：「provider \t 本地日期」→ 美元，按天记，换天换月时重算
const piFiles = new Map<string, PiFile>();
let pi: Spend[] = [];
const piDir = () => join(homedir(), ".pi", "agent", "sessions");

/** 本地日期「2026-10-06」 */
const day = (ms: number) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function piFile(file: string, st: Stats) {
	let f = piFiles.get(file);
	if (!f || f.ino !== st.ino || st.size < f.offset) piFiles.set(file, (f = { ino: st.ino, size: 0, offset: 0, cost: new Map() }));
	if (f.size === st.size) return;
	for await (const { line, end } of lines(file, f.offset)) {
		f.offset = end;
		let r: Raw;
		try { r = JSON.parse(line); } catch { continue; }
		const m = r?.type === "message" && r.message?.role === "assistant" ? r.message : null;
		const c = m?.usage?.cost?.total;
		if (typeof c !== "number" || !c || typeof m.provider !== "string") continue;
		const at = typeof m.timestamp === "number" ? m.timestamp : Date.parse(r.timestamp);
		if (Number.isNaN(at)) continue;
		const k = `${m.provider}\t${day(at)}`;
		f.cost.set(k, (f.cost.get(k) ?? 0) + c);
	}
	f.size = st.size;
}

/** 记下的按天的花费 → 账号：今天、本月按 now 算 */
export function piAccounts(now = new Date(), at = now.toISOString()): Spend[] {
	const today = day(now.getTime());
	const by = new Map<string, { today: number; month: number }>();
	for (const f of piFiles.values()) {
		for (const [k, c] of f.cost) {
			const [p, d] = k.split("\t");
			if (d.slice(0, 7) !== today.slice(0, 7)) continue;
			const t = by.get(p) ?? { today: 0, month: 0 };
			t.month += c;
			if (d === today) t.today += c;
			by.set(p, t);
		}
	}
	const round = (n: number) => Math.round(n * 1e6) / 1e6;
	return [...by].filter(([, t]) => round(t.month) > 0).map(([p, t]) => ({ id: `pi:${p}`, label: `pi · ${p}`, kind: "spend", spend: { today: round(t.today), month: round(t.month), currency: "USD" }, at }));
}

/** 扫一遍 pi 的记录（没有这个文件夹就是没有）：今天、本月的数变了才推 usage */
let piReading: Promise<void> | null = null;
export function readPi(now = new Date()) {
	piReading ??= (async () => {
		const dir = piDir();
		const seen = new Set<string>();
		for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			if (!d.isDirectory()) continue;
			for (const n of await readdir(join(dir, d.name)).catch(() => [] as string[])) {
				if (!n.endsWith(".jsonl")) continue;
				const file = join(dir, d.name, n);
				const st = await stat(file).catch(() => null);
				if (!st?.isFile()) continue;
				try {
					await piFile(file, st);
					seen.add(file);
				} catch {} // 读的时候没了
			}
		}
		for (const f of piFiles.keys()) if (!seen.has(f)) piFiles.delete(f);
		const next = piAccounts(now);
		const key = (l: Spend[]) => JSON.stringify(l.map((a) => [a.id, a.spend]));
		if (key(next) === key(pi)) return;
		pi = next;
		emit("usage", list());
	})().catch((e: Error) => say(`读 pi 用量失败：${e.message}`)).finally(() => { piReading = null; });
	return piReading;
}

/** 起来之后：pi 的 5 秒后读一次，之后每分钟（换天、换月也靠它重算）。装了 Codex 才去读（15 秒后第一次，之后每 10 分钟）；它说变了、跑完一轮，攒 3 秒读一次 */
export function start() {
	setTimeout(() => {
		readPi();
		setInterval(() => readPi(), 60_000).unref();
	}, 5000).unref();
	setTimeout(() => {
		if (!codexRun.bin()) return;
		readCodex();
		setInterval(readCodex, 600_000).unref();
		let soon: ReturnType<typeof setTimeout> | null = null;
		codexRun.onNote((m) => {
			if (m.method !== "account/rateLimits/updated" && m.method !== "turn/completed") return;
			soon ??= setTimeout(() => { soon = null; readCodex(); }, 3000);
		});
	}, 15_000).unref();
}

// 旧版本只记了 Claude 的（state.json 的 limits）：换成新的样子，旧的不再留
const old = state.takeLimits();
if (old && !state.usage().claude) state.setUsage(claudeAccount(old as Record<string, unknown>, typeof old.at === "string" ? old.at : undefined));
