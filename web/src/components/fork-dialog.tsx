// 从中间分叉：每条回复、每组工具调用的分叉图标 → 从这里分叉；每条你的消息的铅笔 → 编辑并分叉。
// 开一个新会话，带着到那一处为止的上下文，原会话不动；改写的是第一条消息就是在同一个项目里开新会话。
import { GitFork } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, type Queued, type Run } from "@/lib/api";
import { askNotify, useLive } from "@/lib/live";
import { type Agent as Kind, lastCtx, modelFor } from "@/lib/model";
import { forkPoint, type User, type Walk } from "@/lib/thread";
import { ModelSelect, PermissionSelect } from "./composer";

export type ForkTarget = { kind: "edit"; n: User } | { kind: "at"; at: string; what: string };

/** 发起一次运行（继续、分叉、新会话）；在跑的会话继续就排队。分叉的建好了自动打开 */
export async function start(body: Record<string, unknown>, follow: (r: Run) => void) {
	askNotify();
	const r = await api<Run | { queued: Queued }>("/api/runs", body);
	if ("queued" in r) return r;
	if (body.mode === "fork") {
		toast.success("正在分叉，建好后自动打开");
		follow(r);
	}
	return r;
}

export function ForkDialog({ project, session, w, chosen, chosenEffort, target, agent, onClose }: { project: string; session: string; w: Walk; chosen: string | null; chosenEffort: string | null; target: ForkTarget | null; agent: Kind; onClose: () => void }) {
	const { follow } = useLive();
	const [text, setText] = useState("");
	const [permission, setPermission] = useState("auto");
	const [model, setModel] = useState("");
	const [effort, setEffort] = useState("");
	// 请求在路上：按钮禁用，网慢时点两下不会开出两个分叉
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!target) return;
		setText(target.kind === "edit" ? target.n.text : "");
		setModel(modelFor(agent, w.path, chosen) ?? "");
		setEffort(chosenEffort ?? "");
	}, [target]);
	const send = async () => {
		if (!target || !text.trim() || busy) return;
		setBusy(true);
		try {
			const at = target.kind === "at" ? target.at : forkPoint(w.path, target.n);
			// 改写第一条消息：前面没有上下文，就是在同一个项目里开新会话
			const m = { model: model || null, effort: effort || null };
			await start(at ? { project, session, mode: "fork", at, prompt: text, permission, ...m } : { project, mode: "new", agent, prompt: text, permission, ...m }, follow);
			onClose();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GitFork className="size-4" />
						{target?.kind === "edit" ? "编辑并分叉" : "从这里分叉"}
					</DialogTitle>
					<DialogDescription>
						{target?.kind === "edit" ? "带上这条之前的对话开新会话，这条换成下面的内容。" : `带上到${target?.what ?? "这里"}为止的对话开新会话，发出下面的内容。`}原会话不变。
						{agent === "codex" && target?.kind === "at" && " Codex 按轮分叉：带上的是这一轮整轮。"}
					</DialogDescription>
				</DialogHeader>
				<Textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} className="min-h-32" autoFocus />
				<DialogFooter className="items-center sm:justify-between">
					<div className="flex items-center gap-1.5">
						<PermissionSelect value={permission} onChange={setPermission} />
						<ModelSelect model={model} effort={effort} onChange={(m, e) => { setModel(m); setEffort(e); }} current={lastCtx(w.path)?.model} agent={agent} />
					</div>
					<div className="flex gap-2">
						<Button variant="outline" onClick={onClose}>取消</Button>
						<Button onClick={send} disabled={!text.trim() || busy}>{busy && <Spinner />}分叉</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
