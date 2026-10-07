// 画 ```ui 代码块（格式、给 Claude 的说明都在 lib/visual.ts）。整段读成 JSON（正在写的半截也读），再一个组件一个组件地校验、画：
// 坏了的那一个换成一块「画不出来」并写明哪里不对，别的照画；还没写完的是「正在画」。
// 第一次遇到 ```ui 才加载（lazy.tsx 的 Visual）：dagre、katex 不进主包。
import { createContext, type ReactNode, useContext, useMemo, useState, Component } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { checkNode, type Kind, parse, type Spec } from "@/lib/visual";
import { ChartView } from "./chart";
import { CalloutView, CodeView, CompareView, LayersView, MathView, QuizView, StatView, StepsView, TableView, TextView, TimelineView } from "./content";
import { GraphView, SequenceView, TreeView } from "./graph";
import { CardView, GridView, StepperView, TabsView } from "./layout";

/** 这段 JSON 写完了没有：没写完时校验不过的只是「还在写」，不算错 */
const Done = createContext(true);
export const useDone = () => useContext(Done);

const VIEWS: { [K in Kind]: (p: { spec: Spec<K> }) => ReactNode } = {
	Grid: GridView, Card: CardView, Tabs: TabsView, Stepper: StepperView,
	Text: TextView, Callout: CalloutView, Math: MathView, Code: CodeView, Table: TableView, Stat: StatView,
	Graph: GraphView, Tree: TreeView, Sequence: SequenceView, Timeline: TimelineView, Steps: StepsView, Layers: LayersView, Compare: CompareView,
	Chart: ChartView, Quiz: QuizView,
};

export function Visual({ source }: { source: string }) {
	const { value, done } = useMemo(() => parse(source), [source]);
	const list = Array.isArray(value) ? value : value == null ? [] : [value];
	return (
		<Done.Provider value={done}>
			<div className="not-prose my-4 flex flex-col gap-3 text-sm">
				{list.map((v, i) => <Node key={i} v={v} />)}
				{!list.length && <Pending kind={null} />}
			</div>
		</Done.Provider>
	);
}

/** 几个子组件，从上往下排 */
export function Kids({ list }: { list: unknown[] }) {
	return (
		<div className="flex min-w-0 flex-col gap-3">
			{list.map((v, i) => <Node key={i} v={v} />)}
		</div>
	);
}

export function Node({ v }: { v: unknown }) {
	const done = useDone();
	const c = checkNode(v);
	if (!c.ok) return done ? <Broken kind={c.kind} issues={c.issues} v={v} /> : <Pending kind={c.kind} />;
	const View = VIEWS[c.spec.type] as (p: { spec: Spec }) => ReactNode;
	return (
		<Catch v={v} kind={c.spec.type}>
			<View spec={c.spec} />
		</Catch>
	);
}

function Pending({ kind }: { kind: string | null }) {
	return (
		<div className="flex flex-col gap-1.5">
			<Skeleton className="h-20 w-full rounded-lg" />
			<span className="text-2xs text-muted-foreground">正在画{kind ? ` ${kind}` : ""}…</span>
		</div>
	);
}

/** 画不出来：哪里不对，原文点开看 */
export function Broken({ kind, issues, v }: { kind: string | null; issues: string[]; v: unknown }) {
	const [raw, setRaw] = useState(false);
	return (
		<div className="rounded-lg border border-dashed p-3 text-xs">
			<div className="flex items-center gap-2">
				<span className="font-medium">{kind ? `这个 ${kind} 画不出来` : "画不出来"}</span>
				<button type="button" className="text-2xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setRaw(!raw)}>{raw ? "收起原文" : "原文"}</button>
			</div>
			<ul className="mt-1 list-disc pl-4 text-muted-foreground">
				{issues.slice(0, 6).map((s) => <li key={s}>{s}</li>)}
				{issues.length > 6 && <li>还有 {issues.length - 6} 处</li>}
			</ul>
			{raw && <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted/40 p-2 font-mono leading-code">{JSON.stringify(v, null, 2)}</pre>}
		</div>
	);
}

/** 格式对、画的时候却抛了错（例 公式写错）：只坏这一个 */
class Catch extends Component<{ children: ReactNode; v: unknown; kind: string }, { error: string | null }> {
	state = { error: null as string | null };
	static getDerivedStateFromError(e: unknown) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
	componentDidUpdate(prev: { v: unknown }) {
		// 正在写：内容变了就再试一次
		if (this.state.error && prev.v !== this.props.v) this.setState({ error: null });
	}
	render() {
		return this.state.error ? <Broken kind={this.props.kind} issues={[this.state.error]} v={this.props.v} /> : this.props.children;
	}
}

/** 带标题的白底一块：图、表、演示都放在这里面 */
export function Frame({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
	return (
		<figure className={`min-w-0 rounded-lg border bg-card text-card-foreground ${className ?? ""}`}>
			{title && <figcaption className="border-b px-3 py-2 text-md font-medium">{title}</figcaption>}
			<div className="p-3">{children}</div>
		</figure>
	);
}
