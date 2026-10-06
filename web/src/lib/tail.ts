// 一次运行的输出流 → 正在写的那几段（文字、思考、工具调用的参数）。服务端和网页用同一份：
// 服务端把命令行的 stream_event 缩成几个字的短事件（project），同一段连着的增量攒一下合成一个（coalesce），自己攒着、带上序号推给网页；
// 网页打开时拿一份快照（带序号），之后按序号接推送来的短事件，刷新、断线重连都一样。
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
type Raw = Record<string, any>;

/**
 * 推给网页的短事件，只带 step 用得着的：
 *   ["m", 消息 id]：message_start
 *   ["b", 第几段, "text" | "thinking"] / ["b", 第几段, "tool", 工具调用 id, 工具名]：content_block_start
 *   ["d", 第几段, 字]：content_block_delta 的文字、思考、工具参数（连着的同一段可以合成一个）
 */
export type Ev = ["m", string] | ["b", number, "text" | "thinking"] | ["b", number, "tool", string, string] | ["d", number, string];

/** 工具调用一行里显示的那句（Bash 的说明、文件路径、搜的词…）：记录里的和流里正在写的用同一份，写完换成记录里的时不变 */
export function summarize(input: Raw): string {
	const pick = input.description ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.prompt ?? input.skill ?? "";
	return String(pick).split("\n")[0].slice(0, 160);
}

/**
 * 命令行的一行输出 → 短事件；用不着的（签名、ping、content_block_stop、message_delta、空的增量、认不出的块、不是 stream_event 的）是 null，不推、不算序号
 */
export function project(ev: Raw): Ev | null {
	const e = ev?.type === "stream_event" ? ev.event : null;
	if (e?.type === "message_start") return ["m", String(e.message?.id ?? "")];
	if (e?.type === "content_block_start") {
		const b = e.content_block;
		const i = Number(e.index);
		return b?.type === "text" || b?.type === "thinking" ? ["b", i, b.type] : b?.type === "tool_use" ? ["b", i, "tool", String(b.id ?? ""), String(b.name ?? "工具")] : null;
	}
	if (e?.type === "content_block_delta") {
		const d = e.delta;
		const add: unknown = d?.type === "text_delta" ? d.text : d?.type === "thinking_delta" ? d.thinking : d?.type === "input_json_delta" ? d.partial_json : undefined;
		return typeof add === "string" && add ? ["d", Number(e.index), add] : null;
	}
	return null;
}

/**
 * 同一段连着来的增量攒着合成一个，最多攒 ms 毫秒；别的事件、换了一段都先把攒着的推出去，先后不乱。
 * flush：马上推出去（拿快照之前、运行结束时）
 */
export function coalesce(out: (e: Ev) => void, ms: number) {
	let held: ["d", number, string] | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		clearTimeout(timer);
		const e = held;
		held = null;
		if (e) out(e);
	};
	const add = (e: Ev) => {
		if (e[0] !== "d") {
			flush();
			return out(e);
		}
		if (held?.[1] === e[1]) return void (held[2] += e[2]);
		flush();
		held = [...e];
		timer = setTimeout(flush, ms);
	};
	return { add, flush };
}

/**
 * 处理一个短事件。只留这条消息和上一条的段：再早的肯定已经写进记录了，快照不会越攒越大。
 * 不改原来的对象（网页上直接拿来当 React 的状态）
 */
export function step(t: Tail, e: Ev, now: number): Tail {
	const seq = t.seq + 1;
	if (e[0] === "m") {
		const msg = e[1];
		const keep = new Set([t.msg, msg]);
		return { seq, msg, blocks: t.blocks.filter((b) => keep.has(b.key.slice(0, b.key.lastIndexOf(":")))) };
	}
	if (!t.msg) return { ...t, seq };
	const key = `${t.msg}:${e[1]}`;
	if (e[0] === "b") {
		const block: Block = e[2] === "tool" ? { k: "tool", id: e[3], name: e[4], json: "", key, at: now } : { k: e[2], text: "", key, at: now };
		return { ...t, seq, blocks: [...t.blocks, block] };
	}
	const add = e[2];
	return { ...t, seq, blocks: t.blocks.map((b) => (b.key !== key ? b : b.k === "tool" ? { ...b, json: b.json + add } : { ...b, text: b.text + add })) };
}
