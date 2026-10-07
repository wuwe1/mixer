// 从中间分叉：每条回复、每组工具调用的分叉图标 → 从这里分叉；每条你的消息的铅笔 → 编辑并分叉（先填上那条的字和图）。
// 开一个新会话，带着到那一处为止的上下文，原会话不动；改写的是第一条消息就是在同一个项目里开新会话。
// 输入框是 prompt.tsx 的 PromptBox：草稿按分叉点存，关了再开还在。
import { GitFork } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Kind } from "@/lib/model";
import { forkPoint, type User, type Walk } from "@/lib/thread";
import { type Of, PromptBox, usePrompt } from "./prompt";

export type ForkTarget = { kind: "edit"; n: User } | { kind: "at"; at: string; what: string };

export function ForkDialog({ project, session, w, chosen, chosenEffort, target, agent, onClose }: { project: string; session: string; w: Walk; chosen: string | null; chosenEffort: string | null; target: ForkTarget | null; agent: Kind; onClose: () => void }) {
	// 关的时候有动画：那一会儿还画着刚才那个
	const [shown, setShown] = useState(target);
	if (target && target !== shown) setShown(target);
	const t = target ?? shown;
	const of = { project, session, agent, path: w.path, chosen, chosenEffort };
	return (
		<Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GitFork className="size-4" />
						{t?.kind === "edit" ? "编辑并分叉" : "从这里分叉"}
					</DialogTitle>
					<DialogDescription>
						{t?.kind === "edit" ? "带上这条之前的对话开新会话，这条换成下面的内容。" : `带上到${t?.what ?? "这里"}为止的对话开新会话，发出下面的内容。`}原会话不变。
						{agent === "codex" && t?.kind === "at" && " Codex 按轮分叉：带上的是这一轮整轮。"}
					</DialogDescription>
				</DialogHeader>
				{t && <ForkBox key={t.kind === "edit" ? t.n.uuid : t.at} of={of} t={t} onSent={onClose} />}
			</DialogContent>
		</Dialog>
	);
}

/** 分叉点打开时就算好：之后路还在长，编辑的那条换了对象也不影响 */
function ForkBox({ of, t, onSent }: { of: Of; t: ForkTarget; onSent: () => void }) {
	const [at] = useState(() => (t.kind === "at" ? t.at : forkPoint(of.path, t.n)));
	const p = usePrompt(t.kind === "edit" ? { fork: of, at, edit: t.n } : { fork: of, at }, onSent);
	return <PromptBox p={p} autoFocus placeholder="分叉后发出的消息…" send={{ label: "分叉", icon: <GitFork className="size-4" /> }} />;
}
