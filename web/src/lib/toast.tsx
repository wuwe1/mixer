// 提示：顶栏下面浮出一条（不挡顶栏，页面也不跳），几秒后收回去（不用 sonner）。同时只有一条，新的换掉旧的。
// toast("已移出工作区", { action: { label: "撤销", onClick } })、toast.error("…")。
// 出错的多留一会儿、字是红的；duration: Infinity 的一直留着（「有新版本 · 刷新」），点 × 收起
import { X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Opts = { action?: { label: string; onClick: () => void }; duration?: number };
type Item = Opts & { id: number; text: string; error: boolean };

let current: Item | null = null;
let seq = 0;
const subs = new Set<() => void>();
const set = (x: Item | null) => {
	current = x;
	for (const f of subs) f();
};

function show(text: string, o: Opts = {}, error = false) {
	set({ ...o, id: ++seq, text, error });
}

export const toast = Object.assign((text: string, o?: Opts) => show(text, o), {
	error: (text: string, o?: Opts) => show(text, o, true),
});

/** 放在页面最外层一次 */
export function Toaster() {
	const t = useSyncExternalStore(
		(f) => { subs.add(f); return () => { subs.delete(f); }; },
		() => current,
	);
	useEffect(() => {
		if (!t) return;
		const ms = t.duration ?? (t.error ? 6000 : t.action ? 5000 : 3000);
		if (!Number.isFinite(ms)) return;
		const timer = setTimeout(() => { if (current?.id === t.id) set(null); }, ms);
		return () => clearTimeout(timer);
	}, [t]);
	if (!t) return null;
	return (
		<div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-3 top-[calc(env(safe-area-inset-top)+3.5rem)] z-100 flex justify-center">
			<div key={t.id} className="pointer-events-auto flex min-h-11 w-full max-w-md items-center gap-2 rounded-lg border bg-background py-1 pr-1 pl-3 shadow-md animate-in fade-in slide-in-from-top-2">
				<span className={cn("line-clamp-2 min-w-0 flex-1 text-sm", t.error && "text-destructive")} title={t.text}>{t.text}</span>
				{t.action && (
					<Button size="sm" onClick={() => { set(null); t.action?.onClick(); }}>
						{t.action.label}
					</Button>
				)}
				<Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => set(null)} aria-label="关掉">
					<X className="size-4" />
				</Button>
			</div>
		</div>
	);
}
