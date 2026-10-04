// 新会话：先选文件夹（从家目录开始，上面列着最近的项目；没开过会话的也行，可以当场新建），再写第一句话。会话一建好就跳过去。
import { ChevronLeft, Folder, FolderGit2, FolderPlus, History, Loader2, MessageSquare, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type Dirs, type Project, type Run } from "@/lib/api";
import { useEvent } from "@/lib/events";
import { go } from "@/lib/route";
import { PERMISSIONS } from "./conversation";

const tilde = (p: string, home: string) => (p === home ? "~" : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);

/** 按名字的子串筛（开头对上的排前面），不用 cmdk 默认的模糊匹配：打 repos 不该匹配到别的 */
const match = (value: string, search: string) => {
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
	if (!d) return <div className="flex h-80 items-center justify-center"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>;
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
					<CommandEmpty className="py-5 text-[13px] text-muted-foreground">{name ? "没有匹配的文件夹" : "这里没有子文件夹"}</CommandEmpty>
					{recent.length > 0 && (
						<CommandGroup heading="最近的项目">
							{recent.map((p) => (
								<CommandItem key={p.id} value={`recent ${p.path}`} onSelect={() => pick(p.path!)}>
									<History className="text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate font-mono text-[13px]">{tilde(p.path!, d.home)}</span>
								</CommandItem>
							))}
						</CommandGroup>
					)}
					<CommandGroup heading={recent.length ? "文件夹" : undefined}>
						{d.entries.map((e) => (
							<CommandItem key={e.path} value={e.name} onSelect={() => open(e.path)}>
								{e.git ? <FolderGit2 className="text-muted-foreground" /> : <Folder className="text-muted-foreground" />}
								<span className="min-w-0 flex-1 truncate text-[13px]">{e.name}</span>
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
				<Button size="sm" onClick={() => pick(d.path)}>在这里开</Button>
			</div>
		</div>
	);
}

function Prompt({ cwd, back, started }: { cwd: string; back: () => void; started: (r: Run) => void }) {
	const [text, setText] = useState("");
	const [permission, setPermission] = useState("default");
	const [busy, setBusy] = useState(false);
	const send = async () => {
		if (!text.trim() || busy) return;
		setBusy(true);
		try {
			started(await api<Run>("/api/runs", { mode: "new", cwd, prompt: text, permission }));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-3">
			<div className="flex min-w-0 items-center gap-1">
				<Button variant="ghost" size="icon" className="-ml-1.5 size-7 shrink-0" onClick={back} aria-label="换文件夹">
					<ChevronLeft className="size-4" />
				</Button>
				<span className="truncate font-mono text-xs text-muted-foreground">{cwd}</span>
			</div>
			<div className="flex flex-col gap-2 rounded-xl border bg-card p-2 shadow-xs focus-within:ring-[3px] focus-within:ring-ring/30">
				<Textarea
					autoFocus
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
					placeholder="要 Claude 做什么……"
					className="max-h-[40svh] min-h-28 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<div className="flex items-center gap-1.5">
					<Select value={permission} onValueChange={setPermission}>
						<SelectTrigger size="sm" className="h-7 w-auto gap-1.5 border-0 bg-muted/60 px-2 text-xs shadow-none">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PERMISSIONS.map((p) => <SelectItem key={p.v} value={p.v}>{p.label}</SelectItem>)}
						</SelectContent>
					</Select>
					<Button size="icon" className="ml-auto size-8 rounded-lg" disabled={!text.trim() || busy} onClick={send} aria-label="开始">
						{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
					</Button>
				</div>
			</div>
		</div>
	);
}

export function NewSession({ open, onOpenChange, projects }: { open: boolean; onOpenChange: (o: boolean) => void; projects: Project[] }) {
	const [cwd, setCwd] = useState<string | null>(null);
	const [last, setLast] = useState<string | null>(null);
	const [run, setRun] = useState<Run | null>(null);
	useEffect(() => { if (open) { setCwd(null); setLast(null); } }, [open]);
	// 会话 id 一出来就跳过去（对话框关了也还在听）
	useEvent("run", useCallback((r: Run) => {
		if (!run || r.id !== run.id || !r.session) return;
		go({ project: r.project, session: r.session, tab: "chat", leaf: null, file: null });
		setRun(null);
	}, [run]));
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="top-[max(1rem,env(safe-area-inset-top))] translate-y-0 gap-4 sm:top-[12vh] sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>新会话</DialogTitle>
					<DialogDescription className="sr-only">选一个文件夹，Claude 在那里开一个新会话</DialogDescription>
				</DialogHeader>
				{cwd ? (
					<Prompt cwd={cwd} back={() => { setLast(cwd); setCwd(null); }} started={(r) => { setRun(r); onOpenChange(false); toast.success("开始了：会话一建好就跳过去"); }} />
				) : (
					<Picker start={last} projects={projects} pick={setCwd} />
				)}
			</DialogContent>
		</Dialog>
	);
}
