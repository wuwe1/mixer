// 后台任务：Claude 开着的后台命令、Monitor、后台子代理。输入框那一排一个小按钮（蓝色空心圈 + 个数），点开列出每一个：
// 是什么、跑了多久、停止；能看输出的点一下展开最后一段（开着时每 2 秒拿一次）。跑完了 Claude 会被叫醒接着做
import { Activity, Bot, ChevronRight, Radar, Square, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useSidebar } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { api, enc, type Host, type Task } from "@/lib/api";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";
import { Elapsed } from "./message";
import { StatusIcon } from "./side";

const KIND: Record<string, { icon: typeof Bot; label: string }> = {
	local_bash: { icon: SquareTerminal, label: "命令" },
	local_agent: { icon: Bot, label: "子代理" },
	remote_agent: { icon: Bot, label: "远程子代理" },
	monitor: { icon: Radar, label: "Monitor" },
};
const kind = (t: Task) => KIND[t.type] ?? (/monitor/i.test(t.type) ? KIND.monitor : { icon: Activity, label: t.type || "任务" });

const HINT = "跑完了会叫醒 Claude 接着做";

/** 输入框那一排：这个会话有后台任务才出现 */
export function BackgroundTasks({ session }: { session: string }) {
	const { hosts } = useLive();
	const { isMobile } = useSidebar();
	const [open, setOpen] = useState(false);
	const h = hosts.find((x) => x.session === session && x.tasks.length);
	useEffect(() => { if (!h) setOpen(false); }, [h]);
	if (!h) return null;
	const n = h.tasks.length;
	const trigger = (
		<Button variant="ghost" size="sm" className="shrink-0 gap-1 px-1.5 text-muted-foreground" onClick={() => setOpen(true)} aria-label={`${n} 个后台任务`} title={`${n} 个后台任务，${HINT}`}>
			<StatusIcon s="background" />
			<span className="hidden md:inline">后台</span>
			<span className="tabular-nums">{n}</span>
		</Button>
	);
	if (isMobile)
		return (
			<>
				{trigger}
				<Sheet open={open} onOpenChange={setOpen}>
					<SheetContent side="bottom" className="max-h-[85svh] gap-0 pb-[max(1rem,env(safe-area-inset-bottom))]">
						<SheetHeader>
							<SheetTitle>后台任务</SheetTitle>
							<SheetDescription>{HINT}</SheetDescription>
						</SheetHeader>
						<div className="overflow-y-auto px-4">
							<TaskList h={h} />
						</div>
					</SheetContent>
				</Sheet>
			</>
		);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent side="top" align="end" className="max-h-[70svh] w-md overflow-y-auto p-3">
				<div className="flex flex-col gap-0.5 pb-1">
					<span className="text-sm font-medium">后台任务</span>
					<span className="text-xs text-muted-foreground">{HINT}</span>
				</div>
				<TaskList h={h} />
			</PopoverContent>
		</Popover>
	);
}

function TaskList({ h }: { h: Host }) {
	return (
		<div className="flex flex-col divide-y">
			{h.tasks.map((t) => <TaskRow key={t.id} host={h.id} t={t} />)}
		</div>
	);
}

/** 一个后台任务：› 展开输出（有输出文件的才能展开）、类型图标、说明、跑了多久、停止 */
function TaskRow({ host, t }: { host: string; t: Task }) {
	const [open, setOpen] = useState(false);
	const [out, setOut] = useState<{ text: string; cut: boolean } | null>(null);
	const [stopping, setStopping] = useState(false);
	const pre = useRef<HTMLPreElement>(null);
	const k = kind(t);
	useEffect(() => {
		if (!open) return;
		let alive = true;
		const get = () => api<{ text: string; cut: boolean }>(`/api/hosts/${enc(host)}/tasks/${enc(t.id)}/output`).then((o) => { if (alive) setOut(o); }, () => {});
		get();
		const i = setInterval(get, 2000);
		return () => { alive = false; clearInterval(i); };
	}, [open, host, t.id]);
	// 新的输出在最下面：跟着滚到底
	useEffect(() => {
		const el = pre.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [out]);
	const stop = () => {
		setStopping(true);
		api(`/api/hosts/${enc(host)}/tasks/${enc(t.id)}/stop`, {}).catch((e: Error) => { setStopping(false); toast.error(`没停下来：${e.message}`); });
	};
	return (
		<div className="flex flex-col gap-1.5 py-2">
			<div className="flex min-w-0 items-center gap-1.5">
				<button
					type="button"
					disabled={!t.output}
					onClick={() => setOpen((o) => !o)}
					className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-md outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
					title={t.output ? (open ? "收起输出" : "看输出") : undefined}
				>
					<ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", !t.output && "invisible")} />
					<k.icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={k.label} />
					<span className="min-w-0 truncate">{t.description || t.id}</span>
				</button>
				<Elapsed since={Date.parse(t.started)} className="shrink-0 text-2xs text-muted-foreground" />
				<Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" disabled={stopping} onClick={stop} aria-label="停止" title="停止这个后台任务">
					{stopping ? <Spinner /> : <Square className="size-3 fill-current" />}
				</Button>
			</div>
			{open && (
				<pre ref={pre} className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs leading-code break-all whitespace-pre-wrap">
					{out ? `${out.cut ? "…\n" : ""}${out.text || "（还没有输出）"}` : <Spinner className="text-muted-foreground" />}
				</pre>
			)}
		</div>
	);
}
