// 文件：左边是目录树（可筛选），右边看文件（代码高亮带行号；Markdown 能切预览；能看它没提交的改动；图片直接显示）。
// 按容器宽度排：放在窄的面板里、手机上，先看树，点了文件再看内容。
import { ChevronLeft, ChevronRight, File, Folder, FolderOpen, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, enc, type RepoFile } from "@/lib/api";
import { Diff } from "./changes";
import { go } from "@/lib/route";
import { bytes } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Code, langOf } from "./code";
import { Images } from "./lightbox";
import { Markdown } from "./markdown";
import { Placeholder } from "./placeholder";

type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: string[] };

function build(paths: string[]): Dir {
	const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
	for (const p of paths) {
		const parts = p.split("/");
		let d = root;
		for (const part of parts.slice(0, -1)) {
			let next = d.dirs.get(part);
			if (!next) {
				next = { name: part, path: d.path ? `${d.path}/${part}` : part, dirs: new Map(), files: [] };
				d.dirs.set(part, next);
			}
			d = next;
		}
		d.files.push(p);
	}
	return root;
}

function TreeView({ dir, depth, open, toggle, current }: { dir: Dir; depth: number; open: Set<string>; toggle: (p: string) => void; current: string | null }) {
	const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
	return (
		<>
			{dirs.map((d) => {
				const o = open.has(d.path);
				return (
					<div key={d.path}>
						<button type="button" onClick={() => toggle(d.path)} className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-md hover:bg-accent" style={{ paddingLeft: 8 + depth * 14 }}>
							<ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", o && "rotate-90")} />
							{o ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /> : <Folder className="size-3.5 shrink-0 text-muted-foreground" />}
							<span className="truncate">{d.name}</span>
						</button>
						{o && <TreeView dir={d} depth={depth + 1} open={open} toggle={toggle} current={current} />}
					</div>
				);
			})}
			{dir.files.sort().map((f) => (
				<button
					key={f}
					type="button"
					onClick={() => go({ file: f }, false)}
					className={cn("flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-md hover:bg-accent", current === f && "bg-accent font-medium")}
					style={{ paddingLeft: 8 + depth * 14 + 15 }}
				>
					<File className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="truncate">{f.split("/").pop()}</span>
				</button>
			))}
		</>
	);
}

export function Files({ project, file, view }: { project: string; file: string | null; view: "diff" | null }) {
	const [list, setList] = useState<string[] | null>(null);
	const [q, setQ] = useState("");
	const [open, setOpen] = useState<Set<string>>(new Set());
	useEffect(() => {
		setList(null);
		api<{ files: string[] }>(`/api/repo/${enc(project)}/files`).then((r) => setList(r.files), () => setList([]));
	}, [project]);
	// 打开文件时，把它所在的目录都展开
	useEffect(() => {
		if (!file) return;
		const parts = file.split("/").slice(0, -1);
		setOpen((o) => new Set([...o, ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))]));
	}, [file]);
	const shown = useMemo(() => (list ?? []).filter((f) => !q || f.toLowerCase().includes(q.toLowerCase())), [list, q]);
	const root = useMemo(() => build(shown), [shown]);
	const toggle = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n; });
	const filtering = q.length > 0;

	return (
		<div className="@container/files flex min-h-0 flex-1">
			<div className={cn("flex w-full shrink-0 flex-col @3xl/files:w-72 @3xl/files:border-r", file && "@max-3xl/files:hidden")}>
				<div className="relative border-b p-2">
					<Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选文件" className="h-8 pl-7 text-md" />
				</div>
				<ScrollArea className="min-h-0 flex-1">
					<div className="p-1.5">
						{!list && [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="my-1 h-6" />)}
						{list && filtering &&
							shown.slice(0, 300).map((f) => (
								<button key={f} type="button" onClick={() => go({ file: f })} className={cn("flex w-full flex-col rounded-md px-2 py-1 text-left hover:bg-accent", file === f && "bg-accent")}>
									<span className="truncate text-md">{f.split("/").pop()}</span>
									<span className="truncate text-2xs text-muted-foreground">{f}</span>
								</button>
							))}
						{list && !filtering && <TreeView dir={root} depth={0} open={open} toggle={toggle} current={file} />}
					</div>
				</ScrollArea>
				{list && <div className="border-t px-3 py-1.5 text-2xs text-muted-foreground tabular-nums">{list.length} 个文件</div>}
			</div>
			<div className={cn("flex min-w-0 flex-1 flex-col", !file && "@max-3xl/files:hidden")}>
				{file ? <Viewer project={project} path={file} view={view} /> : <Placeholder icon={File} text="选择一个文件" />}
			</div>
		</div>
	);
}

function Viewer({ project, path, view }: { project: string; path: string; view: "diff" | null }) {
	const [f, setF] = useState<RepoFile | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [diff, setDiff] = useState<string | null>(null);
	const isMd = /\.md$/i.test(path);
	const initial = view === "diff" ? "diff" : isMd ? "preview" : "source";
	const [mode, setMode] = useState<"source" | "preview" | "diff">(initial);
	useEffect(() => {
		setF(null);
		setErr(null);
		setDiff(null);
		setMode(initial);
		api<RepoFile>(`/api/repo/${enc(project)}/file?path=${enc(path)}`).then(setF, (e: Error) => setErr(e.message));
	}, [project, path, initial]);
	useEffect(() => {
		if (mode === "diff" && diff === null) api<{ diff: string }>(`/api/repo/${enc(project)}/diff?path=${enc(path)}`).then((r) => setDiff(r.diff), () => setDiff(""));
	}, [mode, diff, project, path]);
	const raw = `/api/repo/${enc(project)}/raw?path=${enc(path)}`;
	return (
		<>
			<div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
				<Button variant="ghost" size="icon-sm" className="@3xl/files:hidden" onClick={() => go({ file: null, view: null })} aria-label="返回">
					<ChevronLeft className="size-4" />
				</Button>
				<span className="min-w-0 truncate font-mono text-xs">{path}</span>
				{f && <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{bytes(f.size)}</span>}
				{(f?.kind === "text" || mode === "diff") && (
					<ToggleGroup type="single" size="sm" value={mode} onValueChange={(v) => v && setMode(v as typeof mode)} className="ml-auto">
						{isMd && <ToggleGroupItem value="preview" className="h-7 px-2 text-xs">预览</ToggleGroupItem>}
						<ToggleGroupItem value="source" className="h-7 px-2 text-xs">源码</ToggleGroupItem>
						<ToggleGroupItem value="diff" className="h-7 px-2 text-xs">改动</ToggleGroupItem>
					</ToggleGroup>
				)}
			</div>
			{/* 原生滚动：ScrollArea 只有竖的滚动条，长行没法往右滑 */}
			<div className="min-h-0 flex-1 overflow-auto overscroll-contain">
				{mode === "diff" ? (
					diff === null ? <Skeleton className="m-4 h-40" /> : diff ? <Diff text={diff} /> : <p className="p-4 text-sm text-muted-foreground">这个文件没有未提交的改动。</p>
				) : (
				<>
				{err && <p className="p-4 text-sm text-destructive">{err}</p>}
				{!f && !err && <div className="flex flex-col gap-2 p-4">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-4" style={{ width: `${40 + ((i * 37) % 55)}%` }} />)}</div>}
				{f?.kind === "image" && <Images srcs={[raw]} className="m-4" imgClassName="max-h-none" />}
				{(f?.kind === "binary" || f?.kind === "large") && <p className="p-4 text-sm text-muted-foreground">{f.kind === "binary" ? "二进制文件" : "文件太大"}，不显示。<a href={raw} className="underline">下载</a></p>}
				{f?.kind === "text" && (mode === "preview" ? (
					<div className="mx-auto max-w-3xl p-6"><Markdown text={f.text} /></div>
				) : (
					<Code code={f.text} lang={langOf(path)} lines className="min-w-max py-3 pr-6" />
				))}
				</>
				)}
			</div>
		</>
	);
}
