// 会话页的滚动：贴底（新内容长出来跟着滚），和记下看到哪儿（切走再切回来放回原处）。
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

/** 离底部这么近算在底部 */
const NEAR = 48;

/**
 * 贴底：停在底部附近时，新内容长出来就跟着滚到底；往上翻离开了就不跟，滚回底部又贴上。
 * 手指按着的时候不动它，免得和手抢。离开底部之后有了新内容，「↓」上带个蓝点（没看过）。
 * failed：出错时滚动的那一层卸掉了，拉到了再挂上，靠它重新挂上监听
 */
export function useStick(scroller: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>, failed: boolean) {
	const stick = useRef(true);
	const touching = useRef(false);
	const [away, setAway] = useState(false);
	const [unseen, setUnseen] = useState(false);
	const toBottom = useCallback((smooth = false) => {
		const el = scroller.current;
		if (!el) return;
		stick.current = true;
		setAway(false);
		setUnseen(false);
		el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
	}, [scroller]);
	useEffect(() => {
		const el = scroller.current;
		const inner = content.current;
		if (!el || !inner) return;
		// 看得见的区域下面还有多高：只有它变高了才算有新内容（往上接更早的对话不算）
		const below = () => el.scrollHeight - el.scrollTop - el.clientHeight;
		let last = below();
		const onScroll = () => {
			last = below();
			const near = last < NEAR;
			stick.current = near;
			setAway(!near);
			if (near) setUnseen(false);
		};
		const follow = () => { if (stick.current && !touching.current) el.scrollTop = el.scrollHeight; };
		const grown = new ResizeObserver(() => {
			if (stick.current) return follow();
			const b = below();
			if (b > last + 1) setUnseen(true);
			last = b;
		});
		// 输入框变高、键盘弹起，看得见的区域变小了：贴着的也要跟着
		const resized = new ResizeObserver(follow);
		grown.observe(inner);
		resized.observe(el);
		const down = () => { touching.current = true; };
		const up = () => { touching.current = false; };
		el.addEventListener("scroll", onScroll, { passive: true });
		el.addEventListener("touchstart", down, { passive: true });
		el.addEventListener("touchend", up, { passive: true });
		el.addEventListener("touchcancel", up, { passive: true });
		return () => {
			grown.disconnect();
			resized.disconnect();
			el.removeEventListener("scroll", onScroll);
			el.removeEventListener("touchstart", down);
			el.removeEventListener("touchend", up);
			el.removeEventListener("touchcancel", up);
		};
	}, [scroller, content, failed]);
	return { away, unseen, toBottom };
}

/** 离开时看到哪儿：最上面那条（id 是 n-<uuid>）和它的顶边离滚动区顶部多远；贴在底部是 null */
type Spot = { uuid: string; offset: number } | null;

/** 每个会话看到哪儿，只在内存里，留最近的 KEEP 个 */
const KEEP = 24;
const spots = new Map<string, Spot>();

/** 上次离开时看到哪儿；没来过是 undefined */
export const spotOf = (key: string) => spots.get(key);

/** 记下看到哪儿：停下来 0.15 秒再记。failed 和 useStick 的一样 */
export function useSpot(key: string, scroller: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>, failed: boolean) {
	useEffect(() => {
		const el = scroller.current;
		const inner = content.current;
		if (!el || !inner) return;
		const put = (s: Spot) => {
			spots.delete(key);
			spots.set(key, s);
			for (const k of spots.keys()) {
				if (spots.size <= KEEP) break;
				spots.delete(k);
			}
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const save = () => {
			if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR) return put(null);
			const top = el.getBoundingClientRect().top;
			for (const n of inner.querySelectorAll<HTMLElement>('[id^="n-"]')) {
				const box = n.getBoundingClientRect();
				if (box.bottom > top) return put({ uuid: n.id.slice(2), offset: box.top - top });
			}
		};
		const onScroll = () => {
			clearTimeout(timer);
			timer = setTimeout(save, 150);
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			clearTimeout(timer);
			el.removeEventListener("scroll", onScroll);
		};
	}, [key, scroller, content, failed]);
}
