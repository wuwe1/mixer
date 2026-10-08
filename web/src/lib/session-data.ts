// 会话页的数据：拉会话记录（lib/use-incremental：跑的时候每 0.5 秒就有一次更新，带 version 拉增量），会话文件变了、重连了再拉。
// 切走再切回来不从空白开始：先画上次拿到的，再带着它的 version 去拉增量。
// 失效全靠服务端的「epoch:rev」：同一个 epoch 里节点只增不删；文件重写、服务重启、缓存被挤掉都换 epoch，对不上就给全部、整份换掉。
// 只在内存里，留最近用的 12 个。
import { useCallback, useEffect, useRef } from "react";
import { enc, type Session, temporary } from "@shared/api";
import { useEvent } from "./events";
import { useIncremental } from "./use-incremental";

const KEEP = 12;
const kept = new Map<string, Session>();
function keep(key: string, s: Session) {
	kept.delete(key);
	kept.set(key, s);
	for (const k of kept.keys()) {
		if (kept.size <= KEEP) break;
		kept.delete(k);
	}
}

/**
 * 会话页按会话换着挂（app.tsx 的 key），project、session 不会变。
 * 没拿到：已经有内容就接着显示它，没有才是 error；连不上、502 这种过一会儿自己再拉（1、2、4…30 秒）
 */
export function useSessionData(project: string, session: string) {
	const key = `${project}/${session}`;
	const retry = useRef<{ timer?: ReturnType<typeof setTimeout>; wait: number }>({ wait: 1000 });
	const { data, error, load } = useIncremental<Session>(`/api/sessions/${enc(project)}/${enc(session)}`, {
		init: kept.get(key) ?? null,
		onError: (e) => {
			if (!temporary(e)) return;
			clearTimeout(retry.current.timer);
			retry.current.timer = setTimeout(load, retry.current.wait);
			retry.current.wait = Math.min(retry.current.wait * 2, 30_000);
		},
	});
	useEffect(() => {
		if (!data) return;
		keep(key, data);
		retry.current.wait = 1000;
	}, [key, data]);
	useEffect(() => () => clearTimeout(retry.current.timer), []);
	useEvent("session", useCallback((e: { project: string; id: string }) => { if (e.project === project && e.id === session) load(); }, [project, session, load]));
	useEvent("hello", load);
	return { data, error, load };
}
