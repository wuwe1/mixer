// 改动，照 magit 的路子：一列到底，节、文件、提交都在原地展开。
// 顶上一行是分支和远端（领先 ↑ / 落后 ↓）；下面是：未提交的改动（在会话里分成「这个会话改的」和「其他」）、未推送的提交、最近的提交。
// 文件那行就是它 diff 的标题（展开时贴在顶上）：状态字母、路径（文件名突出）、加减了几行。提交展开是说明和它改的文件。
// 第一次打开时，主要那一节改得不多（≤ 5 个文件、每个 ≤ 200 行）就直接把 diff 摊开，不用一个个点。
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, GitBranch } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Change, type Commit, enc, type Status } from "@/lib/api";
import { type FileDiff, parseDiff } from "@/lib/diff";
import { useEvent } from "@/lib/events";
import { go } from "@/lib/route";
import { clock, since } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Hunks } from "./diff";
import { Placeholder } from "./placeholder";

const KIND: Record<string, { letter: string; label: string; cls: string }> = {
	M: { letter: "M", label: "修改", cls: "text-modified" },
	A: { letter: "A", label: "新增", cls: "text-added" },
	D: { letter: "D", label: "删除", cls: "text-removed" },
	R: { letter: "R", label: "重命名", cls: "text-renamed" },
	"?": { letter: "U", label: "新文件（还没进 git）", cls: "text-added" },
};
// porcelain 的两位：前一位是暂存区比 HEAD，后一位是工作区比暂存区。合起来看和 HEAD 比是什么
const kindOf = (code: string) => KIND[code[1] === "D" ? "D" : code[0] !== " " ? code[0] : code[1]] ?? KIND.M;

const Chevron = ({ open }: { open: boolean }) => <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />;

function Stat({ add, del }: { add?: number; del?: number }) {
	return (
		<span className="flex shrink-0 gap-1 font-mono text-2xs tabular-nums">
			{!!add && <span className="text-added">+{add}</span>}
			{!!del && <span className="text-removed">−{del}</span>}
		</span>
	);
}

/** 路径：目录灰、文件名正常；太长先截目录 */
function Path({ path }: { path: string }) {
	const i = path.lastIndexOf("/");
	return (
		<span className="flex min-w-0 flex-1 overflow-hidden font-mono text-xs">
			<span className="truncate text-muted-foreground">{path.slice(0, i + 1)}</span>
			<span className="shrink-0">{path.slice(i + 1)}</span>
		</span>
	);
}

function Section({ title, stat, open, onToggle, children }: { title: string; stat?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
	return (
		<section className="flex flex-col">
			<button type="button" onClick={onToggle} className="flex items-center gap-1.5 px-2 pt-3 pb-1 text-left text-2xs font-medium text-muted-foreground hover:text-foreground">
				<Chevron open={open} />
				<span className="flex-1">{title}</span>
				{stat}
			</button>
			{open && children}
		</section>
	);
}

/** 一个文件：那一行是它 diff 的标题，展开时贴在顶上 */
function FileRow({ code, path, add, del, open, onToggle, indent, children }: { code: string; path: string; add?: number; del?: number; open: boolean; onToggle: () => void; indent?: boolean; children: ReactNode }) {
	const k = KIND[code] ?? kindOf(code);
	return (
		<div className={cn(open && "border-b")}>
			<div className={cn("group flex items-center pr-1 hover:bg-accent", open && "sticky top-0 z-10 border-b bg-background")}>
				<button type="button" onClick={onToggle} className={cn("flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left", indent ? "pl-6" : "pl-2")}>
					<Chevron open={open} />
					<span className={cn("w-3 shrink-0 font-mono text-2xs font-medium", k.cls)} title={k.label}>{k.letter}</span>
					<Path path={path} />
					<Stat add={add} del={del} />
				</button>
				{k.letter !== "D" && !indent && (
					<Button variant="ghost" size="icon-xs" className={cn("text-muted-foreground", !open && "invisible group-hover:visible")} onClick={() => go({ panel: "files", file: path, view: null })} title="在「文件」里打开" aria-label="在文件里打开">
						<FileText className="size-3.5" />
					</Button>
				)}
			</div>
			{open && children}
		</div>
	);
}

const Note = ({ children }: { children: ReactNode }) => <p className="px-3 py-2 text-xs text-muted-foreground">{children}</p>;

/** 未提交的一个文件：展开时取它的 diff；状态里它这一条变了（状态、加减行数）再取一次，取到之前先显示旧的 */
function WorkFile({ project, c, open, onToggle }: { project: string; c: Change; open: boolean; onToggle: () => void }) {
	const [d, setD] = useState<FileDiff | string | null>(null);
	useEffect(() => {
		if (!open) return;
		let live = true;
		api<{ diff: string }>(`/api/repo/${enc(project)}/diff?path=${enc(c.path)}`).then(
			(r) => live && setD(parseDiff(r.diff)[0] ?? "文件太大，不显示"),
			(e: Error) => live && setD(e.message),
		);
		return () => { live = false; };
	}, [open, project, c.path, c.code, c.add, c.del]);
	return (
		<FileRow code={c.code} path={c.path} add={c.add} del={c.del} open={open} onToggle={onToggle}>
			{d === null ? <Skeleton className="m-3 h-16" /> : typeof d === "string" ? <Note>{d}</Note> : <Hunks file={d} />}
		</FileRow>
	);
}

type Detail = { hash: string; author: string; when: string; body: string; files: FileDiff[] };

/** 一个提交：一行是标题和时间；展开是哈希、作者、说明的正文，和它改的文件（各自再展开看 diff） */
function CommitRow({ project, c, open, onToggle, isOpen, toggle }: { project: string; c: Commit; open: boolean; onToggle: () => void; isOpen: (k: string) => boolean; toggle: (k: string) => void }) {
	const [d, setD] = useState<Detail | string | null>(null);
	useEffect(() => {
		if (!open || d) return;
		api<Omit<Detail, "files"> & { diff: string }>(`/api/repo/${enc(project)}/commit/${c.hash}`).then(
			({ diff, ...r }) => setD({ ...r, files: parseDiff(diff) }),
			(e: Error) => setD(e.message),
		);
	}, [open, d, project, c.hash]);
	const rest = typeof d === "object" && d ? d.body.split("\n").slice(1).join("\n").trim() : "";
	return (
		<div>
			<button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 py-1 pr-3 pl-2 text-left text-md hover:bg-accent">
				<Chevron open={open} />
				<span className="min-w-0 flex-1 truncate">{c.subject}</span>
				<span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{since(c.when)}</span>
			</button>
			{open &&
				(d === null ? (
					<Skeleton className="mx-3 my-2 h-10" />
				) : typeof d === "string" ? (
					<Note>{d}</Note>
				) : (
					<div className="flex flex-col pb-2">
						<div className="flex flex-col gap-1 pt-0.5 pr-3 pb-1.5 pl-6 text-2xs text-muted-foreground">
							<span>
								<span className="font-mono">{c.hash}</span> · {d.author} · {clock(d.when)}
							</span>
							{rest && <p className="text-xs whitespace-pre-wrap">{rest}</p>}
						</div>
						{d.files.map((f) => {
							const k = `c:${c.hash}:${f.path}`;
							return (
								<FileRow key={f.path} code={f.kind} path={f.path} add={f.add} del={f.del} open={isOpen(k)} onToggle={() => toggle(k)} indent>
									<Hunks file={f} />
								</FileRow>
							);
						})}
					</div>
				))}
		</div>
	);
}

const total = (cs: Change[]) => <Stat add={cs.reduce((n, c) => n + (c.add ?? 0), 0)} del={cs.reduce((n, c) => n + (c.del ?? 0), 0)} />;

export function Changes({ project, touched }: { project: string; touched?: string[] }) {
	const [s, setS] = useState<Status | null>(null);
	// 展开着的：节「§…」、未提交的文件「w:路径」、提交「c:哈希」、提交里的文件「c:哈希:路径」。第一次取到状态时定默认
	const [opened, setOpened] = useState<Set<string> | null>(null);
	const touchedRef = useRef(touched);
	touchedRef.current = touched;
	const load = useCallback(() => {
		api<Status>(`/api/repo/${enc(project)}/status`).then(
			(x) => {
				// 跑的时候会话一变就来取（一秒最多两次），多半没变：没变就留着原来的，什么都不重画、不重取
				setS((o) => (o && JSON.stringify(o) === JSON.stringify(x) ? o : x));
				setOpened((o) => o ?? initial(x, touchedRef.current));
			},
			() => setS({ git: false }),
		);
	}, [project]);
	useEffect(() => { setS(null); setOpened(null); load(); }, [load]);
	useEvent("session", useCallback((e: { project: string }) => { if (e.project === project) load(); }, [project, load]));

	if (!s || (s.git && !opened)) return <div className="flex flex-col gap-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-6" />)}</div>;
	if (!s.git) return <Placeholder icon={GitBranch} title="不是 git 仓库" text="这个目录不在 git 里，没有改动和提交可看。" />;
	const open = opened ?? new Set<string>();
	const isOpen = (k: string) => open.has(k);
	const toggle = (k: string) => setOpened((o) => {
		const n = new Set(o);
		if (!n.delete(k)) n.add(k);
		return n;
	});

	const { mine, other } = split(s.changes, touched);
	const local = s.log.filter((c) => c.local);
	const older = s.log.filter((c) => !c.local);
	const work = s.changes.map((c) => `w:${c.path}`);
	const allOpen = work.length > 0 && work.every(isOpen);
	const setAll = () => setOpened((o) => {
		if (allOpen) return new Set([...(o ?? [])].filter((k) => k.startsWith("§")));
		return new Set([...(o ?? []), "§mine", "§other", ...work]);
	});
	const files = (cs: Change[]) => cs.map((c) => <WorkFile key={c.path} project={project} c={c} open={isOpen(`w:${c.path}`)} onToggle={() => toggle(`w:${c.path}`)} />);
	const commits = (cs: Commit[]) => cs.map((c) => <CommitRow key={c.hash} project={project} c={c} open={isOpen(`c:${c.hash}`)} onToggle={() => toggle(`c:${c.hash}`)} isOpen={isOpen} toggle={toggle} />);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex h-9 shrink-0 items-center gap-1.5 border-b pr-1 pl-3 text-xs">
				<GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate font-mono">{s.branch}</span>
				{s.upstream && <span className="truncate font-mono text-muted-foreground">→ {s.upstream}</span>}
				{(s.ahead > 0 || s.behind > 0) && (
					<span className="shrink-0 text-2xs text-muted-foreground tabular-nums" title={`比 ${s.upstream} 多 ${s.ahead} 个提交、少 ${s.behind} 个`}>
						{s.ahead > 0 && `↑${s.ahead}`} {s.behind > 0 && `↓${s.behind}`}
					</span>
				)}
				<Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground" disabled={!work.length} onClick={setAll} title={allOpen ? "收起所有改动" : "展开所有改动"} aria-label={allOpen ? "收起所有改动" : "展开所有改动"}>
					{allOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
				</Button>
			</div>
			{/* 原生滚动：ScrollArea 里面是 display:table，长的 diff 行会把整栏撑宽 */}
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
				<Section title={`${touched ? "这个会话改的" : "未提交的改动"} · ${mine.length}`} stat={total(mine)} open={isOpen("§mine")} onToggle={() => toggle("§mine")}>
					{mine.length ? files(mine) : <Note>{touched ? "这个会话没有改文件" : "没有未提交的改动"}</Note>}
				</Section>
				{other.length > 0 && (
					<Section title={`其他未提交的改动 · ${other.length}`} stat={total(other)} open={isOpen("§other")} onToggle={() => toggle("§other")}>
						{files(other)}
					</Section>
				)}
				{local.length > 0 && (
					<Section title={`未推送到 ${s.upstream} · ${local.length}`} open={isOpen("§local")} onToggle={() => toggle("§local")}>
						{commits(local)}
					</Section>
				)}
				{older.length > 0 && (
					<Section title="最近的提交" open={isOpen("§log")} onToggle={() => toggle("§log")}>
						{commits(older)}
					</Section>
				)}
			</div>
		</div>
	);
}

/** 在会话里：这个会话改过的文件放一节，其余的放「其他」；在项目页：都算一节 */
function split(changes: Change[], touched?: string[]) {
	if (!touched) return { mine: changes, other: [] };
	return { mine: changes.filter((c) => touched.includes(c.path)), other: changes.filter((c) => !touched.includes(c.path)) };
}

/** 第一次打开时展开什么：节都开（会话里这个会话有改动时，「其他」收着）；主要那一节改得不多就把文件也摊开 */
function initial(s: Status, touched?: string[]) {
	const o = new Set(["§mine", "§local", "§log"]);
	if (!s.git) return o;
	const { mine } = split(s.changes, touched);
	if (!touched || !mine.length) o.add("§other");
	if (mine.length <= 5 && mine.every((c) => (c.add ?? 0) + (c.del ?? 0) <= 200)) for (const c of mine) o.add(`w:${c.path}`);
	return o;
}
