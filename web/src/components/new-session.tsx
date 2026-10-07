// 新会话：先选文件夹（从家目录开始，上面列着最近的项目；没开过会话的也行，可以当场新建），再写第一句话。会话一建好就跳过去。
import { ChevronLeft, Folder, FolderGit2, FolderPlus, History, MessageSquare, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, type Dirs, type Project, type Run } from "@/lib/api";
import { askNotify, useLive } from "@/lib/live";
import type { Agent } from "@/lib/model";
import { AttachStrip, encode, type Shot, toShots } from "./attach";
import { AddMenu, AgentModelSelect, type Choice, PermissionSelect } from "./composer";

/** 上次开新会话用的 agent（这台设备上） */
const AGENT_KEY = "mixer.agent";
const lastAgent = (): Agent => { try { return localStorage.getItem(AGENT_KEY) === "codex" ? "codex" : "claude"; } catch { return "claude"; } };

const tilde = (p: string, home: string) => (p === home ? "~" : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);

/** 按名字的子串筛（开头对上的排前面），不用 cmdk 默认的模糊匹配：打 repos 不该匹配到别的 */
export const match = (value: string, search: string) => {
	const v = value.toLowerCase();
	const q = search.toLowerCase().trim();
	return v.startsWith(q) ? 1 : v.includes(q) ? 0.5 : 0;
};

function Crumbs({ d, open }: { d: Dirs; open: (p: string) => void }) {
	const rel = d.path === d.home ? [] : d.path.slice(d.home.length + 1).split("/");
	return (
		<Breadcrumb>
			<BreadcrumbList className="gap-1 font-mono text-xs sm:gap-1">
				<BreadcrumbItem>
					{rel.length ? <BreadcrumbLink asChild><button type="button" onClick={() => open(d.home)}>~</button></BreadcrumbLink> : <BreadcrumbPage>~</BreadcrumbPage>}
				</BreadcrumbItem>
				{rel.map((seg, i) => (
					<span key={i} className="contents">
						<BreadcrumbSeparator>/</BreadcrumbSeparator>
						<BreadcrumbItem>
							{i < rel.length - 1 ? (
								<BreadcrumbLink asChild><button type="button" onClick={() => open(`${d.home}/${rel.slice(0, i + 1).join("/")}`)}>{seg}</button></BreadcrumbLink>
							) : (
								<BreadcrumbPage>{seg}</BreadcrumbPage>
							)}
						</BreadcrumbItem>
					</span>
				))}
			</BreadcrumbList>
		</Breadcrumb>
	);
}

function Picker({ start, projects, pick }: { start: string | null; projects: Project[]; pick: (path: string) => void }) {
	const [d, setD] = useState<Dirs | null>(null);
	const [q, setQ] = useState("");
	const open = useCallback((path: string) => {
		api<Dirs>(`/api/dirs?path=${encodeURIComponent(path)}`).then((x) => { setD(x); setQ(""); }, (e: Error) => toast.error(e.message));
	}, []);
	useEffect(() => open(start ?? ""), [open, start]);
	const create = async () => {
		if (!d) return;
		try {
			const r = await api<{ path: string }>("/api/dirs", { parent: d.path, name: q.trim() });
			open(r.path);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	};
	if (!d) return <div className="flex h-80 items-center justify-center"><Spinner className="text-muted-foreground" /></div>;
	const name = q.trim();
	const exact = d.entries.some((e) => e.name === name);
	const recent = d.path === d.home && !name ? projects.filter((p) => p.path?.startsWith(`${d.home}/`)).slice(0, 5) : [];
	return (
		<div className="flex min-h-0 flex-col gap-3">
			<Crumbs d={d} open={open} />
			<Command className="rounded-lg! border bg-transparent p-0" loop filter={match}>
				<CommandInput
					value={q}
					onValueChange={setQ}
					onKeyDown={(e) => { if (e.key === "Backspace" && !q && d.parent) open(d.parent); }}
					placeholder="筛选，或输入名字新建文件夹"
				/>
				<CommandList className="max-h-[min(20rem,45svh)]">
					<CommandEmpty className="py-5 text-md text-muted-foreground">{name ? "没有匹配的文件夹" : "这里没有子文件夹"}</CommandEmpty>
					{recent.length > 0 && (
						<CommandGroup heading="最近的项目">
							{recent.map((p) => (
								<CommandItem key={p.id} value={`recent ${p.path}`} onSelect={() => pick(p.path!)}>
									<History className="text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate font-mono text-md">{tilde(p.path!, d.home)}</span>
								</CommandItem>
							))}
						</CommandGroup>
					)}
					<CommandGroup heading={recent.length ? "文件夹" : undefined}>
						{d.entries.map((e) => (
							<CommandItem key={e.path} value={e.name} onSelect={() => open(e.path)}>
								{e.git ? <FolderGit2 className="text-muted-foreground" /> : <Folder className="text-muted-foreground" />}
								<span className="min-w-0 flex-1 truncate text-md">{e.name}</span>
								{e.project && <MessageSquare className="size-3.5! text-muted-foreground" aria-label="有会话" />}
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
			</Command>
			{/* 新建要明确点一下：回车只用来进文件夹，打错字不会建出一堆空文件夹 */}
			{name && !exact && (
				<Button variant="outline" size="sm" className="justify-start gap-2 font-normal" onClick={create}>
					<FolderPlus className="size-4 text-muted-foreground" />
					<span className="truncate">在 {tilde(d.path, d.home)} 里新建 <span className="font-mono font-medium">{name}</span></span>
				</Button>
			)}
			<div className="flex items-center justify-end gap-2">
				{d.git && <Badge variant="outline">git</Badge>}
				<Button size="sm" onClick={() => pick(d.path)}>选择此文件夹</Button>
			</div>
		</div>
	);
}

/** 写第一句话（可以带图：选图或粘贴）、选权限、模型（连带 agent：Claude Code / Codex），开始：在一个文件夹（cwd）或一个已有的项目（project）里开新会话。lead：放在提示语前面 */
export function StartBox({ target, autoFocus, lead, onStarted }: { target: { cwd: string } | { project: string }; autoFocus?: boolean; lead?: string; onStarted?: () => void }) {
	const { follow } = useLive();
	const [agent, setAgent] = useState<Agent>(lastAgent);
	const pick = (c: Choice) => {
		setAgent(c.agent);
		setModel(c.model);
		setEffort(c.effort);
		try { localStorage.setItem(AGENT_KEY, c.agent); } catch {}
	};
	const [text, setText] = useState("");
	const [permission, setPermission] = useState("auto");
	const [model, setModel] = useState("");
	const [effort, setEffort] = useState("");
	const [busy, setBusy] = useState(false);
	const [shots, setShots] = useState<Shot[]>([]);
	const empty = !text.trim() && !shots.length;
	const send = async () => {
		if (empty || busy) return;
		setBusy(true);
		try {
			askNotify();
			const images = await Promise.all(shots.map(encode));
			const r = await api<Run>("/api/runs", { mode: "new", ...target, agent, prompt: text, images, permission, model: model || null, effort: effort || null });
			follow(r);
			setText("");
			for (const s of shots) URL.revokeObjectURL(s.url);
			setShots([]);
			toast.success("已开始，建好后自动打开");
			onStarted?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-2 rounded-xl border bg-card p-2 shadow-xs focus-within:ring-3 focus-within:ring-ring/30">
			<AttachStrip shots={shots} onChange={setShots} />
			<Textarea
				autoFocus={autoFocus}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
				onPaste={(e) => {
					const s = toShots(e.clipboardData.files);
					if (s.length) { e.preventDefault(); setShots((x) => [...x, ...s]); }
				}}
				placeholder={`${lead ?? ""}要 ${agent === "codex" ? "Codex" : "Claude"} 做什么……`}
				className="max-h-[40svh] min-h-24 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
			/>
			<div className="flex items-center gap-1.5">
				<PermissionSelect value={permission} onChange={setPermission} />
				<AgentModelSelect value={{ agent, model, effort }} onChange={pick} />
				<AddMenu onAdd={(s) => setShots((x) => [...x, ...s])} />
				<Button size="icon" className="ml-auto rounded-lg" disabled={empty || busy} onClick={send} aria-label="开始">
					{busy ? <Spinner /> : <Send className="size-4" />}
				</Button>
			</div>
		</div>
	);
}

export function NewSession({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const [cwd, setCwd] = useState<string | null>(null);
	const [last, setLast] = useState<string | null>(null);
	// 最近的项目：有会话记录的文件夹，按最近修改排（不用扫会话，快）
	const [projects, setProjects] = useState<Project[]>([]);
	useEffect(() => {
		if (!open) return;
		setCwd(null);
		setLast(null);
		api<Project[]>("/api/projects").then(setProjects, () => {});
	}, [open]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="top-[max(1rem,env(safe-area-inset-top))] translate-y-0 gap-4 sm:top-[12vh] sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>新会话</DialogTitle>
					<DialogDescription className="sr-only">选择一个文件夹，在那里开始新会话</DialogDescription>
				</DialogHeader>
				{cwd ? (
					<div className="flex flex-col gap-3">
						<div className="flex min-w-0 items-center gap-1">
							<Button variant="ghost" size="icon-sm" className="-ml-1.5 shrink-0" onClick={() => { setLast(cwd); setCwd(null); }} aria-label="换文件夹">
								<ChevronLeft className="size-4" />
							</Button>
							<span className="truncate font-mono text-xs text-muted-foreground">{cwd}</span>
						</div>
						<StartBox target={{ cwd }} autoFocus onStarted={() => onOpenChange(false)} />
					</div>
				) : (
					<Picker start={last} projects={projects} pick={setCwd} />
				)}
			</DialogContent>
		</Dialog>
	);
}
