// 到点重画：只靠时间算的状态（子代理 90 秒内写过）过了时候要变，没有新事件也得重画一次。
import { useEffect, useState } from "react";

/** 到了 at（毫秒时间戳）重画一次；null 不等。返回到过几次点：放进 useMemo 的依赖，到点了重新算 */
export function useDeadline(at: number | null): number {
	const [n, setN] = useState(0);
	useEffect(() => {
		if (at === null || at <= Date.now()) return;
		// 定时器偶尔早到几毫秒：n 变了会再进来一次，没到就接着等
		const t = setTimeout(() => setN((x) => x + 1), at - Date.now() + 50);
		return () => clearTimeout(t);
	}, [at, n]);
	return n;
}

/** 还没到的里面最早的那个；都过了就是 null */
export const nextOf = (ats: number[]) => {
	const now = Date.now();
	const left = ats.filter((t) => t > now);
	return left.length ? Math.min(...left) : null;
};
