// 用量：各个账号用了多少，拼成一样的样子（shared/usage.ts 的 Account）给网页：侧栏最底下一行、点开的「用量」、输入框旁边快满了的提醒。
//   Claude：models.ts 每 10 分钟起一个 claude -p --safe-mode 问 get_usage（不花 token、不写会话；终端里用掉的也算进来）→ claudeRead；
//     mixer 里每次运行的 rate_limit_event（runs.ts → claude()）先到先更新。get_usage 是命令行标着 Experimental 的，旧版、没登录、出错就只剩运行时的
//   pi（按花的钱算，kind: "spend"）：~/.pi/agent/sessions 里每条回复记下的花费，按 provider 加起来（今天、本月），见 readPi
// Claude 最后的样子记在 state.json（重启后接着显示）；pi 的每次从记录算，不记。变了推 usage（整张表）
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account, Spend } from "../shared/usage.ts";
import { type Cursor, lines, resume } from "./jsonl.ts";
import { say } from "./log.ts";
import { emit } from "./sse.ts";
import * as state from "./state.ts";

type Raw = Record<string, any>; // biome-ignore lint: 命令行的回复

/** 侧栏、面板里的先后：Claude，然后按花的钱的本月花得多的在前 */
const month = (a: Account) => (a.kind === "spend" ? a.spend.month : 0);
export const list = (): Account[] => [...Object.values(state.usage()), ...pi].sort((a, b) => Number(b.id === "claude") - Number(a.id === "claude") || month(b) - month(a) || a.id.localeCompare(b.id));

function put(a: Account) {
	state.setUsage(a);
	emit("usage", list());
}

/** Claude 的两个窗口（used 0–1、resetsAt 毫秒）→ 账号 */
type Win = { used: number; resetsAt: number | null } | null;
const claudeQuota = (five: Win, seven: Win, at: string): Account => ({
	id: "claude", label: "Claude", kind: "quota", at,
	windows: [five && { label: "5 小时", ...five }, seven && { label: "本周", ...seven }].filter((w) => !!w),
});

/** rate_limit_event 的 unifiedWindows（five_hour、seven_day：utilization 0–1、resetsAt 秒）→ 账号 */
export function claudeAccount(w: Record<string, unknown>, at = new Date().toISOString()): Account {
	const win = (x: unknown): Win => {
		const v = x as { utilization?: unknown; resetsAt?: unknown } | null | undefined;
		return typeof v?.utilization === "number" ? { used: v.utilization, resetsAt: typeof v.resetsAt === "number" ? v.resetsAt * 1000 : null } : null;
	};
	return claudeQuota(win(w.five_hour), win(w.seven_day), at);
}
/** mixer 里的运行带回来的 rate_limit_event */
export const claude = (w: Record<string, unknown>) => put(claudeAccount(w));

/**
 * get_usage 的回复 → 账号。rate_limits 的 five_hour、seven_day：utilization 是 0–100（rate_limit_event 是 0–1），resets_at 是 ISO 时间。
 * 别的（按模型的周限额、额外用量这些）不要：rate_limit_event 没有，两边来回覆盖会一会儿有一会儿没。一个窗口都没有（没登录）是 null
 */
export function claudeUsageAccount(r: Raw, at = new Date().toISOString()): Account | null {
	const l = r?.rate_limits as Raw | null | undefined;
	if (!l || r.rate_limits_available === false) return null;
	const win = (v: Raw | null | undefined): Win => {
		if (typeof v?.utilization !== "number") return null;
		const t = typeof v.resets_at === "string" ? Date.parse(v.resets_at) : typeof v.resets_at === "number" ? v.resets_at * 1000 : Number.NaN;
		return { used: v.utilization / 100, resetsAt: Number.isNaN(t) ? null : t };
	};
	const a = claudeQuota(win(l.five_hour), win(l.seven_day), at);
	return a.kind === "quota" && a.windows.length ? a : null;
}

/** models.ts 问到的 get_usage：有就记下、推；出错（旧版命令行不认识、连不上）不吵，同样的错只记一次 */
let claudeError = "";
export function claudeRead(p: Promise<unknown>) {
	return p.then((r) => {
		const a = claudeUsageAccount(r as Raw);
		if (a) put(a);
		claudeError = "";
	}, (e: Error) => {
		if (e.message !== claudeError) say(`读 Claude 用量失败：${e.message}`);
		claudeError = e.message;
	});
}

/**
 * pi：~/.pi/agent/sessions/<目录>/<时间>_<id>.jsonl，每条回复（type message、role assistant）带 provider 和 usage.cost.total。
 * 钱是美元：pi 的价目（models-store.json 的 cost）是每百万 token 多少，它自己底栏写成「$」。
 * 按 provider 把今天、本月（本地时间，按回复自己的 timestamp）加起来，一个 provider 一个账号（pi:<provider>），本月花了钱的才有。
 * 压缩、分支小结的花费记录里没有 provider，不算（pi 自己也是另算的）。
 * 每个文件记读到第几个字节，长了只读新写的，最后没写完的半行下次再读；变短了、换了（ino）从头读，没了就不算它
 */
type PiFile = Cursor & { cost: Map<string, number> }; // cost：「provider \t 本地日期」→ 美元，按天记，换天换月时重算
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
	const how = resume(f, st);
	if (how === "same") return;
	if (how === "fresh" || !f) piFiles.set(file, (f = { ino: st.ino, size: 0, mtime: 0, offset: 0, cost: new Map() }));
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
	f.mtime = st.mtimeMs;
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

/** 起来之后：pi 的 5 秒后读一次，之后每分钟（换天、换月也靠它重算） */
export function start() {
	setTimeout(() => {
		readPi();
		setInterval(() => readPi(), 60_000).unref();
	}, 5000).unref();
}
