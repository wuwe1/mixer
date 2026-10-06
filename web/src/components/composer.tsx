// 输入框：只有两种发送方式，继续（续接这个会话），或者分叉（开一个新会话，带着到某一处为止的上下文，原会话不动）。
// Claude 正在 mixer 里运行时继续就排队，这次运行结束后一起发送；在看旧版本、终端中打开，只能分叉。
// 分叉不用另选：从最新处分叉是最后一条回复后面的分叉图标；只能分叉时发送按钮换成分叉的图标。
// 下面一排：权限、模型、「+」（图片、skill）；右边是后台任务、运行中的停止和时长、订阅快用完的窗口、上下文用了多少、发送。
import { Bot, Code, GitFork, Hand, ImagePlus, ListChecks, Plus, Send, Sparkles, Square, SquareSlash } from "lucide-react";
import { Fragment, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, type Node, type Run } from "@/lib/api";
import { type Status, useLive } from "@/lib/live";
import { type Agent as Kind, family, lastCtx, MODELS, modelFor, pretty, windowOf } from "@/lib/model";
import { useDraft, useOutbox } from "@/lib/outbox";
import { forkPoint, type Walk } from "@/lib/thread";
import { nearLimit } from "@/lib/usage";
import { AttachStrip, encode, type Shot, toShots } from "./attach";
import { start } from "./fork-dialog";
import { Elapsed } from "./message";
import { SkillPicker } from "./lazy";
import { BackgroundTasks } from "./tasks";
import { pct, resets } from "./usage";

type Option = { v: string; icon: typeof Send; label: string; desc: string; disabled?: boolean; group?: string };

/** 输入框下面的小选项：平时只是个图标（不带箭头），点开才写每一项是什么意思；给了 text 就显示成文字（模型名）。选项带 group 的按组列，组名代替标题 */
function OptionMenu({ title, options, value, onChange, text, onOpenChange }: { title: string; options: Option[]; value: string; onChange: (v: string) => void; text?: ReactNode; onOpenChange?: (open: boolean) => void }) {
	const cur = options.find((o) => o.v === value) ?? options[0];
	return (
		<DropdownMenu onOpenChange={onOpenChange}>
			<DropdownMenuTrigger asChild>
				{text ? (
					<Button variant="ghost" size="sm" className="px-1.5 text-muted-foreground" aria-label={`${title}：${cur.label}`} title={`${title}：${cur.label}`}>
						<span className="text-2xs">{text}</span>
					</Button>
				) : (
					<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`${title}：${cur.label}`} title={`${title}：${cur.label}`}>
						<cur.icon className="size-4" />
					</Button>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72">
				{!options[0]?.group && <DropdownMenuLabel>{title}</DropdownMenuLabel>}
				<DropdownMenuRadioGroup value={value} onValueChange={onChange}>
					{options.map((o, i) => (
						<Fragment key={o.v}>
							{o.group && o.group !== options[i - 1]?.group && (
								<>
									{i > 0 && <DropdownMenuSeparator />}
									<DropdownMenuLabel>{o.group}</DropdownMenuLabel>
								</>
							)}
							<DropdownMenuRadioItem value={o.v} disabled={o.disabled} className="items-start gap-2.5 py-2">
								<o.icon className="mt-0.5 size-4 text-muted-foreground" />
								<span className="flex flex-col gap-0.5">
									<span className="font-medium">{o.label}</span>
									<span className="text-xs leading-snug text-muted-foreground">{o.desc}</span>
								</span>
							</DropdownMenuRadioItem>
						</Fragment>
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

/** Codex 能用的模型：整个页面拿一次（codex app-server 的 model/list） */
let codexModels: Promise<{ id: string; label: string; isDefault: boolean }[]> | null = null;
function useCodexModels(on: boolean) {
	const [list, setList] = useState<{ id: string; label: string; isDefault: boolean }[]>([]);
	useEffect(() => {
		if (!on) return;
		codexModels ??= api<{ id: string; label: string; isDefault: boolean }[]>("/api/codex/models").catch(() => { codexModels = null; return []; });
		codexModels.then(setList);
	}, [on]);
	return list;
}

/** 新会话用哪个 agent、哪个模型：两边的模型按 agent 分组列在一个菜单里，选了哪个模型就是哪个 agent。"" 是那个 agent 的默认；Codex 的模型第一次点开才拿 */
export function AgentModelSelect({ agent, model, onChange }: { agent: Kind; model: string; onChange: (agent: Kind, model: string) => void }) {
	const [opened, setOpened] = useState(false);
	const codex = useCodexModels(agent === "codex" || opened);
	const def = codex.find((m) => m.isDefault)?.id;
	const options: Option[] = [
		{ v: "claude:", group: "Claude Code", icon: Bot, label: "默认", desc: "用 Claude Code 的设置" },
		...MODELS.map((m) => ({ v: `claude:${m.v}`, group: "Claude Code", icon: Bot, label: m.label, desc: `最新的 ${m.label}` })),
		{ v: "codex:", group: "Codex", icon: Code, label: "默认", desc: def ? `Codex 的默认（${def}）` : "Codex 的默认" },
		...codex.map((m) => ({ v: `codex:${m.id}`, group: "Codex", icon: Code, label: m.label, desc: m.id })),
	];
	const text = `${agent === "codex" ? "Codex" : "Claude"} · ${!model ? "默认" : agent === "codex" ? model : pretty(model)}`;
	const pick = (v: string) => {
		const i = v.indexOf(":");
		onChange(v.slice(0, i) as Kind, v.slice(i + 1));
	};
	return <OptionMenu title="模型" options={options} value={`${agent}:${model}`} onChange={pick} text={text} onOpenChange={(o) => o && setOpened(true)} />;
}

export function PermissionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	return <OptionMenu title="权限" options={PERMISSIONS} value={value} onChange={onChange} />;
}

/**
 * 下一条用的模型。value 是别名，"" 是 Claude Code 的默认；current 是上一条回复实际用的完整型号，同系列时显示它（Opus 5.5），
 * 手机上只显示系列名
 */
export function ModelSelect({ value, onChange, current, agent = "claude" }: { value: string; onChange: (v: string) => void; current?: string | null; agent?: Kind }) {
	const codex = useCodexModels(agent === "codex");
	if (agent === "codex") {
		const def = codex.find((m) => m.isDefault)?.id;
		const opts: Option[] = [
			{ v: "", icon: Bot, label: "默认", desc: def ? `Codex 的默认（${def}）` : "Codex 的默认" },
			...codex.map((m) => ({ v: m.id, icon: Bot, label: m.label, desc: current === m.id ? "现在用的" : m.id })),
		];
		return <OptionMenu title="模型" options={opts} value={value} onChange={onChange} text={value || current || "默认"} />;
	}
	const options: Option[] = [
		{ v: "", icon: Bot, label: "默认", desc: "用 Claude Code 的设置" },
		...MODELS.map((m) => ({ v: m.v as string, icon: Bot, label: m.label, desc: current && family(current) === m.v ? `现在用的是 ${pretty(current)}` : `最新的 ${m.label}` })),
	];
	const full = current && (!value || family(current) === value) ? pretty(current) : value ? pretty(value) : "默认";
	const text = (
		<>
			<span className="md:hidden">{full.split(" ")[0]}</span>
			<span className="hidden md:inline">{full}</span>
		</>
	);
	return <OptionMenu title="模型" options={options} value={value} onChange={onChange} text={text} />;
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
function AddMenu({ onAdd, onSkill }: { onAdd: (s: Shot[]) => void; onSkill?: () => void }) {
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
export const Composer = memo(function Composer({ project, session, w, status, windows, chosen, run, agent = "claude" }: { project: string; session: string; w: Walk; status: Status; windows: Record<string, number>; chosen: string | null; run: Run | null; agent?: Kind }) {
	const { follow, runs, queue } = useLive();
	const [text, setText] = useDraft(session);
	// 发出去的先记着，真写进会话记录才算数；没发出去的放回输入框
	const track = useOutbox(session, w.path, runs, queue, text, setText);
	const why = noContinue(w, status);
	const busyRun = status === "running" || status === "waiting";
	const mode = why ? "fork" : "resume";
	const [permission, setPermission] = useState("auto");
	const [model, setModel] = useState(() => modelFor(agent, w.path, chosen) ?? "");
	const [busy, setBusy] = useState(false);
	const [skills, setSkills] = useState(false);
	const [shots, setShots] = useState<Shot[]>([]);
	const input = useRef<HTMLTextAreaElement>(null);
	// 换了会话、或者在别处（终端、另一个页面）换了模型：跟着变
	const fallback = modelFor(agent, w.path, chosen) ?? "";
	useEffect(() => setModel(fallback), [session, fallback]);
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
			box.sent(await start({ project, session, mode, at, prompt: sent, images, permission, model: model || null }, follow));
			setText((t) => unsent(t, sent));
			for (const s of sentShots) URL.revokeObjectURL(s.url);
			setShots((x) => x.filter((s) => !sentShots.includes(s)));
		} catch (e) {
			// 连不上（断网、服务在重启）浏览器只给一句英文
			const m = e instanceof TypeError ? "连不上 mixer" : e instanceof Error ? e.message : String(e);
			toast.error(`没发出去：${m}，消息还在输入框里`);
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
					<ModelSelect value={model} onChange={setModel} current={lastCtx(w.path)?.model} agent={agent} />
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
