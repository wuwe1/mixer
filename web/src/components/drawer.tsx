// 手机上的抽屉（左边的侧栏、右边的面板）：一直挂在页面上，位置由 lib/drawer 管（拖的时候跟手）。
// 不用 Sheet：它关着时会卸掉，拖的时候没东西可动；强行挂着又会把整页的滚动、点击锁住。
// 横着滑开关的手势（useSwipe）也在这里：只在手机上挂这个组件，挂着就接手势（关着时也接，才拉得开）
import { type ComponentProps, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import * as drawer from "@/lib/drawer";
import { cn } from "@/lib/utils";

/** onHidden：关到底、藏起来了，里面的东西可以卸了；onStart：从关着开始拖开（先把里面画上） */
export function Drawer({ d, open, onOpenChange, label, onHidden, onStart, className, children, ...props }: Omit<ComponentProps<"div">, "role"> & {
	d: drawer.Drawer;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	label: string;
	onHidden?: () => void;
	onStart?: () => void;
}) {
	const el = useRef<HTMLDivElement>(null);
	const ov = useRef<HTMLDivElement>(null);
	const hidden = useRef(onHidden);
	hidden.current = onHidden;
	const change = useRef(onOpenChange);
	change.current = onOpenChange;
	useLayoutEffect(() => (el.current && ov.current ? d.attach(el.current, ov.current, () => hidden.current?.()) : undefined), [d]);
	useEffect(() => d.to(open ? 1 : 0), [d, open]);
	useEffect(() => {
		if (!open) return;
		const esc = (e: KeyboardEvent) => { if (e.key === "Escape") change.current(false); };
		document.addEventListener("keydown", esc);
		return () => document.removeEventListener("keydown", esc);
	}, [open]);
	drawer.useSwipe(d, { open, setOpen: onOpenChange, onStart });
	return createPortal(
		<>
			<div ref={ov} aria-hidden className="fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs" onClick={() => change.current(false)} />
			<div ref={el} role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label={label} data-drawer={d.side} className={cn("fixed z-50 flex flex-col shadow-lg", className)} {...props}>
				{children}
			</div>
		</>,
		document.body,
	);
}
