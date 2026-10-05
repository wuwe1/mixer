// 模型：会话记录里是完整型号（claude-opus-5-5），选的时候用命令行的别名（opus），总是选最新的那一版。
import type { Node } from "./api";

export const MODELS = [
	{ v: "fable", label: "Fable" },
	{ v: "opus", label: "Opus" },
	{ v: "sonnet", label: "Sonnet" },
	{ v: "haiku", label: "Haiku" },
] as const;

/** claude-opus-5-5 → opus；认不出就是 null */
export const family = (id: string) => /^claude-([a-z]+)-\d/.exec(id)?.[1] ?? null;
/** claude-opus-5-5 → Opus 5.5；别名 opus → Opus */
export function pretty(id: string) {
	const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
	if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
	return MODELS.find((x) => x.v === id)?.label ?? id;
}

/** 路上最后一条带用量的回复：上下文用了多少、用的哪个模型 */
export const lastCtx = (path: Node[]) => {
	for (let i = path.length - 1; i >= 0; i--) {
		const n = path[i];
		if ("ctx" in n && n.ctx) return n.ctx;
	}
	return null;
};

/** 下一条用哪个模型：在 mixer 里选过的；没选过就接着用上一条回复的那个系列（从终端开的会话不会被换成默认的）；都没有就是默认 */
export const defaultModel = (path: Node[], chosen: string | null) => {
	if (chosen) return chosen;
	const c = lastCtx(path);
	const f = c && family(c.model);
	return f && MODELS.some((m) => m.v === f) ? f : null;
};

/** 模型的上下文窗口：完整型号直接查；别名用学到的同系列里最新的那个 */
export function windowOf(model: string, windows: Record<string, number>) {
	if (windows[model]) return windows[model];
	const ids = Object.keys(windows).filter((id) => family(id) === model).sort();
	return ids.length ? windows[ids[ids.length - 1]] : null;
}
