// 手机上的抽屉：左边的侧栏、右边的面板（目录、文件、改动）。位置是一个进度 p（0 关着、1 全开）。
// 拖的时候直接改样式跟着手指（不经过 React，每帧不重画）；松手、点按钮开关时从看到的位置动画到 0 或 1；
// 动画途中再按住，停在看到的位置接着拖。系统开了「减少动态效果」就不播动画、直接到位
import { useEffect } from "react";

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const clamp = (x: number) => Math.min(1, Math.max(0, x));

export type Drawer = ReturnType<typeof make>;

function make(side: "left" | "right") {
	let panel: HTMLElement | null = null;
	let overlay: HTMLElement | null = null;
	let hidden: (() => void) | undefined;
	let p = 0;
	// 关着时在屏幕外：左边的往左藏、右边的往右藏
	const off = side === "left" ? -1 : 1;

	function paint(ms: number) {
		if (!panel || !overlay) return;
		const how = ms ? `${ms}ms ${EASE}` : "";
		panel.style.transition = how ? `transform ${how}` : "none";
		overlay.style.transition = how ? `opacity ${how}` : "none";
		panel.style.transform = `translateX(${(1 - p) * off * 100}%)`;
		overlay.style.opacity = String(p);
		overlay.style.pointerEvents = p > 0 ? "auto" : "none";
		// 关上的动画走完再藏起来（transitionend）；直接到位的马上藏
		if (p > 0 || !ms) panel.style.visibility = overlay.style.visibility = p > 0 ? "visible" : "hidden";
	}

	return {
		side,
		/** 抽屉挂上页面时登记；onHidden：关到底、藏起来之后（里面的东西可以卸了）。返回撤销 */
		attach(pa: HTMLElement, ov: HTMLElement, onHidden?: () => void) {
			panel = pa;
			overlay = ov;
			hidden = onHidden;
			const hide = (e: TransitionEvent) => {
				if (e.target !== pa || p !== 0) return;
				pa.style.visibility = ov.style.visibility = "hidden";
				hidden?.();
			};
			pa.addEventListener("transitionend", hide);
			paint(0);
			return () => {
				pa.removeEventListener("transitionend", hide);
				if (panel === pa) panel = overlay = null;
			};
		},
		/** 抽屉多宽：拖的距离换算成进度 */
		width: () => panel?.getBoundingClientRect().width || 288,
		/** 按下时：停在看到的位置（动画途中也是），返回那时的进度 */
		grab(): number {
			if (!panel) return p;
			const t = getComputedStyle(panel).transform;
			p = clamp(t === "none" ? p : 1 - (off * new DOMMatrix(t).m41) / this.width());
			paint(0);
			return p;
		},
		/** 拖动中：放到 x 处，不要动画 */
		drag(x: number) {
			p = clamp(x);
			paint(0);
		},
		/** 开到底或关到底：从现在的位置动画过去，剩的距离越短越快 */
		to(target: 0 | 1) {
			if (!panel || p === target) return;
			const ms = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : Math.round(150 + 150 * Math.abs(target - p));
			p = target;
			paint(ms);
			if (!target && !ms) hidden?.();
		},
	};
}

export const sidebar = make("left");
export const panel = make("right");

/**
 * 横着滑开关抽屉：左边的往右滑打开、往左滑关上；右边的反过来。
 * iOS 从屏幕最左边往右滑是「返回上一页」（有前进的页时最右边往左是「前进」），Safari 里和加到主屏幕的 app 里都有，滑快了系统会抢先：
 * - Safari 里离那条边 EDGE 以内起手的不管，留给系统
 * - 主屏幕 app 里没有地址栏、用不着它：这一条里一按下就拦掉，系统就不返回了，从边上滑也能开。
 *   拦了 touchstart 浏览器就不再发 click，手指没动的点按自己补一个
 * 手指一动就定方向：横着的（而且是要开 / 关的方向）就拦下这次滑动，底下的内容不跟着上下滚；竖着的就放手，照常滚。
 * 开着别的对话框、菜单时不管（另一边的抽屉开着也是 role="dialog"）；按在能往那个方向滚的代码、表格上，是在滚它
 */
const EDGE = 24;
/** 松手时速度超过它（px/ms）就算甩：按甩的方向开或关 */
const FLING = 0.5;

export function useSwipe(d: Drawer, { on, open, setOpen, onStart }: { on: boolean; open: boolean; setOpen: (open: boolean) => void; onStart?: () => void }) {
	useEffect(() => {
		if (!on) return;
		const standalone = (navigator as { standalone?: boolean }).standalone || matchMedia("(display-mode: standalone)").matches;
		// 往哪边滑是打开：左边的抽屉往右（+1），右边的往左（-1）
		const opening = d.side === "left" ? 1 : -1;
		// from：按下时抽屉开到哪（动画途中按住的，停在看到的位置）；pts：最近的手指位置，松手时算速度
		let g: { x: number; y: number; dir: "h" | null; track: boolean; tap: Element | null; from: number; w: number; pts: [number, number][] } | null = null;
		/** 没拖成（竖着滑、反方向、取消）：按下时停住的动画接着走完 */
		const settle = () => d.to(open ? 1 : 0);
		/** el 能不能顺着手指往 sign 那边滑的方向滚（手指往右滑，内容往左滚回去） */
		const scrolls = (el: Element, sign: number) => {
			if (sign > 0) return el.scrollLeft > 0;
			if (el.scrollWidth - el.clientWidth - el.scrollLeft < 1) return false;
			const o = getComputedStyle(el).overflowX;
			return o === "auto" || o === "scroll";
		};
		const down = (e: TouchEvent) => {
			g = null;
			if (e.touches.length !== 1) return;
			// 长按出来的菜单、要确认的对话框开着时也不管
			if (document.querySelector(`[role="dialog"]:not([data-drawer="${d.side}"]), [role="menu"], [role="alertdialog"]`)) return;
			const t = e.touches[0];
			const edge = d.side === "left" ? t.clientX < EDGE : t.clientX > innerWidth - EDGE;
			let tap: Element | null = null;
			if (edge && standalone && e.cancelable) {
				e.preventDefault();
				tap = e.target as Element;
			}
			let track = open || standalone || !edge;
			const sign = open ? -opening : opening;
			if (track) for (let el = e.target as Element | null; el; el = el.parentElement) if (scrolls(el, sign)) track = false;
			g = { x: t.clientX, y: t.clientY, dir: null, track, tap, from: track ? d.grab() : 0, w: d.width(), pts: [[e.timeStamp, t.clientX]] };
		};
		const move = (e: TouchEvent) => {
			if (!g?.track) return;
			const t = e.touches[0];
			const dx = t.clientX - g.x;
			const dy = t.clientY - g.y;
			if (!g.dir) {
				// 按住不动到菜单出来（长按）再挪手指：是在菜单上，不是开关抽屉
				if (document.querySelector('[role="menu"]')) {
					g.track = false;
					return settle();
				}
				if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
				// 竖着为主，或者横着但不是要的方向：不管这次了
				if (Math.abs(dy) >= Math.abs(dx) || (dx * opening > 0) === open) {
					g.track = false;
					return settle();
				}
				g.dir = "h";
				if (!open) onStart?.();
			}
			if (e.cancelable) e.preventDefault();
			// 跟手：抽屉的边贴着手指走
			d.drag(g.from + (dx * opening) / g.w);
			g.pts.push([e.timeStamp, t.clientX]);
			if (g.pts.length > 8) g.pts.shift();
		};
		const up = (e: TouchEvent) => {
			if (!g) return;
			const t = e.changedTouches[0];
			const dx = t.clientX - g.x;
			const dy = t.clientY - g.y;
			const { dir, tap, track, from, w, pts } = g;
			g = null;
			if (tap && !dir && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
				(tap.closest("input, textarea, select, [contenteditable]") as HTMLElement | null)?.focus();
				tap.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
			}
			if (dir) {
				// 甩得够快就按甩的方向，不然看拉开了没有一半
				const [t0, x0] = pts.find(([at]) => e.timeStamp - at <= 100) ?? pts[pts.length - 1];
				const v = e.timeStamp > t0 ? ((t.clientX - x0) * opening) / (e.timeStamp - t0) : 0;
				const next = v > FLING ? true : v < -FLING ? false : from + (dx * opening) / w > 0.5;
				d.to(next ? 1 : 0);
				if (next !== open) setOpen(next);
			} else if (track) settle();
		};
		const cancel = () => {
			if (g?.track) settle();
			g = null;
		};
		document.addEventListener("touchstart", down, { passive: false });
		document.addEventListener("touchmove", move, { passive: false });
		document.addEventListener("touchend", up, { passive: true });
		document.addEventListener("touchcancel", cancel, { passive: true });
		return () => {
			document.removeEventListener("touchstart", down);
			document.removeEventListener("touchmove", move);
			document.removeEventListener("touchend", up);
			document.removeEventListener("touchcancel", cancel);
		};
	}, [d, on, open, setOpen, onStart]);
}
