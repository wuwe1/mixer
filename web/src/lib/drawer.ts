// 手机上的侧栏抽屉：位置是一个进度 p（0 关着、1 全开）。
// 拖的时候直接改样式跟着手指（不经过 React，每帧不重画）；松手、点按钮开关时从看到的位置动画到 0 或 1；
// 动画途中再按住，停在看到的位置接着拖。系统开了「减少动态效果」就不播动画、直接到位
let panel: HTMLElement | null = null;
let overlay: HTMLElement | null = null;
let p = 0;
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const clamp = (x: number) => Math.min(1, Math.max(0, x));

function paint(ms: number) {
	if (!panel || !overlay) return;
	const how = ms ? `${ms}ms ${EASE}` : "";
	panel.style.transition = how ? `transform ${how}` : "none";
	overlay.style.transition = how ? `opacity ${how}` : "none";
	panel.style.transform = `translateX(${(p - 1) * 100}%)`;
	overlay.style.opacity = String(p);
	overlay.style.pointerEvents = p > 0 ? "auto" : "none";
	// 关上的动画走完再藏起来（transitionend）；直接到位的马上藏
	if (p > 0 || !ms) panel.style.visibility = overlay.style.visibility = p > 0 ? "visible" : "hidden";
}

/** 抽屉挂上页面时登记；返回撤销 */
export function attach(pa: HTMLElement, ov: HTMLElement) {
	panel = pa;
	overlay = ov;
	const hide = () => { if (p === 0) pa.style.visibility = ov.style.visibility = "hidden"; };
	pa.addEventListener("transitionend", hide);
	paint(0);
	return () => {
		pa.removeEventListener("transitionend", hide);
		if (panel === pa) panel = overlay = null;
	};
}

/** 抽屉多宽：拖的距离换算成进度 */
export const width = () => panel?.getBoundingClientRect().width || 288;

/** 按下时：停在看到的位置（动画途中也是），返回那时的进度 */
export function grab(): number {
	if (!panel) return p;
	const t = getComputedStyle(panel).transform;
	p = clamp(t === "none" ? p : 1 + new DOMMatrix(t).m41 / width());
	paint(0);
	return p;
}

/** 拖动中：放到 x 处，不要动画 */
export function drag(x: number) {
	p = clamp(x);
	paint(0);
}

/** 开到底或关到底：从现在的位置动画过去，剩的距离越短越快 */
export function to(target: 0 | 1) {
	if (!panel || p === target) return;
	const ms = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : Math.round(150 + 150 * Math.abs(target - p));
	p = target;
	paint(ms);
}
