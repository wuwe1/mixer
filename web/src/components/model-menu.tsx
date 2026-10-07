// 输入框底下的权限、模型和思考强度菜单：继续、分叉、新会话三处共用（prompt.tsx 的 PromptBox 里）。
import { Bot, Code, Hand, ListChecks, Send, Sparkles } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@shared/api";
import { type Kind, family, MODELS, pretty } from "@/lib/model";
import { effortLabel, type ModelInfo } from "@shared/model-info";

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
				<Button variant="ghost" size="xs" className="px-1.5 text-muted-foreground" aria-label="模型" title="模型、思考强度">
					{text}
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
