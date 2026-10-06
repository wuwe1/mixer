// 数组上的算法一步一步走：一帧是一个状态（格子、指针、盯住的、排除的、这一步的说明），没写格子的帧沿用上一帧的。
import type { Spec } from "@/lib/visual";
import { cn } from "@/lib/utils";
import { Controls, usePlayer } from "./layout";

export function ArrayView({ spec }: { spec: Spec<"ArrayViz"> }) {
	const p = usePlayer(spec.frames.length);
	const f = spec.frames[p.at];
	if (!f) return null;
	let cells = f.cells;
	for (let i = p.at; !cells && i >= 0; i--) cells = spec.frames[i].cells;
	cells ??= [];
	const hi = new Set(f.highlight ?? []);
	const dim = new Set(f.dim ?? []);
	// 指针按下标归到格子底下，同一格的叠起来
	const at = new Map<number, string[]>();
	for (const [name, i] of Object.entries(f.pointers ?? {})) at.set(i, [...(at.get(i) ?? []), name]);
	const outside = [...at.keys()].filter((i) => i < 0 || i >= (cells?.length ?? 0));
	return (
		<figure className="min-w-0 rounded-lg border bg-card p-3">
			<div className="overflow-x-auto pb-1">
				<div className="mx-auto flex w-max gap-1">
					{cells.map((v, i) => (
						<div key={i} className="flex w-10 flex-col items-center gap-0.5">
							<div className={cn("flex h-10 w-10 items-center justify-center rounded-md border font-mono text-md tabular-nums transition-colors", hi.has(i) && "border-foreground bg-accent font-semibold", dim.has(i) && "opacity-35")}>
								{v ?? ""}
							</div>
							<div className="text-2xs tabular-nums text-muted-foreground">{i}</div>
							{at.get(i)?.map((n) => <div key={n} className="font-mono text-2xs font-medium leading-none">↑{n}</div>)}
						</div>
					))}
				</div>
			</div>
			{!!outside.length && (
				<div className="mt-1 text-2xs text-muted-foreground">
					{outside.map((i) => `${at.get(i)?.join("、")} = ${i}（出界）`).join("；")}
				</div>
			)}
			<div className="mt-2 min-h-5 text-md">{f.note}</div>
			<div className="mt-2">
				<Controls p={p} />
			</div>
		</figure>
	);
}
