// 排版：并排、卡片、切换、逐帧翻（Stepper）。
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Spec } from "@shared/visual";
import { Frame, Kids, Node } from "./index";

const COLS = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" } as const;

export function GridView({ spec }: { spec: Spec<"Grid"> }) {
	const n = (spec.columns ?? 2) as keyof typeof COLS;
	return (
		<div className={`grid grid-cols-1 gap-3 ${COLS[n] ?? COLS[2]}`}>
			{spec.children.map((v, i) => <Node key={i} v={v} />)}
		</div>
	);
}

export function CardView({ spec }: { spec: Spec<"Card"> }) {
	return (
		<Frame title={spec.title}>
			<Kids list={spec.children} />
		</Frame>
	);
}

export function TabsView({ spec }: { spec: Spec<"Tabs"> }) {
	if (!spec.tabs.length) return null;
	return (
		<Tabs defaultValue="0" className="min-w-0">
			<TabsList className="max-w-full overflow-x-auto">
				{spec.tabs.map((t, i) => <TabsTrigger key={i} value={String(i)}>{t.label}</TabsTrigger>)}
			</TabsList>
			{spec.tabs.map((t, i) => (
				<TabsContent key={i} value={String(i)} className="mt-2">
					<Kids list={t.children} />
				</TabsContent>
			))}
		</Tabs>
	);
}

export function StepperView({ spec }: { spec: Spec<"Stepper"> }) {
	const p = usePlayer(spec.frames.length);
	const f = spec.frames[p.at];
	if (!f) return null;
	return (
		<Frame>
			<div className="flex flex-col gap-3">
				{f.title && <div className="text-md font-medium">{f.title}</div>}
				<Kids list={f.children} />
				<Controls p={p} />
			</div>
		</Frame>
	);
}

/** 第几帧、在不在自动播；帧数变多（还在写）时停在原处 */
function usePlayer(n: number) {
	const [at, setAt] = useState(0);
	const [playing, setPlaying] = useState(false);
	const last = Math.max(0, n - 1);
	useEffect(() => {
		if (!playing) return;
		if (at >= last) { setPlaying(false); return; }
		const t = setTimeout(() => setAt((i) => Math.min(i + 1, last)), 1600);
		return () => clearTimeout(t);
	}, [playing, at, last]);
	return {
		at: Math.min(at, last), n, playing,
		go: (i: number) => { setPlaying(false); setAt(Math.max(0, Math.min(i, last))); },
		// 播到头了再点播放：从头来
		toggle: () => { if (!playing && at >= last) setAt(0); setPlaying(!playing); },
	};
}

/** 播放条：上一步、播放 / 暂停、下一步、第几步，下面一排小点能直接点到某一步 */
function Controls({ p }: { p: ReturnType<typeof usePlayer> }) {
	if (p.n < 2) return null;
	return (
		<div className="flex flex-wrap items-center gap-1 border-t pt-2">
			<Button variant="ghost" size="icon-xs" aria-label="上一步" disabled={p.at === 0} onClick={() => p.go(p.at - 1)}><ChevronLeft /></Button>
			<Button variant="ghost" size="icon-xs" aria-label={p.playing ? "暂停" : "播放"} onClick={p.toggle}>{p.playing ? <Pause /> : <Play />}</Button>
			<Button variant="ghost" size="icon-xs" aria-label="下一步" disabled={p.at >= p.n - 1} onClick={() => p.go(p.at + 1)}><ChevronRight /></Button>
			<span className="px-1 text-2xs tabular-nums text-muted-foreground">{p.at + 1} / {p.n}</span>
			<div className="flex flex-1 items-center gap-1 px-1">
				{Array.from({ length: p.n }, (_, i) => (
					<button key={i} type="button" aria-label={`第 ${i + 1} 步`} onClick={() => p.go(i)} className="flex h-6 flex-1 items-center">
						<span className={`h-1 w-full rounded-full ${i <= p.at ? "bg-foreground" : "bg-muted"}`} />
					</button>
				))}
			</div>
		</div>
	);
}
