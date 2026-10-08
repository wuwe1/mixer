// 会话右边的面板：目录（你的消息）、文件、改动（默认只看这个会话改过的）。宽屏常开在右边；窄屏是从右边拉出来的整屏一页，往左滑打开、往右滑关上。
// 顶栏只有一个开关（app.tsx），三个 tab 在面板顶上，写字不用图标；开的是这台设备上次看的那个 tab。
import { ChevronLeft, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import * as drawer from "@/lib/drawer";
import { go, lastPanel, openPanel, type Panel, panelOf, type Route, useWide } from "@/lib/route";
import type { User } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { Drawer } from "./drawer";
import { Changes, Files } from "./lazy";

const PANELS: { v: Panel; label: string }[] = [
	{ v: "outline", label: "目录" },
	{ v: "files", label: "文件" },
	{ v: "changes", label: "改动" },
];

type Counts = Partial<Record<Panel, { n: number; hint: string }>>;

/** 面板顶上的三个 tab：目录带你的消息条数，改动带这个会话改过几个文件 */
function PanelTabs({ panel, counts }: { panel: Panel; counts: Counts }) {
	return (
		<ToggleGroup type="single" size="sm" value={panel} onValueChange={(v) => v && openPanel(v as Panel)}>
			{PANELS.map(({ v, label }) => {
				const c = counts[v];
				return (
					<ToggleGroupItem key={v} value={v} className="gap-1 px-2.5 text-muted-foreground aria-checked:bg-muted aria-checked:text-foreground" title={c?.hint}>
						{label}
						{!!c?.n && <span className="text-muted-foreground tabular-nums">{c.n}</span>}
					</ToggleGroupItem>
				);
			})}
		</ToggleGroup>
	);
}

/** prompts：这条路上你的消息（目录）；touched：这个会话改过的文件（仓库里的相对路径）；onJump：目录里点了一条，对话滚过去 */
export function SessionPanel({ project, r, prompts, touched, onJump }: { project: string; r: Route; prompts: User[]; touched: string[]; onJump: (uuid: string) => void }) {
	const wide = useWide();
	// 窄屏：拖开时先画上次看的 tab（peek），关到底、藏起来之后才卸掉里面的东西
	const narrow = wide ? null : panelOf(r, wide);
	const [peek, setPeek] = useState<Panel | null>(null);
	useEffect(() => { if (narrow) setPeek(narrow); }, [narrow]);
	const onStart = useCallback(() => setPeek(lastPanel()), []);
	const setOpen = useCallback((o: boolean) => (o ? openPanel(lastPanel()) : go({ panel: "none" })), []);

	const panel = wide ? panelOf(r, wide) : (narrow ?? peek);
	const jump = (uuid: string) => {
		if (!wide) go({ panel: "none" });
		onJump(uuid);
	};
	const body =
		panel === "outline" ? (
			<ScrollArea className="min-h-0 flex-1">
				<nav className="flex flex-col gap-0.5 p-2">
					{prompts.map((p, i) => (
						<button key={p.uuid} type="button" onClick={() => jump(p.uuid)} className="flex gap-2.5 rounded-md px-2 py-1.5 text-left text-md transition-colors hover:bg-accent">
							<span className="w-5 shrink-0 pt-px text-right text-2xs text-muted-foreground tabular-nums">{i + 1}</span>
							<span className="line-clamp-2 min-w-0 flex-1 leading-snug">{p.text || "（图片）"}</span>
						</button>
					))}
				</nav>
			</ScrollArea>
		) : panel === "files" ? (
			<Files project={project} file={r.file} view={r.view} />
		) : panel === "changes" ? (
			<Changes project={project} touched={touched} />
		) : null;
	const counts: Counts = { outline: { n: prompts.length, hint: `你的 ${prompts.length} 条消息` }, changes: { n: touched.length, hint: `这个会话改过 ${touched.length} 个文件` } };

	if (wide)
		return (
			panel && (
				<aside className={cn("flex shrink-0 flex-col border-l", panel === "outline" ? "w-72" : "w-[min(44rem,45vw)]")}>
					<div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-1.5">
						<PanelTabs panel={panel} counts={counts} />
						<Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => go({ panel: "none" })} aria-label="关掉面板">
							<X className="size-3.5" />
						</Button>
					</div>
					{body}
				</aside>
			)
		);
	// 窄屏的面板是从右边拉出来的整屏一页：左上角回到对话，旁边直接切目录 / 文件 / 改动；上下让开刘海和 Home 条
	return (
		<Drawer d={drawer.panel} open={!!narrow} onOpenChange={setOpen} onStart={onStart} onHidden={() => setPeek(null)} label="目录、文件、改动" className="inset-0 bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
			<div className="flex shrink-0 items-center gap-1 border-b p-1.5 pr-2">
				<Button variant="ghost" size="icon" onClick={() => go({ panel: "none" })} aria-label="回到对话">
					<ChevronLeft className="size-4" />
				</Button>
				<span className="ml-auto">
					<PanelTabs panel={panel ?? lastPanel()} counts={counts} />
				</span>
			</div>
			{body}
		</Drawer>
	);
}
