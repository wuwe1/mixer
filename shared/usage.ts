// 用量（server/usage.ts 拼的）：每个账号一张，样子统一。服务端只用这里的类型；挑最紧的窗口给侧栏最底下、输入框旁边用。
// 没有 import：测试直接拿 node 跑它
/** 一个窗口：用了多少（0–1）、什么时候重置（毫秒，null 是不知道） */
export type Window = { label: string; used: number; resetsAt: number | null };
/**
 * quota：有窗口的订阅（Claude、Codex 的 5 小时、本周）；spend：按花的钱算的（pi 的每个 provider：今天、本月，预算还没地方设）。
 * at：最近一次更新的时间；note：一句补充（Codex 的余额、还能免费重置几次）
 */
export type Quota = { id: string; label: string; kind: "quota"; windows: Window[]; at: string; note?: string };
export type Spend = { id: string; label: string; kind: "spend"; spend: { today: number; month: number; currency: string; budget?: number }; at: string };
export type Account = Quota | Spend;

/** 钱：美元写「$0.42」「$12.30」，不到一分的写「<$0.01」；别的币种交给 Intl */
export function money(n: number, currency: string): string {
	if (n > 0 && n < 0.01) return `<${money(0.01, currency)}`;
	try { return new Intl.NumberFormat(currency === "USD" ? "en-US" : "zh-CN", { style: "currency", currency }).format(n); } catch { return `${currency} ${n.toFixed(2)}`; }
}

/** 还算数的窗口：过了重置时间的，记下的数已经不算数了，等下次更新 */
export const current = (w: Window, now = Date.now()) => w.resetsAt === null || w.resetsAt > now;

/** 最紧的那个窗口：所有 quota 账号里用得最多的（过了重置时间的不算）；一样多的前面的账号先。没有是 null */
export function tightest(accounts: Account[], now = Date.now()): { account: Quota; window: Window } | null {
	let best: { account: Quota; window: Window } | null = null;
	for (const a of accounts) {
		if (a.kind !== "quota") continue;
		for (const w of a.windows) if (current(w, now) && (!best || w.used > best.window.used)) best = { account: a, window: w };
	}
	return best;
}

/** 这个账号（claude / codex）快用完了的窗口（≥ 80%）：输入框旁边提醒一句；没有是 null */
export function nearLimit(accounts: Account[], id: string, now = Date.now()) {
	const t = tightest(accounts.filter((a) => a.id === id), now);
	return t && t.window.used >= 0.8 ? t.window : null;
}
