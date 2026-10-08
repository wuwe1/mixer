// 拿一份东西：地址变了再拿，回来晚了的旧回包不要。会话、子代理的对话要拉增量，用 use-incremental.ts。
import { useEffect, useState } from "react";
import { api } from "@shared/api";

type Got<T> = { url: string; data: T | null; error: Error | null };

/**
 * url：拿哪个，null 是先不拿（拿到过的留着）。换了地址，拿到之前是 null，不显示上一个的。
 * again：变了就再拿一次（同一个地址、内容可能变了；再拿时先留着旧的）。poll：每隔多少毫秒再拿一次（开着看后台命令的输出）。
 * 出错了 data 留着这个地址上次拿到的
 */
export function useApi<T>(url: string | null, o: { again?: unknown; poll?: number } = {}): { data: T | null; error: Error | null } {
	const [got, setGot] = useState<Got<T> | null>(null);
	const { again, poll } = o;
	useEffect(() => {
		if (!url) return;
		let live = true;
		const get = () =>
			api<T>(url).then(
				(data) => { if (live) setGot({ url, data, error: null }); },
				(error: Error) => { if (live) setGot((g) => ({ url, data: g?.url === url ? g.data : null, error })); },
			);
		get();
		const timer = poll ? setInterval(get, poll) : undefined;
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [url, again, poll]);
	if (!got || (url !== null && got.url !== url)) return { data: null, error: null };
	return { data: got.data, error: got.error };
}
