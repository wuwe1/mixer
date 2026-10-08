// 对话里的东西是哪个会话的（子代理的对话里还有是哪个子代理）：会话页给一层，子代理的对话里再给一层。
// 消息、工具调用、思考拿详情和图片的地址，点了文件、子代理怎么办，都从这里拿，不再一层层往下传。
// 值要稳：消息组件是 memo 的，它一变整个对话都重画
import { createContext, useContext } from "react";
import { enc } from "@shared/api";

type Scope = {
	project: string;
	session: string;
	/** 子代理的对话里：是哪个子代理 */
	agent?: string;
	/** 这个会话的接口：/api/sessions/<项目>/<会话>/<path>，子代理的对话里带上 ?agent= */
	url: (path: string) => string;
	/** 在右边的面板里打开一个文件（绝对路径）；diff：看它的改动 */
	onFile?: (path: string, diff: boolean) => void;
	/** 打开一个子代理的对话（子代理的对话里没有） */
	onAgent?: (id: string) => void;
};

export function scopeOf(project: string, session: string, o: Pick<Scope, "agent" | "onFile" | "onAgent"> = {}): Scope {
	const base = `/api/sessions/${enc(project)}/${enc(session)}/`;
	const q = o.agent ? `?agent=${enc(o.agent)}` : "";
	return { project, session, ...o, url: (path) => base + path + q };
}

export const SessionScope = createContext<Scope | null>(null);

export function useScope(): Scope {
	const s = useContext(SessionScope);
	if (!s) throw new Error("useScope 要在 SessionScope 里面用");
	return s;
}
