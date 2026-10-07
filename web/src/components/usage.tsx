// 用量：侧栏最底下一行，所有账号里最紧的那个窗口，和一条细条（pi 这种按花的钱算的不算）；点开是「用量」，每个账号的每个窗口、花的钱。
// 电脑上是贴着侧栏的浮层，手机上从下面出来、整屏宽。条一律是灰的：用量只是中性的数，不上色
import { Gauge } from "lucide-react";
import { SidebarFooter } from "@/components/ui/sidebar";
import { useLive } from "@/lib/live";
import { clock, since } from "@/lib/time";
import { type Account, current, money, type Spend, tightest, type Window } from "@shared/usage";
import { Placeholder } from "./placeholder";
import { Popsheet } from "./popsheet";

export const pct = (used: number) => Math.round(used * 100);
export const resets = (ms: number) => `${clock(new Date(ms).toISOString())} 重置`;
/** 「5 分钟前更新」「10/3 更新」 */
const updated = (at: string) => {
	const ago = since(at);
	return ago === "刚刚" ? "刚刚更新" : ago.includes("/") ? `${ago} 更新` : `${ago}前更新`;
};
/** 半小时没更新：侧栏那一行写明多久前（Claude 的只有 mixer 里运行时才更新） */
const stale = (at: string) => Date.now() - Date.parse(at) > 30 * 60_000;
/** 账号底下的一句说明：数是怎么来的 */
const HOW: Record<string, string> = { claude: "mixer 里每次运行时更新；终端里用掉的，下次在 mixer 里运行后才算进来" };

function Bar({ used }: { used: number }) {
	return (
		<div className="h-1 overflow-hidden rounded-full bg-muted">
			<div className="h-full rounded-full bg-muted-foreground" style={{ width: `${Math.min(100, Math.max(0, used * 100))}%` }} />
		</div>
	);
}

function WindowRow({ w, now }: { w: Window; now: number }) {
	const live = current(w, now);
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between text-xs">
				<span>{w.label}</span>
				<span className="tabular-nums">{live ? `${pct(w.used)}%` : "已重置"}</span>
			</div>
			<Bar used={live ? w.used : 0} />
			{(!live || w.resetsAt) && <span className="text-2xs text-muted-foreground tabular-nums">{live && w.resetsAt ? resets(w.resetsAt) : "等下次更新"}</span>}
		</div>
	);
}

function SpendRows({ s }: { s: Spend["spend"] }) {
	const fmt = (n: number) => money(n, s.currency);
	return (
		<div className="flex flex-col gap-1 text-xs">
			<div className="flex justify-between"><span>今天</span><span className="tabular-nums">{fmt(s.today)}</span></div>
			<div className="flex justify-between">
				<span>本月</span>
				<span className="tabular-nums">{fmt(s.month)}{s.budget ? ` / ${fmt(s.budget)} · ${pct(s.month / s.budget)}%` : ""}</span>
			</div>
			{!!s.budget && <Bar used={s.month / s.budget} />}
		</div>
	);
}

function AccountUsage({ a, now }: { a: Account; now: number }) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-baseline gap-2">
				<span className="text-md font-medium">{a.label}</span>
				<span className="ml-auto text-2xs text-muted-foreground tabular-nums">{updated(a.at)}</span>
			</div>
			{a.kind === "quota" ? a.windows.map((w) => <WindowRow key={w.label} w={w} now={now} />) : <SpendRows s={a.spend} />}
			{a.kind === "quota" && a.note && <p className="text-2xs text-muted-foreground">{a.note}</p>}
			{HOW[a.id] && <p className="text-2xs text-muted-foreground">{HOW[a.id]}</p>}
		</section>
	);
}

/** 「用量」里的：每个账号一段；还没有就是空状态 */
function UsageList({ accounts }: { accounts: Account[] }) {
	if (!accounts.length) return <Placeholder icon={Gauge} text="还没有用量：在 mixer 里跑一次 Claude，或者这个月用 pi 花过钱之后就有" />;
	const now = Date.now();
	return <div className="flex flex-col gap-4">{accounts.map((a) => <AccountUsage key={a.id} a={a} now={now} />)}</div>;
}

/** 侧栏最底下：最紧的那个窗口（「Claude · 5 小时 82% · 10/6 19:40 重置」）和细条，旧了写明多久前更新。点开看全部 */
export function UsageFooter() {
	const { usage } = useLive();
	const t = tightest(usage);
	const text = t
		? `${t.account.label} · ${t.window.label} ${pct(t.window.used)}%${t.window.resetsAt ? ` · ${resets(t.window.resetsAt)}` : ""}${stale(t.account.at) ? ` · ${updated(t.account.at)}` : ""}`
		: usage.length ? "用量 · 已重置，等下次更新" : "用量";
	const line = (
		<button type="button" className="flex w-full flex-col gap-1.5 rounded-md px-1.5 py-2 text-left text-2xs text-muted-foreground outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring md:py-1.5" aria-label="用量">
			<span className="truncate tabular-nums">{text}</span>
			{t && <Bar used={t.window.used} />}
		</button>
	);
	return (
		<SidebarFooter className="px-1.5 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
			<Popsheet trigger={line} title="用量" side="right" align="end" className="max-h-[80svh]">
				<UsageList accounts={usage} />
			</Popsheet>
		</SidebarFooter>
	);
}
