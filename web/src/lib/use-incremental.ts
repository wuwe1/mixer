// 按增量拉一份带节点的东西（会话、子代理的对话）：拿到过就带 ?since=<version> 只要之后变了的，合进去（thread.ts 的 merge）。
// 一次只拉一个：上一次还没回来就记下，回来了再拉一次（网慢也不会堆一串请求、旧的盖掉新的）。
import { useCallback, useEffect, useRef, useState } from "react";
import { api, enc, type Node } from "@shared/api";
import { merge } from "./thread";

type Versioned = { nodes: Node[]; delta: boolean; version: string };

/**
 * url：拉哪个，null 是先不拉（已有的留着）；换了 url 从头来。init：先画着的那份（切回会话时上次拿到的）。
 * onError：没拿到（first：这个 url 还什么都没拿到过）；出错之后要不要、什么时候再拉，自己定
 */
export function useIncremental<T extends Versioned>(url: string | null, o: { init?: T | null; onError?: (e: Error, first: boolean) => void } = {}) {
	const [data, setData] = useState<T | null>(o.init ?? null);
	const [error, setError] = useState<Error | null>(null);
	const cur = useRef<T | null>(data);
	/** cur 是哪个 url 的 */
	const of = useRef(url);
	/** 正在拉的那次（换了 url 就作废）；again：这期间又要拉 */
	const pulling = useRef<{ again: boolean } | null>(null);
	const onError = useRef(o.onError);
	onError.current = o.onError;
	const load = useCallback(() => {
		if (!url) return;
		if (pulling.current) return void (pulling.current.again = true);
		const p = { again: false };
		pulling.current = p;
		const done = () => {
			if (pulling.current !== p) return;
			pulling.current = null;
			if (p.again) load();
		};
		const since = cur.current ? `?since=${enc(cur.current.version)}` : "";
		api<T>(url + since).then(
			(d) => {
				if (pulling.current === p) {
					cur.current = merge(cur.current, d);
					setData(cur.current);
					setError(null);
				}
				done();
			},
			(e: Error) => {
				if (pulling.current === p) {
					setError(e);
					onError.current?.(e, !cur.current);
				}
				done();
			},
		);
	}, [url]);
	useEffect(() => {
		pulling.current = null;
		if (!url) return;
		if (of.current !== url) {
			of.current = url;
			cur.current = null;
			setData(null);
			setError(null);
		}
		load();
	}, [url, load]);
	return { data, error, load };
}
