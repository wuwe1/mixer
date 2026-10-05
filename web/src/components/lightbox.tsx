// 图片：一排缩略图，点了在当前页面放大看（lightbox）。点空白处、Esc 关；多张的能左右切换（按钮、方向键）。
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { cn } from "@/lib/utils";

const round = "flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20";

export function Images({ srcs, className, imgClassName }: { srcs: string[]; className?: string; imgClassName?: string }) {
	const [i, setI] = useState<number | null>(null);
	const n = srcs.length;
	const step = (d: number) => setI((x) => (x === null ? x : (x + d + n) % n));
	const stop = (e: React.MouseEvent) => e.stopPropagation();
	return (
		<>
			<div className={cn("flex flex-wrap gap-2", className)}>
				{srcs.map((src, k) => (
					<button key={src} type="button" onClick={() => setI(k)} className="max-w-full cursor-zoom-in" aria-label="放大看">
						<img src={src} alt="" loading="lazy" className={cn("max-h-48 max-w-full rounded-lg border object-contain", imgClassName)} />
					</button>
				))}
			</div>
			<Dialog.Root open={i !== null} onOpenChange={(o) => !o && setI(null)}>
				<Dialog.Portal>
					<Dialog.Overlay className="fixed inset-0 z-50 bg-black/90 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
					<Dialog.Content
						aria-describedby={undefined}
						onClick={() => setI(null)}
						onKeyDown={(e) => { if (e.key === "ArrowLeft") step(-1); if (e.key === "ArrowRight") step(1); }}
						className="fixed inset-0 z-50 flex items-center justify-center px-4 pt-[calc(4rem+env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] outline-none sm:px-16"
					>
						<Dialog.Title className="sr-only">图片</Dialog.Title>
						{i !== null && <img src={srcs[i]} alt="" className="max-h-full max-w-full rounded-md object-contain shadow-2xl" />}
						<div className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-3 flex items-center gap-2" onClick={stop}>
							{n > 1 && i !== null && <span className="px-2 text-sm text-white/70 tabular-nums">{i + 1} / {n}</span>}
							{i !== null && (
								<a href={srcs[i]} target="_blank" rel="noreferrer" className={round} aria-label="打开原图" title="打开原图">
									<ExternalLink className="size-4" />
								</a>
							)}
							<Dialog.Close className={round} aria-label="关闭">
								<X className="size-5" />
							</Dialog.Close>
						</div>
						{n > 1 && (
							<>
								<button type="button" onClick={(e) => { stop(e); step(-1); }} className={cn(round, "absolute top-1/2 left-3 -translate-y-1/2")} aria-label="上一张">
									<ChevronLeft className="size-5" />
								</button>
								<button type="button" onClick={(e) => { stop(e); step(1); }} className={cn(round, "absolute top-1/2 right-3 -translate-y-1/2")} aria-label="下一张">
									<ChevronRight className="size-5" />
								</button>
							</>
						)}
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>
		</>
	);
}
