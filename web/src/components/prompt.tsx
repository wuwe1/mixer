// 输入框：继续、分叉（从这里分叉 / 编辑并分叉）、新会话三处共用一个。usePrompt 管写了什么和怎么发，PromptBox 画出来。
// 三处都有：图片（选图、粘贴、点开批注）；草稿随打随存（这台设备上，按发到哪里分开存：继续按会话，分叉按会话和分叉点，新会话按项目）；
// 权限、模型和思考强度（默认一套：会话的接着用 mixer 里选过的、没选过接着用上一条回复的系列；新会话用默认）；
// ⌘Enter 发送；skill。继续的另有发件箱（lib/outbox.ts）：发出去的写进记录才算数，没发出去的放回输入框。
import { ImagePlus, Plus, Send, SquareSlash } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, type Node, type Queued, type Run } from "@shared/api";
import { askNotify, useLive } from "@/lib/live";
import { lastCtx, modelFor } from "@/lib/model";
import { useDraft, useOutbox } from "@/lib/outbox";
import type { User } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { AttachStrip, encode, fromUrls, type Shot, toShots, useShots } from "./attach";
import { SkillPicker } from "./lazy";
import { userImages } from "./message";
import { type Choice, ModelSelect, PermissionSelect } from "./model-menu";

/** 发起一次运行（继续、分叉、新会话）；在跑的会话继续就排队。分叉、新会话建好了自动打开 */
export async function start(body: Record<string, unknown>, follow: (r: Run) => void) {
	askNotify();
	const r = await api<Run | { queued: Queued }>("/api/runs", body);
	if ("queued" in r) return r;
	if (body.mode !== "resume") {
		toast(body.mode === "fork" ? "正在分叉，建好后自动打开" : "已开始，建好后自动打开");
		follow(r);
	}
	return r;
}

/** 会话那头：哪个会话、看着的那条路（默认模型、上下文从这里来）、在 mixer 里给它选过的模型和思考强度 */
export type Of = { project: string; session: string; path: Node[]; chosen: string | null; chosenEffort: string | null };

/**
 * 发到哪里：
 * - resume：继续这个会话。fork 给了就是只能分叉（在看旧版本、终端中打开）：从 fork.at 分叉，null 是最新处；
 *   record：记录里有的 uuid、拉回来的数据到哪了（发件箱看发出去的那条到没到）
 * - fork：从中间分叉，at 是分叉点（null：改写的是第一条消息，前面没有上下文，就在同一个项目里开新会话）；edit：编辑并分叉的那条，先填上它的字和图
 * - new：在一个文件夹（cwd）或一个已有的项目（project）里开新会话
 */
export type Target = { resume: Of; fork?: { at: string | null }; record?: { ids: Set<string>; version: string } } | { fork: Of; at: string | null; edit?: User } | { new: { cwd: string } | { project: string } };

/** 项目 id：claude 的规则，路径里非字母数字的字符都换成 -（和 server/dirs.ts 一样） */
const projectId = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

const draftKey = (t: Target) => {
	if ("resume" in t) return t.resume.session;
	if ("new" in t) return `new.${"cwd" in t.new ? projectId(t.new.cwd) : t.new.project}`;
	return `${t.fork.session}@${t.edit?.uuid ?? t.at}`;
};

/** 请求里除了写的内容、选项以外的那些 */
function bodyOf(t: Target): Record<string, unknown> & { mode: string } {
	if ("new" in t) return { mode: "new", ...t.new };
	if ("resume" in t) {
		const { project, session } = t.resume;
		return t.fork ? { project, session, mode: "fork", at: t.fork.at } : { project, session, mode: "resume", at: null };
	}
	const { project, session } = t.fork;
	return t.at ? { project, session, mode: "fork", at: t.at } : { project, mode: "new" };
}

/** 下一条的模型：会话的看 lib/model.ts 的 modelFor（选过的；没选过接着上一条回复的系列），新会话是默认 */
const modelOf = (of: Of | null) => (of ? (modelFor(of.path, of.chosen) ?? "") : "");
const defaults = (of: Of | null): Choice => ({ model: modelOf(of), effort: of?.chosenEffort ?? "" });

/** 消息开头换成「/名字 」：原来就有一个 /xxx 的话替换掉 */
const withSkill = (text: string, name: string) => `/${name} ${text.replace(/^\/\S+\s*/, "")}`;

/** 发出去之后，输入框里去掉发出去的那段：请求还没回来时接着打的字留着 */
const unsent = (t: string, sent: string) => (t === sent ? "" : t.startsWith(sent) ? t.slice(sent.length).replace(/^\s+/, "") : t);

/** onSent：发出去了（继续的滚到底，分叉的关对话框，新会话的关对话框） */
export function usePrompt(t: Target, onSent?: () => void) {
	const { follow } = useLive();
	const of = "resume" in t ? t.resume : "new" in t ? null : t.fork;
	const edit = "fork" in t && !("resume" in t) ? t.edit : undefined;
	const [text, setText] = useDraft(draftKey(t), edit?.text);
	// 发件箱只管继续的：分叉、新会话开的是别的会话
	const track = useOutbox("resume" in t ? t.resume.session : null, ("resume" in t && t.record) || null, text, setText);
	const { shots, setShots, add, onPaste, drop } = useShots();
	const [permission, setPermission] = useState("auto");
	const [choice, setChoice] = useState(() => defaults(of));
	// 在别处（终端、另一个页面）换了模型：跟着变
	const model = of && modelOf(of);
	const effort = of && (of.chosenEffort ?? "");
	useEffect(() => { if (model !== null) setChoice((c) => ({ ...c, model })); }, [model]);
	useEffect(() => { if (effort !== null) setChoice((c) => ({ ...c, effort })); }, [effort]);
	// 编辑并分叉：原来那条带的图拿下来，和新选的一样能批注、去掉。拿到之前不让发
	const [loading, setLoading] = useState(!!edit?.images && !!of);
	useEffect(() => {
		if (!edit?.images || !of) return;
		let live = true;
		fromUrls(userImages(of.project, of.session, edit)).then((s) => {
			if (!live) return void s.forEach((x) => URL.revokeObjectURL(x.url));
			setShots((x) => [...s, ...x]);
			setLoading(false);
		});
		return () => { live = false; };
	}, []);
	const [skills, setSkills] = useState(false);
	const [busy, setBusy] = useState(false);
	const empty = !text.trim() && !shots.length;
	const send = async () => {
		if (empty || busy || loading) return;
		setBusy(true);
		// 请求在路上时还能接着打字、加图：回来之后只拿掉发出去的
		const sent = text;
		const sentShots = shots;
		// 这条的 uuid：服务端拿它当记录里那条的，发件箱按它认到没到
		const uuid = crypto.randomUUID();
		let box: ReturnType<typeof track> | null = null;
		try {
			const images = await Promise.all(sentShots.map(encode));
			const body = bodyOf(t);
			box = body.mode === "resume" ? track(uuid, sent) : null;
			const r = await start({ ...body, uuid, prompt: sent, images, permission, model: choice.model || null, effort: choice.effort || null }, follow);
			box?.sent(r);
			setText((x) => unsent(x, sent));
			drop(sentShots);
			onSent?.();
		} catch (e) {
			// 明确被拒（4xx）的这条不在服务端：发件箱里拿掉；没回来的（连不上、超时、502）可能其实发出去了，留着等运行、队列说了算
			box?.failed(e instanceof ApiError && !e.temporary);
			toast.error(`没发出去：${e instanceof Error ? e.message : String(e)}，消息还在输入框里`);
		} finally {
			setBusy(false);
		}
	};
	// skill 列表按项目拿；新会话的文件夹可能还没开过会话，带上路径
	const project = of?.project ?? ("new" in t ? ("cwd" in t.new ? projectId(t.new.cwd) : t.new.project) : "");
	const cwd = "new" in t && "cwd" in t.new ? t.new.cwd : undefined;
	return { of, text, setText, shots, setShots, add, onPaste, permission, setPermission, choice, setChoice, picking: skills, setPicking: setSkills, project, cwd, busy: busy || loading, empty, send };
}

export type Prompt = ReturnType<typeof usePrompt>;

/** 「+」：加图片、选 skill（列表在 skills.tsx，点了才加载） */
function AddMenu({ onAdd, onSkill }: { onAdd: (s: Shot[]) => void; onSkill: () => void }) {
	const file = useRef<HTMLInputElement>(null);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="加图片、选 skill" title="加图片、选 skill">
						<Plus className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuItem onSelect={() => file.current?.click()}>
						<ImagePlus />
						图片
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={onSkill}>
						<SquareSlash />
						skill
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<input
				ref={file}
				type="file"
				accept="image/*"
				multiple
				hidden
				onChange={(e) => {
					if (e.target.files) onAdd(toShots(e.target.files));
					e.target.value = "";
				}}
			/>
		</>
	);
}

/**
 * 上面是图，中间写字，下面一排：权限、模型、「+」，右边 children（继续的：后台任务、运行中、用量、上下文）和发送。
 * size：sm 是会话底下的（矮，聚焦时描边），lg 是新会话、分叉（高一些，聚焦时一圈光晕）。send：发送按钮的图标、说法
 */
export function PromptBox({ p, placeholder, size = "lg", autoFocus, send, children }: { p: Prompt; placeholder: string; size?: "sm" | "lg"; autoFocus?: boolean; send: { label: string; icon?: ReactNode; title?: string }; children?: ReactNode }) {
	const input = useRef<HTMLTextAreaElement>(null);
	const sm = size === "sm";
	const { choice, of } = p;
	return (
		<>
			<div className={sm ? "mx-auto flex w-full max-w-3xl flex-col gap-1 rounded-xl border bg-card p-1.5 shadow-xs transition-colors focus-within:border-ring" : "flex flex-col gap-2 rounded-xl border bg-card p-2 shadow-xs focus-within:ring-3 focus-within:ring-ring/30"}>
				<AttachStrip shots={p.shots} onChange={p.setShots} />
				<Textarea
					ref={input}
					autoFocus={autoFocus}
					value={p.text}
					onChange={(e) => {
						// 空输入框里打「/」：弹出 skill 列表
						if (!p.text && e.target.value === "/") return p.setPicking(true);
						p.setText(e.target.value);
					}}
					onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) p.send(); }}
					onPaste={p.onPaste}
					placeholder={placeholder}
					className={cn("resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent", sm ? "max-h-48 min-h-9" : "max-h-[40svh] min-h-24")}
				/>
				<div className={cn("flex items-center", sm ? "gap-1" : "gap-1.5")}>
					<PermissionSelect value={p.permission} onChange={p.setPermission} />
					<ModelSelect value={choice} onChange={p.setChoice} current={of && lastCtx(of.path)?.model} />
					<AddMenu onAdd={p.add} onSkill={() => p.setPicking(true)} />
					<span className="ml-auto" />
					{children}
					<Button size="icon" className="shrink-0 rounded-lg" disabled={p.empty || p.busy} onClick={p.send} aria-label={send.label} title={send.title}>
						{p.busy ? <Spinner /> : (send.icon ?? <Send className="size-4" />)}
					</Button>
				</div>
			</div>
			<SkillPicker
				project={p.project}
				cwd={p.cwd}
				open={p.picking}
				onOpenChange={p.setPicking}
				onPick={(name) => {
					p.setText((t) => withSkill(t, name));
					setTimeout(() => input.current?.focus(), 0);
				}}
			/>
		</>
	);
}
