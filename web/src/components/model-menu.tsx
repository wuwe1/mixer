// 输入框底下的权限、模型和思考强度菜单：继续、分叉、新会话三处共用（prompt.tsx 的 PromptBox 里）。
import { Bot, Hand, ListChecks, Send, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@shared/api";
import { family, MODELS, pretty } from "@/lib/model";
import { effortLabel, type ModelInfo } from "@shared/model-info";

/** short：不是默认时按钮上写的字 */
type Option = { v: string; icon: typeof Send; label: string; desc: string; short?: string };

/** 输入框下面的小选项：平时只是个图标（不带箭头），点开才写每一项是什么意思。不是第一项（默认）时图标旁边写上是哪个 */
function OptionMenu({ title, options, value, onChange }: { title: string; options: Option[]; value: string; onChange: (v: string) => void }) {
	const cur = options.find((o) => o.v === value) ?? options[0];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{cur === options[0] ? (
					<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`${title}：${cur.label}`} title={`${title}：${cur.label}`}>
						<cur.icon className="size-4" />
					</Button>
				) : (
					<Button variant="ghost" size="xs" className="px-1.5 text-muted-foreground" aria-label={`${title}：${cur.label}`} title={`${title}：${cur.label}`}>
						<cur.icon />
						{cur.short ?? cur.label}
					</Button>
				)}
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
	{ v: "default", icon: Hand, label: "每次询问", short: "询问", desc: "改文件、跑命令前都请求确认" },
	{ v: "plan", icon: ListChecks, label: "计划模式", short: "计划", desc: "只读不改，先出计划" },
];

/** 能选的模型：整个页面共用一份，菜单打开时超过 1 分钟就重新拿（Claude 出了新模型能马上看到）。拿不到时用 MODELS 顶一下 */
let cached: { at: number; p: Promise<ModelInfo[]> } | null = null;
const FALLBACK: ModelInfo[] = [
	{ id: "", label: "默认", resolved: null, efforts: [], latest: false, isNew: false },
	...MODELS.map((m) => ({ id: m.v as string, label: m.label, resolved: null, efforts: [], latest: true, isNew: false })),
];
function useModels() {
	const [got, setGot] = useState<ModelInfo[] | null>(null);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!cached || Date.now() - cached.at > 60_000) {
			const p = api<ModelInfo[]>("/api/models").catch(() => { cached = null; return []; });
			cached = { at: Date.now(), p };
		}
		let live = true;
		cached.p.then((list) => live && setGot(list));
		return () => { live = false; };
	}, [tick]);
	return [got?.length ? got : FALLBACK, () => setTick((t) => t + 1)] as const;
}

/** 选中的那个；没在列表里（比如上一条回复用的型号）就按默认的算思考强度 */
const entry = (list: ModelInfo[], id: string) => list.find((m) => m.id === id) ?? list[0];

/** 模型的名字：列表里有就用列表的（Opus 5.5），没有就从型号拼 */
const nameOf = (list: ModelInfo[], id: string) => list.find((m) => m.id === id && m.id)?.label ?? pretty(id);

export type Choice = { model: string; effort: string };

/**
 * 下一条用的模型和思考强度，一个菜单：上面是默认和各系列最新的（别名，出了新版自动跟上），再是固定的版本（一行一个），最下面一排思考强度
 * （只列选中的模型支持的；换了不支持的模型就回到默认）。model 是别名或固定的型号，"" 是默认；
 * current 是上一条回复实际用的完整型号（新会话没有），同系列时显示它（Opus 5.5），手机上只显示系列名
 */
export function ModelSelect({ value, onChange, current }: { value: Choice; onChange: (v: Choice) => void; current?: string | null }) {
	const [list, refresh] = useModels();
	const efforts = entry(list, value.model).efforts;
	const pick = (model: string) => onChange({ model, effort: entry(list, model).efforts.includes(value.effort) ? value.effort : "" });
	const desc = (m: ModelInfo) => {
		if (!m.id) return "用 Claude Code 的设置";
		if (current && current === m.resolved) return `现在用的是 ${pretty(current)}`;
		return m.latest ? `最新的 ${m.label.split(" ")[0]}，出了新版自动换` : m.label;
	};
	const row = (m: ModelInfo, two: boolean) => (
		<DropdownMenuRadioItem key={m.id} value={m.id} className={two ? "items-start gap-2.5 py-2" : "gap-2.5"}>
			<Bot className={`${two ? "mt-0.5 " : ""}size-4 text-muted-foreground`} />
			<span className="flex flex-col gap-0.5">
				<span className="flex items-center gap-1.5 font-medium">
					{m.label}
					{m.isNew && <Badge variant="secondary">新</Badge>}
				</span>
				{two && <span className="text-xs leading-snug text-muted-foreground">{desc(m)}</span>}
			</span>
		</DropdownMenuRadioItem>
	);
	// 固定版本一行一个，收在下面
	const pinned = list.filter((m) => m.id && !m.latest);
	const full = current && (!value.model || family(current) === value.model) ? pretty(current) : value.model ? nameOf(list, value.model) : "默认";
	const e = value.effort ? ` · ${effortLabel(value.effort)}` : "";
	return (
		<DropdownMenu onOpenChange={(o) => o && refresh()}>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="xs" className="px-1.5 text-muted-foreground" aria-label="模型" title="模型、思考强度">
					<span className="md:hidden">{full.split(" ")[0]}{e}</span>
					<span className="hidden md:inline">{full}{e}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-h-(--radix-dropdown-menu-content-available-height) w-72 overflow-y-auto">
				<DropdownMenuRadioGroup value={value.model} onValueChange={pick}>
					<DropdownMenuLabel>模型</DropdownMenuLabel>
					{list.filter((m) => !pinned.includes(m)).map((m) => row(m, true))}
					{pinned.length > 0 && <DropdownMenuLabel className="text-2xs">固定版本</DropdownMenuLabel>}
					{pinned.map((m) => row(m, false))}
				</DropdownMenuRadioGroup>
				{efforts.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>思考强度</DropdownMenuLabel>
						<ToggleGroup type="single" size="sm" spacing={1} className="flex-wrap px-1.5 pb-1.5" value={value.effort || "default"} onValueChange={(v) => v && onChange({ ...value, effort: v === "default" ? "" : v })}>
							<ToggleGroupItem value="default" title="用 Claude Code 的设置">默认</ToggleGroupItem>
							{efforts.map((x) => <ToggleGroupItem key={x} value={x}>{effortLabel(x)}</ToggleGroupItem>)}
						</ToggleGroup>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function PermissionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	return <OptionMenu title="权限" options={PERMISSIONS} value={value} onChange={onChange} />;
}
