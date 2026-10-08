// 会话底下的输入框：只有两种发送方式，继续（续接这个会话），或者分叉（开一个新会话，带着到某一处为止的上下文，原会话不动）。
// Claude 正在 mixer 里运行时继续就排队，这次运行结束后一起发送；在看旧版本、终端中打开，只能分叉。
// 分叉不用另选：从最新处分叉是最后一条回复后面的分叉图标；只能分叉时发送按钮换成分叉的图标。
// 框本身（图、字、权限、模型、「+」、发送）是 prompt.tsx 的 PromptBox，这里加上右边那几个：后台任务、运行中的停止和时长、订阅快用完的窗口、上下文用了多少。
import { GitFork } from "lucide-react";
import { memo } from "react";
import { api, type Node, type Run } from "@shared/api";
import { type Status, useLive } from "@/lib/live";
import { toast } from "@/lib/toast";
import { lastCtx, windowOf } from "@/lib/model";
import { forkPoint, type Walk } from "@/lib/thread";
import { nearLimit } from "@shared/usage";
import { ApprovalCard } from "./approvals";
import { Elapsed } from "./message";
import { PromptBox, usePrompt } from "./prompt";
import { BackgroundTasks } from "./tasks";
import { pct, resets } from "./usage";

/** 为什么只能分叉（输入框里写的那句）；能继续就是 null */
function noContinue(w: Walk, status: Status): { reason: string; hint: string } | null {
	if (!w.atLatest) return { reason: "在看旧版本", hint: "在看旧版本，发送后从这里分叉" };
	if (status === "terminal") return { reason: "终端中打开", hint: "终端中打开着，发送后分叉" };
	return null;
}

const wan = (n: number) => (n >= 10_000 ? `${Math.round(n / 10_000)} 万` : String(n));

/** 运行中跑了多久（停止在发送键上：输入框空着时它就是停止）。在做什么看对话末尾带 ping 点的那一步 */
function RunStatus({ run }: { run: Run }) {
	return (
		<span className="shrink-0 px-1 text-2xs text-muted-foreground tabular-nums">
			{run.stopping ? "停止中 · " : ""}
			<Elapsed since={Date.parse(run.started)} />
		</span>
	);
}

/** 上下文用了多少：你正在看的那条路上最后一条回复发出时的量，按下一条要用的模型的窗口算。只有圆环和百分比，多少 token 在 title 里 */
function ContextUsage({ path, windows, model }: { path: Node[]; windows: Record<string, number>; model: string }) {
	const ctx = lastCtx(path);
	if (!ctx) return null;
	const size = windowOf(model || ctx.model, windows) ?? windowOf(ctx.model, windows);
	if (!size) return <span className="px-1 text-2xs text-muted-foreground tabular-nums" title={`上下文 ${wan(ctx.used)} token`}>{wan(ctx.used)}</span>;
	const pct = Math.min(100, Math.round((ctx.used / size) * 100));
	const r = 6;
	const c = 2 * Math.PI * r;
	return (
		<span className="flex items-center gap-1 px-1 text-2xs text-muted-foreground tabular-nums" title={`上下文 ${wan(ctx.used)} / ${wan(size)} token${pct >= 80 ? "，快满了，会自动压缩" : ""}`}>
			<svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
				<circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth="2" />
				<circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
			</svg>
			{pct}%
		</span>
	);
}

/** Claude 有窗口用到 80% 以上：上下文旁边小小一句「5 小时 82%」，平时不显示 */
function QuotaHint() {
	const w = nearLimit(useLive().usage, "claude");
	if (!w) return null;
	return (
		<span className="shrink-0 px-1 text-2xs whitespace-nowrap text-muted-foreground tabular-nums" title={`Claude ${w.label}用量 ${pct(w.used)}%${w.resetsAt ? `，${resets(w.resetsAt)}` : ""}`}>
			{w.label} {pct(w.used)}%
		</span>
	);
}

/**
 * run：这个会话正在跑的那一次。只拿它不拿整个 stream：回复写着的时候每来一段字，输入框不跟着重画。
 * ids、version：记录里有的消息、拿到的数据到哪了（发件箱看发出去的那条到没到）
 */
export const Composer = memo(function Composer({ project, session, w, ids, version, status, windows, chosen, chosenEffort, chosenPermission, run, onSent }: { project: string; session: string; w: Walk; ids: Set<string>; version: string; status: Status; windows: Record<string, number>; chosen: string | null; chosenEffort: string | null; chosenPermission: string; run: Run | null; onSent?: () => void }) {
	const why = noContinue(w, status);
	const busyRun = status === "running" || status === "waiting";
	// 只能分叉：在看旧版本就从看到的地方分；否则从最新处（不给分叉点）
	const fork = why ? { at: w.atLatest ? null : forkPoint(w.path) } : undefined;
	const p = usePrompt({ resume: { project, session, path: w.path, chosen, chosenEffort, chosenPermission }, fork, record: { ids, version } }, onSent);
	// 这个会话的确认请求挂在输入框上面：不在滚动的对话里，往上翻着也看得见
	const asks = useLive().approvals.filter((a) => a.session === session);
	return (
		<div className="bg-background/80 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur md:px-6">
			{asks.length > 0 && <div className="mx-auto mb-2 flex max-h-[60svh] w-full max-w-3xl flex-col gap-2 overflow-y-auto">{asks.map((a) => <ApprovalCard key={a.id} a={a} />)}</div>}
			<PromptBox
				p={p}
				size="sm"
				placeholder={why?.hint ?? (status === "waiting" ? "先回答上面的确认；现在发送会排队…" : busyRun ? "运行中，发送后排队…" : "继续…")}
				send={why ? { label: "分叉", icon: <GitFork className="size-4" />, title: `${why.reason}，发送后分叉` } : { label: "发送" }}
				stop={run && !why ? { onClick: () => api(`/api/runs/${run.id}/stop`, {}).catch((e: Error) => toast.error(`没停下来：${e.message}`)), stopping: !!run.stopping } : undefined}
			>
				<BackgroundTasks session={session} />
				{run && <RunStatus run={run} />}
				{/* 手机上运行中地方不够：先不显示用量 */}
				<span className={run ? "hidden md:contents" : "contents"}>
					<QuotaHint />
				</span>
				<ContextUsage path={w.path} windows={windows} model={p.choice.model} />
			</PromptBox>
		</div>
	);
});
