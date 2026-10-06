// 图解：Claude 在回复里写一个 ```ui 代码块，里面是 JSON，网页把它画成图（流程图、时序图、图表、逐帧演示……），像 claude.ai 的 artifact。
// 模型只写语义（有哪些节点、谁连谁、每一步是什么），位置、颜色、字号都由网页定：画出来和 mixer 一个样子，也不执行模型写的代码。
// 这个文件是唯一的定义：组件的格式（zod）、给 Claude 的说明（prompt，runs.ts 经 --append-system-prompt 带上）、校验、半截 JSON 的解析。
// 不碰 React：服务端也 import 它。加一种组件改两处：这里的定义，components/visual/index.tsx 的画法（VIEWS）。
import { z } from "zod";

/** 子节点：每个元素是一个组件。画的时候一个一个校验，一个坏了不影响别的 */
const children = z.array(z.unknown()).describe("子组件：Node[]");
const text = z.string();

const DEFS = {
	// 排版
	Grid: { shape: { columns: z.number().int().min(1).max(4).optional().describe("几列，默认 2；手机上一列"), children }, use: "并排放几块（例 两个图对照）" },
	Card: { shape: { title: z.string().optional(), children }, use: "一块带标题的区域" },
	Tabs: { shape: { tabs: z.array(z.object({ label: text, children })) }, use: "几种视角、几个方案切换着看" },
	Stepper: { shape: { frames: z.array(z.object({ title: z.string().optional(), children })) }, use: "一步一步翻着看（上一步 / 下一步 / 播放），每一帧是任意组件：讲一个过程怎么演变" },
	// 内容
	Text: { shape: { text: text.describe("Markdown") }, use: "一段文字，放在别的组件里时用" },
	Callout: { shape: { tone: z.enum(["note", "key", "pitfall"]).optional().describe("note 补充（默认）/ key 要记住的结论 / pitfall 常见的误解、坑"), title: z.string().optional(), text: text.describe("Markdown") }, use: "单独拎出来的一句话" },
	Math: { shape: { tex: text.describe("LaTeX，不带 $"), note: z.string().optional() }, use: "一个公式，单独一行" },
	Code: { shape: { lang: z.string().optional(), code: text }, use: "一段代码（放在 Tabs、Compare 等里面时用；单独的代码照常写 Markdown 代码块）" },
	Table: { shape: { columns: z.array(text), rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))) }, use: "多行多列的事实、数字" },
	Stat: { shape: { label: text, value: z.union([z.string(), z.number()]), note: z.string().optional() }, use: "一个关键数字（几个并排放进 Grid）" },
	// 图
	Graph: {
		shape: {
			direction: z.enum(["LR", "TB"]).optional().describe("LR 从左到右（默认），TB 从上到下"),
			nodes: z.array(z.object({
				id: text,
				label: text,
				note: z.string().optional().describe("节点里第二行小字"),
				shape: z.enum(["box", "round", "diamond"]).optional().describe("box 默认 / round 起止、状态 / diamond 判断"),
				emphasis: z.boolean().optional().describe("要读者盯住的那一两个"),
				group: z.string().optional().describe("属于哪个 groups 的 id"),
			})),
			edges: z.array(z.object({ from: text, to: text, label: z.string().optional(), dashed: z.boolean().optional().describe("可选、异步、间接") })).default([]),
			groups: z.array(z.object({ id: text, label: text })).optional().describe("把节点框成一组（例 一个进程、一台机器）"),
		},
		use: "节点和箭头：流程、依赖、架构、数据流、状态机、因果。只给关系，位置自动排",
	},
	Tree: { shape: { root: z.unknown().describe("{ label, note?, children?: 同样的节点[] }") }, use: "层级：分类、组成、目录、语法树" },
	Sequence: {
		shape: {
			actors: z.array(text).describe("参与者，按从左到右"),
			messages: z.array(z.object({ from: text, to: text, label: text, reply: z.boolean().optional().describe("回应（画成虚线）"), note: z.string().optional().describe("这一步旁边的说明") })).default([]),
		},
		use: "几方之间按时间先后来回传消息：协议、调用链、握手",
	},
	Timeline: { shape: { items: z.array(z.object({ when: text, title: text, text: z.string().optional() })) }, use: "按时间排的事件：历史、版本、生命周期" },
	Steps: { shape: { items: z.array(z.object({ title: text, text: z.string().optional().describe("Markdown") })) }, use: "按顺序做的几步、一个推导的几步" },
	Layers: { shape: { layers: z.array(z.object({ label: text, note: z.string().optional(), items: z.array(text).optional() })).describe("从上到下") }, use: "分层结构：协议栈、系统架构、抽象层次" },
	Compare: { shape: { items: z.array(z.object({ title: text, text: z.string().optional(), pros: z.array(text).optional(), cons: z.array(text).optional(), when: z.string().optional().describe("什么时候选它") })) }, use: "几个方案的取舍（逐项对比数字用 Table）" },
	// 数据
	Chart: {
		shape: {
			kind: z.enum(["line", "bar", "scatter"]),
			title: z.string().optional(),
			x: z.string().optional().describe("横轴名"),
			y: z.string().optional().describe("纵轴名"),
			series: z.array(z.object({ name: text, points: z.array(z.tuple([z.union([z.number(), z.string()]), z.number()])).describe("[x, y]；bar 的 x 是类别名") })).describe("最多 8 组；scatter 最多 3 组"),
		},
		use: "数据：趋势（line）、比大小（bar）、关系（scatter）。只有一个轴，不画双轴",
	},
	// 过程
	ArrayViz: {
		shape: {
			frames: z.array(z.object({
				cells: z.array(z.union([z.string(), z.number(), z.null()])).optional().describe("这一帧的格子；不写就沿用上一帧"),
				pointers: z.record(z.string(), z.number().int()).optional().describe("指针名 → 下标（例 { lo: 0, hi: 7 }）"),
				highlight: z.array(z.number().int()).optional().describe("要盯住的格子"),
				dim: z.array(z.number().int()).optional().describe("已经排除的格子"),
				note: z.string().optional().describe("这一步发生了什么"),
			})),
		},
		use: "数组、栈、队列上的算法一步一步走（二分、双指针、排序、滑动窗口）。每一帧写清状态，网页负责播放",
	},
	Quiz: { shape: { question: text, options: z.array(text), answer: z.number().int().describe("对的那个选项的下标，从 0 起"), explain: z.string().optional().describe("选完后显示：为什么") }, use: "讲完了出一道题，让读者检验自己懂没懂" },
} satisfies Record<string, { shape: z.ZodRawShape; use: string }>;

export type Kind = keyof typeof DEFS;
export const KINDS = Object.keys(DEFS) as Kind[];
type SchemaOf<K extends Kind> = (typeof DEFS)[K]["shape"] extends infer S extends z.ZodRawShape ? z.ZodObject<{ type: z.ZodLiteral<K> } & S> : never;
const SCHEMAS = Object.fromEntries(KINDS.map((k) => [k, z.object({ type: z.literal(k), ...DEFS[k].shape })])) as unknown as { [K in Kind]: SchemaOf<K> };
export type Spec<K extends Kind = Kind> = { [P in K]: z.infer<(typeof SCHEMAS)[P]> }[K];
export type TreeItem = { label: string; note?: string; children?: TreeItem[] };
const TreeItem: z.ZodType<TreeItem> = z.lazy(() => z.object({ label: text, note: z.string().optional(), children: z.array(TreeItem).optional() }));

/** 错误写成中文：只在这里用，不改 zod 的全局设置（服务端别处也用 zod） */
const ZH = { error: z.locales.zhCN().localeError };

/** 一个节点能不能画：能就是 { ok, spec }；不能就是哪几处不对（「nodes.2.label: 要的是 string」） */
export type Checked = { ok: true; spec: Spec } | { ok: false; kind: string | null; issues: string[] };
export function checkNode(v: unknown): Checked {
	if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, kind: null, issues: ["要的是一个对象 { type, … }"] };
	const t = (v as { type?: unknown }).type;
	if (typeof t !== "string" || !(t in SCHEMAS)) {
		const near = typeof t === "string" ? nearest(t) : null;
		return { ok: false, kind: typeof t === "string" ? t : null, issues: [typeof t === "string" ? `没有 ${t} 这种组件${near ? `，是不是 ${near}` : ""}` : "缺 type"] };
	}
	const r = SCHEMAS[t as Kind].safeParse(v, ZH);
	const tree = t === "Tree" && r.success ? TreeItem.safeParse((r.data as Spec<"Tree">).root, ZH) : null;
	if (r.success && (!tree || tree.success)) return { ok: true, spec: r.data as Spec };
	const issues = r.success ? (tree?.error?.issues ?? []).map((i) => ({ ...i, path: ["root", ...i.path] })) : r.error.issues;
	return { ok: false, kind: t, issues: issues.map((i) => `${i.path.join(".") || "(整个)"}: ${i.message}`) };
}

/** 整个代码块里有问题的地方，带路径（测试、以后给 Claude 自查用） */
export function check(v: unknown, at = ""): string[] {
	const list = Array.isArray(v) ? v.map((x, i) => [x, `${at}[${i}]`] as const) : [[v, at] as const];
	return list.flatMap(([x, p]) => {
		const c = checkNode(x);
		if (!c.ok) return c.issues.map((i) => `${p || "(根)"} ${c.kind ?? ""}: ${i}`);
		return kidsOf(c.spec).flatMap(([k, path]) => check(k, `${p}.${path}`));
	});
}

/** 一个节点里装着的子组件，和它们在哪（Grid.children、Tabs.tabs.0.children……） */
export function kidsOf(s: Spec): [unknown[], string][] {
	if (s.type === "Grid" || s.type === "Card") return [[s.children, "children"]];
	if (s.type === "Tabs") return s.tabs.map((t, i) => [t.children, `tabs.${i}.children`]);
	if (s.type === "Stepper") return s.frames.map((f, i) => [f.children, `frames.${i}.children`]);
	return [];
}

function nearest(t: string): string | null {
	const lower = t.toLowerCase();
	return KINDS.find((k) => k.toLowerCase() === lower || k.toLowerCase().startsWith(lower.slice(0, 4))) ?? null;
}

/**
 * 读 JSON，也读半截的（正在写的回复）：读到哪算哪，没写完的字符串照已有的算，没写完的键、数字、true/false 丢掉，括号自动补上。
 * done：整段是完整的 JSON（没写完的组件这时才算错，之前只是还在写）
 */
export function parse(src: string): { value: unknown; done: boolean } {
	const s = src.trim();
	try {
		return { value: JSON.parse(s), done: true };
	} catch {}
	let i = 0;
	const END = Symbol("end");
	const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
	// 没写完的字符串照已有的算
	const str = (): string => {
		i++;
		let out = "";
		while (i < s.length) {
			const c = s[i++];
			if (c === '"') return out;
			if (c !== "\\") { out += c; continue; }
			if (i >= s.length) return out;
			const e = s[i++];
			if (e === "u") {
				const h = s.slice(i, i + 4);
				if (h.length < 4) return out;
				out += String.fromCharCode(Number.parseInt(h, 16));
				i += 4;
			} else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
		}
		return out;
	};
	const value = (): unknown => {
		ws();
		if (i >= s.length) return END;
		const c = s[i];
		if (c === "{") {
			i++;
			const o: Record<string, unknown> = {};
			for (;;) {
				ws();
				if (i >= s.length) return o;
				if (s[i] === "}") { i++; return o; }
				if (s[i] === ",") { i++; continue; }
				if (s[i] !== '"') return o;
				const k = str();
				ws();
				if (s[i] !== ":") return o;
				i++;
				const v = value();
				if (v === END) return o;
				o[k] = v;
			}
		}
		if (c === "[") {
			i++;
			const a: unknown[] = [];
			for (;;) {
				ws();
				if (i >= s.length) return a;
				if (s[i] === "]") { i++; return a; }
				if (s[i] === ",") { i++; continue; }
				const v = value();
				if (v === END) return a;
				a.push(v);
			}
		}
		if (c === '"') return str();
		const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
		if (m) {
			i += m[0].length;
			// 数字后面就到头了：可能还没写完（12 → 128），先不要
			return i >= s.length ? END : Number(m[0]);
		}
		for (const [w, v] of [["true", true], ["false", false], ["null", null]] as const) {
			if (s.startsWith(w, i)) { i += w.length; return v; }
		}
		i = s.length;
		return END;
	};
	const v = value();
	return { value: v === END ? null : v, done: false };
}

/** zod 的定义 → 一行 TypeScript 样子的字段说明，给 Claude 看 */
type J = { type?: string | string[]; const?: unknown; enum?: unknown[]; items?: J | J[]; prefixItems?: J[]; anyOf?: J[]; description?: string; properties?: Record<string, J>; required?: string[]; additionalProperties?: J | boolean };
function sig(t: J, top = false): string {
	if (t.const !== undefined) return JSON.stringify(t.const);
	if (t.enum) return t.enum.map((x) => JSON.stringify(x)).join(" | ");
	if (t.anyOf) return t.anyOf.map((x) => sig(x)).join(" | ");
	if (t.prefixItems) return `[${t.prefixItems.map((x) => sig(x)).join(", ")}]`;
	if (t.type === "array" && t.items && !Array.isArray(t.items)) {
		if (t.description?.startsWith("子组件")) return "Node[]";
		const inner = sig(t.items);
		// 只有最外层是「a | b」才要括号：{ … }、(…)[] 里面的 | 不算
		return `${inner.includes(" | ") && !/[\]}]$/.test(inner) ? `(${inner})` : inner}[]`;
	}
	if (t.type === "object" && t.properties) {
		const req = new Set(t.required ?? []);
		const fields = Object.entries(t.properties).filter(([k]) => !(top && k === "type")).map(([k, v]) => {
			const body = sig(v);
			const d = v.description && v.description !== body && !v.description.startsWith("子组件") ? ` /* ${v.description} */` : "";
			return `${k}${req.has(k) ? "" : "?"}: ${body}${d}`;
		});
		return `{ ${fields.join(", ")} }`;
	}
	if (t.type === "object" && t.additionalProperties && typeof t.additionalProperties === "object") return `Record<string, ${sig(t.additionalProperties)}>`;
	if (t.description && !t.type) return t.description;
	return [t.type ?? "unknown"].flat().join(" | ");
}

/** 每种组件一行：名字、字段、什么时候用 */
export function docs(): string {
	return KINDS.map((k) => {
		const j = z.toJSONSchema(SCHEMAS[k], { io: "input", unrepresentable: "any" }) as J;
		return `- ${k} ${sig(j, true)}\n  用于：${DEFS[k].use}`;
	}).join("\n");
}

/** 带给 Claude 的说明（--append-system-prompt）：什么时候画、怎么写、有哪些组件 */
export function prompt(): string {
	return `# 图解（mixer 能画）

用户在 mixer 的网页里看你的回复。回复里的 \`\`\`ui 代码块会被画成图：里面写一个 JSON，是一个组件 { "type": …, … }，或者几个组件的数组（从上往下排）。

什么时候画：讲解一个概念、机制、流程、结构、算法、取舍、数据时，一张图比几段话清楚，就在文字中间放一个。只画能帮读者看懂的；一句话能说清的、纯改代码的任务、闲聊都不画。图和文字分工：图给结构，文字给道理，不要在文字里把图再念一遍。

怎么写：
- 只写语义（有哪些东西、谁连谁、每一步是什么）。位置、颜色、大小由网页定，不要想坐标，也没有颜色字段
- 一个图讲一件事，节点十几个以内；太多就拆成几个，或者用 Tabs、Stepper
- 过程用 Stepper 或 ArrayViz：把每一步的状态写出来，网页负责播放，不要写代码去算
- 文字字段里能写 Markdown 的会标出来；Markdown 里不认 $…$，公式用 Math 单独一行（或者写成 log₂n 这样的普通字）
- 组件之外的东西（自由画的 SVG、HTML、脚本）画不了；画不出来的就用文字或普通代码块说
- 用户在终端里看时代码块原样显示，所以 JSON 要缩进整齐、好读

组件（? 是可以不写的）：
${docs()}

例：
\`\`\`ui
{ "type": "Sequence", "actors": ["客户端", "服务器"], "messages": [
  { "from": "客户端", "to": "服务器", "label": "SYN seq=x" },
  { "from": "服务器", "to": "客户端", "label": "SYN+ACK seq=y ack=x+1", "reply": true, "note": "服务器进入 SYN_RCVD" },
  { "from": "客户端", "to": "服务器", "label": "ACK ack=y+1" }
] }
\`\`\``;
}
