// 输入框：只有两种发送方式，继续（续接这个会话），或者分叉（开一个新会话，带着到某一处为止的上下文，原会话不动）。
// Claude 正在 mixer 里运行时继续就排队，这次运行结束后一起发送；在看旧版本、终端中打开，只能分叉。
// 分叉不用另选：从最新处分叉是最后一条回复后面的分叉图标；只能分叉时发送按钮换成分叉的图标。
// 下面一排：权限、模型、「+」（图片、skill）；右边是后台任务、运行中的停止和时长、订阅快用完的窗口、上下文用了多少、发送。
import { Bot, Code, GitFork, Hand, ImagePlus, ListChecks, Plus, Send, Sparkles, Square, SquareSlash } from "lucide-react";
import { Fragment, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, type Node, type Run } from "@/lib/api";
import { type Status, useLive } from "@/lib/live";
import { type Agent as Kind, family, lastCtx, MODELS, modelFor, pretty, windowOf } from "@/lib/model";
import { effortLabel, type ModelInfo } from "@/lib/model-info";
import { useDraft, useOutbox } from "@/lib/outbox";
import { forkPoint, type Walk } from "@/lib/thread";
import { nearLimit } from "@/lib/usage";
import { AttachStrip, encode, type Shot, toShots } from "./attach";
import { start } from "./fork-dialog";
import { Elapsed } from "./message";
import { SkillPicker } from "./lazy";
import { BackgroundTasks } from "./tasks";
import { pct, resets } from "./usage";

type Option = { v: string; icon: typeof Send; label: string; desc: string };

/** 输入框下面的小选项：平时只是个图标（不带箭头），点开才写每一项是什么意思 */
function OptionMenu({ title, options, value, onChange }: { title: string; options: Option[]; value: string; onChange: (v: string) => void }) {
	const cur = options.find((o) => o.v === value) ?? options[0];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`${title}：${cur.label}`} title={`${title}：${cur.label}`}>
					<cur.icon className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72">
				<DropdownMenuLabel>{title}</DropdownMenuLabel>
				<DropdownMenuRadioGroup value={value} onValueChange={onChange}>
					{options.map((o) => (
						<DropdownMenuRadioItem key={o.v} value={o.v} className="items-start gap-2.5 py-2">
							<o.icon className="mt-0.5 size-4 text-muted-foreground" />
							<span className="flex flex-col gap-0.5">
								<span className="font-medium">{o.label}</span>
								<span className="text-xs leading-snug text-muted-foreground">{o.desc}</span>
							</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// auto：Claude Code 的自动模式，由它判断，一般操作直接放行，有风险的才请求确认。「Accept edits」被它盖住了，不再单列
const PERMISSIONS: Option[] = [
	{ v: "auto", icon: Sparkles, label: "自动", desc: "直接执行，有风险的才请求确认" },
	{ v: "default", icon: Hand, label: "每次询问", desc: "改文件、跑命令前都请求确认" },
	{ v: "plan", icon: ListChecks, label: "计划模式", desc: "只读不改，先出计划" },
];

/** 能选的模型：整个页面共用一份，菜单打开时超过 1 分钟就重新拿（Claude 出了新模型能马上看到）。拿不到时 Claude 用 MODELS 顶一下 */
const lists: Partial<Record<Kind, { at: number; p: Promise<ModelInfo[]> }>> = {};
const fallback = (agent: Kind): ModelInfo[] => [
	{ id: "", label: "默认", resolved: null, efforts: [], defaultEffort: null, latest: false, isNew: false },
	...(agent === "claude" ? MODELS.map((m) => ({ id: m.v as string, label: m.label, resolved: null, efforts: [], defaultEffort: null, latest: true, isNew: false })) : []),
];
function useModels(agent: Kind, on: boolean) {
	const [got, setGot] = useState<{ agent: Kind; list: ModelInfo[] } | null>(null);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!on) return;
		let c = lists[agent];
		if (!c || Date.now() - c.at > 60_000) {
			const p = api<ModelInfo[]>(`/api/models/${agent}`).catch(() => { delete lists[agent]; return []; });
			lists[agent] = c = { at: Date.now(), p };
		}
		let live = true;
		c.p.then((list) => live && setGot({ agent, list }));
		return () => { live = false; };
	}, [agent, on, tick]);
	const list = got?.agent === agent && got.list.length ? got.list : fallback(agent);
	return [list, () => setTick((t) => t + 1)] as const;
}

/** 选中的那个；没在列表里（比如上一条回复用的型号）就按默认的算思考强度 */
const entry = (list: ModelInfo[], id: string) => list.find((m) => m.id === id) ?? list[0];

/** 模型的名字：列表里有就用列表的（Opus 5.5），没有就从型号拼 */
const nameOf = (list: ModelInfo[], id: string) => list.find((m) => m.id === id && m.id)?.label ?? pretty(id);

export type Choice = { agent: Kind; model: string; effort: string };

/**
 * 模型和思考强度一个菜单：上面是默认和各系列最新的（别名，出了新版自动跟上），再是固定的版本（一行一个），最下面一排思考强度
 * （只列选中的模型支持的；换了不支持的模型就回到默认）。sections 多于一个时按 agent 分组列（新会话：选了哪组的就是哪个 agent）。
 * current：上一条回复实际用的型号
 */
function ModelMenu({ sections, value, onChange, current, text, onOpen }: { sections: { agent: Kind; title?: string; list: ModelInfo[] }[]; value: Choice; onChange: (v: Choice) => void; current?: string | null; text: ReactNode; onOpen: () => void }) {
	const sel = sections.find((x) => x.agent === value.agent) ?? sections[0];
	const efforts = entry(sel.list, value.model).efforts;
	const pick = (v: string) => {
		const i = v.indexOf(":");
		const agent = v.slice(0, i) as Kind;
		const model = v.slice(i + 1);
		const list = sections.find((x) => x.agent === agent)?.list ?? [];
		const keep = agent === value.agent && entry(list, model).efforts.includes(value.effort);
		onChange({ agent, model, effort: keep ? value.effort : "" });
	};
	const desc = (agent: Kind, m: ModelInfo) => {
		if (!m.id) return agent === "codex" ? (m.resolved ? `Codex 的默认（${m.resolved}）` : "Codex 的默认") : "用 Claude Code 的设置";
		if (agent === "codex") return current === m.id ? "现在用的" : m.id;
		if (current && current === m.resolved) return `现在用的是 ${pretty(current)}`;
		return m.latest ? `最新的 ${m.label.split(" ")[0]}，出了新版自动换` : m.label;
	};
	const row = (agent: Kind, m: ModelInfo, two: boolean) => (
		<DropdownMenuRadioItem key={m.id} value={`${agent}:${m.id}`} className={two ? "items-start gap-2.5 py-2" : "gap-2.5"}>
			{agent === "codex" ? <Code className={`${two ? "mt-0.5 " : ""}size-4 text-muted-foreground`} /> : <Bot className={`${two ? "mt-0.5 " : ""}size-4 text-muted-foreground`} />}
			<span className="flex flex-col gap-0.5">
				<span className="flex items-center gap-1.5 font-medium">
					{m.label}
					{m.isNew && <Badge variant="secondary">新</Badge>}
				</span>
				{two && <span className="text-xs leading-snug text-muted-foreground">{desc(agent, m)}</span>}
			</span>
		</DropdownMenuRadioItem>
	);
	return (
		<DropdownMenu onOpenChange={(o) => o && onOpen()}>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm" className="px-1.5 text-muted-foreground" aria-label="模型" title="模型、思考强度">
					<span className="text-2xs">{text}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-h-(--radix-dropdown-menu-content-available-height) w-72 overflow-y-auto">
				<DropdownMenuRadioGroup value={`${value.agent}:${value.model}`} onValueChange={pick}>
					{sections.map(({ agent, title, list }, i) => {
						// Claude 的固定版本一行一个，收在下面；Codex 的都是两行
						const pinned = agent === "claude" ? list.filter((m) => m.id && !m.latest) : [];
						return (
							<Fragment key={agent}>
								{i > 0 && <DropdownMenuSeparator />}
								<DropdownMenuLabel>{title ?? "模型"}</DropdownMenuLabel>
								{list.filter((m) => !pinned.includes(m)).map((m) => row(agent, m, true))}
								{pinned.length > 0 && <DropdownMenuLabel className="text-2xs">固定版本</DropdownMenuLabel>}
								{pinned.map((m) => row(agent, m, false))}
							</Fragment>
						);
					})}
				</DropdownMenuRadioGroup>
				{efforts.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>思考强度</DropdownMenuLabel>
						<ToggleGroup type="single" size="sm" spacing={1} className="flex-wrap px-1.5 pb-1.5" value={value.effort || "default"} onValueChange={(e) => e && onChange({ ...value, effort: e === "default" ? "" : e })}>
							<ToggleGroupItem value="default" title={sel.agent === "codex" ? "这个模型的默认" : "用 Claude Code 的设置"}>默认</ToggleGroupItem>
							{efforts.map((e) => <ToggleGroupItem key={e} value={e}>{effortLabel(e)}</ToggleGroupItem>)}
						</ToggleGroup>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** 新会话用哪个 agent、哪个模型、多强的思考：两边的模型按 agent 分组列在一个菜单里，选了哪个模型就是哪个 agent。"" 是默认；列表第一次点开才拿 */
export function AgentModelSelect({ value, onChange }: { value: Choice; onChange: (v: Choice) => void }) {
	const [opened, setOpened] = useState(false);
	const [claude, reClaude] = useModels("claude", value.agent === "claude" || opened);
	const [codex, reCodex] = useModels("codex", value.agent === "codex" || opened);
	const list = value.agent === "codex" ? codex : claude;
	const text = `${value.agent === "codex" ? "Codex" : "Claude"} · ${value.model ? nameOf(list, value.model) : "默认"}${value.effort ? ` · ${effortLabel(value.effort)}` : ""}`;
	const open = () => { setOpened(true); reClaude(); reCodex(); };
	return <ModelMenu sections={[{ agent: "claude", title: "Claude Code", list: claude }, { agent: "codex", title: "Codex", list: codex }]} value={value} onChange={onChange} text={text} onOpen={open} />;
}

export function PermissionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	return <OptionMenu title="权限" options={PERMISSIONS} value={value} onChange={onChange} />;
}

/**
 * 下一条用的模型和思考强度。model 是别名或固定的型号，"" 是默认；current 是上一条回复实际用的完整型号，同系列时显示它（Opus 5.5），
 * 手机上只显示系列名
 */
export function ModelSelect({ model, effort, onChange, current, agent = "claude" }: { model: string; effort: string; onChange: (model: string, effort: string) => void; current?: string | null; agent?: Kind }) {
	const [list, refresh] = useModels(agent, true);
	const full = agent === "codex" ? model || current || "默认" : current && (!model || family(current) === model) ? pretty(current) : model ? nameOf(list, model) : "默认";
	const e = effort ? ` · ${effortLabel(effort)}` : "";
	const text = (
		<>
			<span className="md:hidden">{agent === "codex" ? full : full.split(" ")[0]}{e}</span>
			<span className="hidden md:inline">{full}{e}</span>
		</>
	);
	return <ModelMenu sections={[{ agent, list }]} value={{ agent, model, effort }} onChange={(v) => onChange(v.model, v.effort)} current={current} text={text} onOpen={refresh} />;
}

/** 为什么只能分叉（输入框里写的那句）；能继续就是 null */
function noContinue(w: Walk, status: Status): { reason: string; hint: string } | null {
	if (!w.atLatest) return { reason: "在看旧版本", hint: "在看旧版本，发送后从这里分叉" };
	if (status === "terminal") return { reason: "终端中打开", hint: "终端中打开着，发送后分叉" };
	return null;
}

const wan = (n: number) => (n >= 10_000 ? `${Math.round(n / 10_000)} 万` : String(n));

/** 运行中：停止和跑了多久合成一个按钮。在做什么看对话末尾带 ping 点的那一步 */
function RunStatus({ run }: { run: Run }) {
	return (
		<Button variant="ghost" size="xs" className="shrink-0 gap-1 text-muted-foreground" onClick={() => api(`/api/runs/${run.id}/stop`, {}).catch(() => {})} aria-label="停止" title="停止运行">
			<Square className="size-2.5 fill-current" />
			<Elapsed since={Date.parse(run.started)} />
		</Button>
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

/** 这个会话的 agent 有窗口用到 80% 以上：上下文旁边小小一句「5 小时 82%」，平时不显示 */
function QuotaHint({ agent }: { agent: Kind }) {
	const w = nearLimit(useLive().usage, agent);
	if (!w) return null;
	return (
		<span className="shrink-0 px-1 text-2xs whitespace-nowrap text-muted-foreground tabular-nums" title={`${agent === "codex" ? "Codex" : "Claude"} ${w.label}用量 ${pct(w.used)}%${w.resetsAt ? `，${resets(w.resetsAt)}` : ""}`}>
			{w.label} {pct(w.used)}%
		</span>
	);
}

/** 消息开头换成「/名字 」：原来就有一个 /xxx 的话替换掉 */
const withSkill = (text: string, name: string) => `/${name} ${text.replace(/^\/\S+\s*/, "")}`;

/** 「+」：加图片、选 skill（列表在 skills.tsx，点了才加载）。没有 skill（Codex）就直接选图 */
export function AddMenu({ onAdd, onSkill }: { onAdd: (s: Shot[]) => void; onSkill?: () => void }) {
	const file = useRef<HTMLInputElement>(null);
	const pick = () => file.current?.click();
	const button = (
		<Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onSkill ? undefined : pick} aria-label={onSkill ? "加图片、选 skill" : "加图片"} title={onSkill ? "加图片、选 skill" : "加图片"}>
			<Plus className="size-4" />
		</Button>
	);
	return (
		<>
			{onSkill ? (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<DropdownMenuItem onSelect={pick}>
							<ImagePlus />
							图片
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={onSkill}>
							<SquareSlash />
							skill
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			) : (
				button
			)}
			<input
				ref={file}
				type="file"
				accept="image/*"
				multiple
				hidden
				onChange={(e) => {
					if (e.target.files) onAdd(toShots(e.target.files));
					e.target.value = "";
				}}
			/>
		</>
	);
}

/** 发出去之后，输入框里去掉发出去的那段：请求还没回来时接着打的字留着 */
const unsent = (t: string, sent: string) => (t === sent ? "" : t.startsWith(sent) ? t.slice(sent.length).replace(/^\s+/, "") : t);

/** run：这个会话正在跑的那一次。只拿它不拿整个 stream：回复写着的时候每来一段字，输入框不跟着重画 */
export const Composer = memo(function Composer({ project, session, w, status, windows, chosen, chosenEffort, run, agent = "claude" }: { project: string; session: string; w: Walk; status: Status; windows: Record<string, number>; chosen: string | null; chosenEffort: string | null; run: Run | null; agent?: Kind }) {
	const { follow, runs, queue } = useLive();
	const [text, setText] = useDraft(session);
	// 发出去的先记着，真写进会话记录才算数；没发出去的放回输入框
	const track = useOutbox(session, w.path, runs, queue, text, setText);
	const why = noContinue(w, status);
	const busyRun = status === "running" || status === "waiting";
	const mode = why ? "fork" : "resume";
	const [permission, setPermission] = useState("auto");
	const [model, setModel] = useState(() => modelFor(agent, w.path, chosen) ?? "");
	const [effort, setEffort] = useState(chosenEffort ?? "");
	const [busy, setBusy] = useState(false);
	const [skills, setSkills] = useState(false);
	const [shots, setShots] = useState<Shot[]>([]);
	const input = useRef<HTMLTextAreaElement>(null);
	// 换了会话、或者在别处（终端、另一个页面）换了模型：跟着变
	const fallback = modelFor(agent, w.path, chosen) ?? "";
	useEffect(() => setModel(fallback), [session, fallback]);
	useEffect(() => setEffort(chosenEffort ?? ""), [session, chosenEffort]);
	const send = async () => {
		if ((!text.trim() && !shots.length) || busy) return;
		setBusy(true);
		// 请求在路上时还能接着打字、加图：回来之后只拿掉发出去的
		const sent = text;
		const sentShots = shots;
		try {
			// 分叉：在看旧版本就从看到的地方分；否则从最新处（不给分叉点）
			const at = w.atLatest ? null : forkPoint(w.path);
			const images = await Promise.all(sentShots.map(encode));
			const box = track(sent, mode);
			box.sent(await start({ project, session, mode, at, prompt: sent, images, permission, model: model || null, effort: effort || null }, follow));
			setText((t) => unsent(t, sent));
			for (const s of sentShots) URL.revokeObjectURL(s.url);
			setShots((x) => x.filter((s) => !sentShots.includes(s)));
		} catch (e) {
			toast.error(`没发出去：${e instanceof Error ? e.message : String(e)}，消息还在输入框里`);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="bg-background/80 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur md:px-6">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-1 rounded-xl border bg-card p-1.5 shadow-xs transition-colors focus-within:border-ring">
				<AttachStrip shots={shots} onChange={setShots} />
				<Textarea
					value={text}
					ref={input}
					onChange={(e) => {
						// 空输入框里打「/」：弹出 skill 列表
						if (!text && e.target.value === "/") return setSkills(true);
						setText(e.target.value);
					}}
					onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
					onPaste={(e) => {
						const s = toShots(e.clipboardData.files);
						if (s.length) { e.preventDefault(); setShots((x) => [...x, ...s]); }
					}}
					placeholder={why?.hint ?? (busyRun ? "运行中，发送后排队…" : "继续…")}
					className="max-h-48 min-h-9 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<div className="flex items-center gap-1">
					<PermissionSelect value={permission} onChange={setPermission} />
					<ModelSelect model={model} effort={effort} onChange={(m, e) => { setModel(m); setEffort(e); }} current={lastCtx(w.path)?.model} agent={agent} />
					<AddMenu onAdd={(s) => setShots((x) => [...x, ...s])} onSkill={agent === "claude" ? () => setSkills(true) : undefined} />
					<span className="ml-auto" />
					{agent === "claude" && <BackgroundTasks session={session} />}
					{run && <RunStatus run={run} />}
					{/* 手机上运行中地方不够：先不显示用量 */}
					<span className={run ? "hidden md:contents" : "contents"}>
						<QuotaHint agent={agent} />
					</span>
					<ContextUsage path={w.path} windows={windows} model={model} />
					<Button size="icon" className="shrink-0 rounded-lg" disabled={(!text.trim() && !shots.length) || busy} onClick={send} aria-label={why ? "分叉" : "发送"} title={why ? `${why.reason}，发送后分叉` : undefined}>
						{busy ? <Spinner /> : why ? <GitFork className="size-4" /> : <Send className="size-4" />}
					</Button>
				</div>
			</div>
			<SkillPicker
				project={project}
				open={skills}
				onOpenChange={setSkills}
				onPick={(name) => {
					setText((t) => withSkill(t, name));
					setTimeout(() => input.current?.focus(), 0);
				}}
			/>
		</div>
	);
});
