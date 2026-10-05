// 一次运行的输出流 → 正在写的那几段（文字、思考、工具调用的参数）。服务端和网页用同一份：
// 服务端攒着，网页打开时拿一份快照（带序号），之后按序号接推送来的事件，刷新、断线重连都一样。
// 每段的身份是「消息 id : 第几段」，和会话记录里的对得上（一条 assistant 记录一段，同一条消息的按文件顺序数），
// 记录里一有这一段，网页就换成记录里的。只依赖事件本身，不碰浏览器和 Node 的东西。

export type Block = ({ k: "text"; text: string } | { k: "thinking"; text: string } | { k: "tool"; id: string; name: string; json: string }) & {
	/** 消息 id : 第几段 */
	key: string;
	/** 这一段开始的时间（毫秒） */
	at: number;
};
/** seq：已经处理到第几个事件 */
export type Tail = { seq: number; msg: string | null; blocks: Block[] };

export const emptyTail = (): Tail => ({ seq: 0, msg: null, blocks: [] });

// biome-ignore lint: 命令行的事件格式，没有类型
type Ev = Record<string, any>;

/** 工具调用一行里显示的那句（Bash 的说明、文件路径、搜的词…）：记录里的和流里正在写的用同一份，写完换成记录里的时不变 */
export function summarize(input: Ev): string {
	const pick = input.description ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.prompt ?? input.skill ?? "";
	return String(pick).split("\n")[0].slice(0, 160);
}

/** 只有 stream_event 会改动这几段；别的事件不算序号 */
export const counts = (ev: Ev) => ev?.type === "stream_event" && !!ev.event;

/**
 * 处理一个 stream_event。只留这条消息和上一条的段：再早的肯定已经写进记录了，快照不会越攒越大。
 * 不改原来的对象（网页上直接拿来当 React 的状态）
 */
export function step(t: Tail, ev: Ev, now: number): Tail {
	const e = ev.event;
	const seq = t.seq + 1;
	if (e.type === "message_start") {
		const msg = String(e.message?.id ?? "");
		const keep = new Set([t.msg, msg]);
		return { seq, msg, blocks: t.blocks.filter((b) => keep.has(b.key.slice(0, b.key.lastIndexOf(":")))) };
	}
	if (e.type === "content_block_start" && t.msg) {
		const b = e.content_block;
		const key = `${t.msg}:${e.index}`;
		const block: Block | null =
			b?.type === "text" ? { k: "text", text: "", key, at: now }
			: b?.type === "thinking" ? { k: "thinking", text: "", key, at: now }
			: b?.type === "tool_use" ? { k: "tool", id: String(b.id ?? ""), name: String(b.name ?? "工具"), json: "", key, at: now }
			: null;
		return { ...t, seq, blocks: block ? [...t.blocks, block] : t.blocks };
	}
	if (e.type === "content_block_delta" && t.msg) {
		const key = `${t.msg}:${e.index}`;
		const d = e.delta;
		const add: string | undefined = d?.type === "text_delta" ? d.text : d?.type === "thinking_delta" ? d.thinking : d?.type === "input_json_delta" ? d.partial_json : undefined;
		if (!add) return { ...t, seq };
		return { ...t, seq, blocks: t.blocks.map((b) => (b.key !== key ? b : b.k === "tool" ? { ...b, json: b.json + add } : { ...b, text: b.text + add })) };
	}
	return { ...t, seq };
}
