// 文字类的组件：一段话、提示、公式、代码、表、数字，和按顺序排的（步骤、时间线、分层）、方案对比、小测验。
// 不上状态色（CLAUDE.md「设计」）：强调靠字重、黑白对比和图标。
import katex from "katex";
import "katex/dist/katex.min.css";
import { Check, Info, Lightbulb, TriangleAlert, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Spec } from "@/lib/visual";
import { cn } from "@/lib/utils";
import { Code } from "../code";
import { Markdown } from "../markdown";
import { Frame } from "./index";

export const TextView = ({ spec }: { spec: Spec<"Text"> }) => <Markdown text={spec.text} />;

const TONES = {
	note: { icon: Info, line: "border-l-border" },
	key: { icon: Lightbulb, line: "border-l-foreground" },
	pitfall: { icon: TriangleAlert, line: "border-l-destructive" },
} as const;

export function CalloutView({ spec }: { spec: Spec<"Callout"> }) {
	const t = TONES[spec.tone ?? "note"];
	return (
		<div className={cn("rounded-r-lg border-l-2 bg-muted/40 px-3 py-2", t.line)}>
			{spec.title && (
				<div className="mb-1 flex items-center gap-1.5 text-md font-medium">
					<t.icon className="size-3.5 shrink-0 text-muted-foreground" />
					{spec.title}
				</div>
			)}
			<Markdown text={spec.text} />
		</div>
	);
}

export function MathView({ spec }: { spec: Spec<"Math"> }) {
	const html = useMemo(() => katex.renderToString(spec.tex, { displayMode: true, throwOnError: false, output: "htmlAndMathml" }), [spec.tex]);
	return (
		<div className="min-w-0">
			{/* katex 自己转义、不认 \href 之类（trust 默认关）：只出排版用的标签 */}
			<div className="overflow-x-auto py-1" dangerouslySetInnerHTML={{ __html: html }} />
			{spec.note && <div className="text-center text-xs text-muted-foreground">{spec.note}</div>}
		</div>
	);
}

export const CodeView = ({ spec }: { spec: Spec<"Code"> }) => <Code code={spec.code} lang={spec.lang ?? "text"} className="overflow-x-auto rounded-lg border bg-muted/40 p-3" />;

export function TableView({ spec }: { spec: Spec<"Table"> }) {
	return (
		<div className="overflow-x-auto rounded-lg border">
			<table className="w-full text-md">
				<thead className="bg-muted/40 text-left">
					<tr>{spec.columns.map((c, i) => <th key={i} className="px-3 py-1.5 font-medium whitespace-nowrap">{c}</th>)}</tr>
				</thead>
				<tbody>
					{spec.rows.map((r, i) => (
						<tr key={i} className="border-t">
							{spec.columns.map((_, j) => <td key={j} className={cn("px-3 py-1.5 align-top", typeof r[j] === "number" && "text-right tabular-nums")}>{r[j] ?? ""}</td>)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function StatView({ spec }: { spec: Spec<"Stat"> }) {
	return (
		<div className="rounded-lg border bg-card px-3 py-2">
			<div className="text-2xs text-muted-foreground">{spec.label}</div>
			<div className="text-lg font-semibold tabular-nums">{typeof spec.value === "number" ? spec.value.toLocaleString() : spec.value}</div>
			{spec.note && <div className="text-xs text-muted-foreground">{spec.note}</div>}
		</div>
	);
}

export function StepsView({ spec }: { spec: Spec<"Steps"> }) {
	return (
		<ol className="flex flex-col">
			{spec.items.map((s, i) => (
				<li key={i} className="flex gap-3">
					<div className="flex flex-col items-center">
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-2xs font-medium tabular-nums">{i + 1}</span>
						{i < spec.items.length - 1 && <span className="w-px flex-1 bg-border" />}
					</div>
					<div className="min-w-0 flex-1 pb-3">
						<div className="pt-0.5 text-md font-medium">{s.title}</div>
						{s.text && <div className="text-muted-foreground"><Markdown text={s.text} /></div>}
					</div>
				</li>
			))}
		</ol>
	);
}

export function TimelineView({ spec }: { spec: Spec<"Timeline"> }) {
	return (
		<ol className="flex flex-col">
			{spec.items.map((t, i) => (
				<li key={i} className="flex gap-3">
					<div className="flex w-2 flex-col items-center">
						<span className="mt-1.5 size-2 shrink-0 rounded-full bg-foreground" />
						{i < spec.items.length - 1 && <span className="w-px flex-1 bg-border" />}
					</div>
					<div className="min-w-0 flex-1 pb-3">
						<div className="font-mono text-xs text-muted-foreground">{t.when}</div>
						<div className="text-md font-medium">{t.title}</div>
						{t.text && <div className="text-xs text-muted-foreground">{t.text}</div>}
					</div>
				</li>
			))}
		</ol>
	);
}

export function LayersView({ spec }: { spec: Spec<"Layers"> }) {
	return (
		<div className="flex flex-col gap-1">
			{spec.layers.map((l, i) => (
				<div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border bg-card px-3 py-2">
					<div className="min-w-24">
						<div className="text-md font-medium">{l.label}</div>
						{l.note && <div className="text-2xs text-muted-foreground">{l.note}</div>}
					</div>
					{!!l.items?.length && (
						<div className="flex flex-1 flex-wrap justify-end gap-1">
							{l.items.map((x, j) => <span key={j} className="rounded border bg-muted/40 px-1.5 py-0.5 text-xs">{x}</span>)}
						</div>
					)}
				</div>
			))}
		</div>
	);
}

export function CompareView({ spec }: { spec: Spec<"Compare"> }) {
	return (
		<div className={cn("grid grid-cols-1 gap-3", spec.items.length === 2 ? "sm:grid-cols-2" : spec.items.length >= 3 && "sm:grid-cols-2 lg:grid-cols-3")}>
			{spec.items.map((c, i) => (
				<Frame key={i} title={c.title}>
					<div className="flex flex-col gap-2 text-md">
						{c.text && <div className="text-muted-foreground">{c.text}</div>}
						<Points sign="+" list={c.pros} label="好处" />
						<Points sign="−" list={c.cons} label="代价" />
						{c.when && <div className="border-t pt-2 text-xs"><span className="text-muted-foreground">什么时候选：</span>{c.when}</div>}
					</div>
				</Frame>
			))}
		</div>
	);
}

function Points({ sign, list, label }: { sign: string; list?: string[]; label: string }) {
	if (!list?.length) return null;
	return (
		<ul aria-label={label} className="flex flex-col gap-0.5">
			{list.map((p, i) => (
				<li key={i} className="flex gap-2">
					<span className="w-3 shrink-0 font-mono text-muted-foreground">{sign}</span>
					<span>{p}</span>
				</li>
			))}
		</ul>
	);
}

export function QuizView({ spec }: { spec: Spec<"Quiz"> }) {
	const [picked, setPicked] = useState<number | null>(null);
	const shown = picked !== null;
	return (
		<Frame>
			<div className="flex flex-col gap-2">
				<div className="text-md font-medium">{spec.question}</div>
				<div className="flex flex-col gap-1">
					{spec.options.map((o, i) => {
						const right = i === spec.answer;
						return (
							<button
								key={i}
								type="button"
								disabled={shown}
								onClick={() => setPicked(i)}
								className={cn(
									"flex items-center gap-2 rounded-md border px-3 py-1.5 text-left text-md enabled:hover:bg-accent",
									shown && right && "border-foreground font-medium",
									shown && !right && i !== picked && "text-muted-foreground",
								)}
							>
								<span className="w-4 shrink-0 font-mono text-2xs text-muted-foreground">{String.fromCharCode(65 + i)}</span>
								<span className="flex-1">{o}</span>
								{shown && right && <Check className="size-3.5 shrink-0" />}
								{shown && !right && i === picked && <X className="size-3.5 shrink-0 text-destructive" />}
							</button>
						);
					})}
				</div>
				{shown && (
					<div className="flex items-start justify-between gap-3 text-xs">
						<div className="text-muted-foreground">{picked === spec.answer ? "对了。" : "不对。"}{spec.explain && <Markdown text={spec.explain} />}</div>
						<button type="button" className="shrink-0 text-2xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setPicked(null)}>再做一次</button>
					</div>
				)}
			</div>
		</Frame>
	);
}
