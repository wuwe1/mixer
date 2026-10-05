// 一个会话：中间是对话和输入框；右边是面板（宽屏常开，窄屏从右边滑出来）：目录（你的消息）、文件、改动（默认只看这个会话改过的）。
// 打开着的会话跑完了，就算看过了。
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api, enc, type Node, type Session, type SessionMeta, type ToolNode } from "@/lib/api";
import { useEvent } from "@/lib/events";
import { useLive } from "@/lib/live";
import { go, type Panel, type Route, useWide } from "@/lib/route";
import { cn } from "@/lib/utils";
import { Changes } from "./changes";
import { Composer, Conversation, tree, walk } from "./conversation";
import { Files } from "./files";
import { edited } from "./message";

export const PANELS: { v: Panel; label: string }[] = [
	{ v: "outline", label: "目录" },
	{ v: "files", label: "文件" },
	{ v: "changes", label: "改动" },
];

/** 现在开着哪个面板：地址里没写时，宽屏开目录、窄屏不开 */
export const panelOf = (r: Route, wide: boolean): Panel | null => (r.panel === "none" ? null : (r.panel ?? (wide ? "outline" : null)));

export function SessionView({ project, root, session, r, meta }: { project: string; root: string | null; session: string; r: Route; meta: SessionMeta | undefined }) {
	const { status, queue, runs } = useLive();
	const wide = useWide();
	const [data, setData] = useState<Session | null>(null);
	const [error, setError] = useState<string | null>(null);
	const bottom = useRef<HTMLDivElement>(null);
	const first = useRef(true);

	// 跑的时候每 0.5 秒就有一次更新：上一次还没拉回来就先记下，回来了再拉一次（网慢也不会堆一串请求、旧的盖掉新的）
	const pulling = useRef<{ key: string; again: boolean } | null>(null);
	const load = useCallback(() => {
		const key = `${project}/${session}`;
		if (pulling.current?.key === key) return void (pulling.current.again = true);
		pulling.current = { key, again: false };
		const done = () => {
			const p = pulling.current;
			if (p?.key !== key) return;
			pulling.current = null;
			if (p.again) load();
		};
		api<Session>(`/api/sessions/${enc(project)}/${enc(session)}`).then(
			(d) => { if (pulling.current?.key === key) { setData(d); setError(null); } done(); },
			(e: Error) => { if (pulling.current?.key === key) setError(e.message); done(); },
		);
	}, [project, session]);
	useEffect(() => { setData(null); setError(null); first.current = true; load(); }, [load]);
	useEvent("session", useCallback((e: { project: string; id: string }) => { if (e.project === project && e.id === session) load(); }, [project, session, load]));
	useEvent("reconnect", load);

	const t = useMemo(() => (data ? tree(data.nodes) : null), [data]);
	const w = useMemo(() => (t ? walk(t, r.leaf) : null), [t, r.leaf]);
	// 状态用侧栏那份（看过之后会更新），还没有就用会话自己带的
	const st = status(meta ?? data?.meta ?? { id: session, active: false, unread: null });

	// 开着的会话跑完了（页面在前台）：算看过了
	useEffect(() => {
		const mark = () => { if ((st === "done" || st === "error") && document.visibilityState === "visible") api("/api/seen", { project, session }).catch(() => {}); };
		mark();
		document.addEventListener("visibilitychange", mark);
		return () => document.removeEventListener("visibilitychange", mark);
	}, [st, project, session]);

	// 第一次打开：滚到最后
	useEffect(() => {
		if (data && first.current) {
			first.current = false;
			requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: "end" }));
		}
	}, [data]);

	// 刚发出去的话（排上队了，或者开始跑了）：滚到最后让人看见
	const queued = queue.filter((q) => q.session === session).length;
	const running = runs.find((x) => x.session === session && x.status === "running")?.id;
	const seen = useRef({ queued, running });
	useEffect(() => {
		const before = seen.current;
		seen.current = { queued, running };
		if (queued > before.queued || (running && running !== before.running)) requestAnimationFrame(() => bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
	}, [queued, running]);

	const rel = useCallback((abs: string) => (root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null), [root]);
	const touched = useMemo(() => {
		const set = new Set<string>();
		for (const n of data?.nodes ?? []) {
			const p = n.k === "tool" ? edited(n as ToolNode) : null;
			const r2 = p ? rel(p) : null;
			if (r2) set.add(r2);
		}
		return [...set];
	}, [data, rel]);
	const onFile = (abs: string, diff: boolean) => {
		const p = rel(abs);
		if (!p) return void toast(`不在这个项目里：${abs}`);
		go({ panel: "files", file: p, view: diff ? "diff" : null });
	};

	if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
	const panel = panelOf(r, wide);
	const prompts = w?.path.filter((n): n is Extract<Node, { k: "user" }> => n.k === "user") ?? [];
	const jump = (uuid: string) => {
		if (!wide) go({ panel: "none" });
		requestAnimationFrame(() => document.getElementById(`n-${uuid}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
	};

	const body =
		panel === "outline" ? (
			<ScrollArea className="min-h-0 flex-1">
				<nav className="flex flex-col gap-0.5 p-2">
					{prompts.map((p, i) => (
						<button key={p.uuid} type="button" onClick={() => jump(p.uuid)} className="flex gap-2.5 rounded-md px-2 py-1.5 text-left text-md transition-colors hover:bg-accent">
							<span className="w-5 shrink-0 pt-px text-right text-2xs text-muted-foreground tabular-nums">{i + 1}</span>
							<span className="line-clamp-2 min-w-0 flex-1 leading-snug">{p.text || "（图片）"}</span>
						</button>
					))}
				</nav>
			</ScrollArea>
		) : panel === "files" ? (
			<Files project={project} file={r.file} view={r.view} />
		) : panel === "changes" ? (
			<Changes project={project} touched={touched} />
		) : null;
	const title = panel === "outline" ? `你的 ${prompts.length} 条消息` : PANELS.find((p) => p.v === panel)?.label;

	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* 原生滚动：shadcn 的 ScrollArea 里面是 display:table，长代码会把整栏撑宽 */}
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
					<div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 px-4 py-6 md:px-6">
						{t && w ? (
							<Conversation project={project} session={session} w={w} t={t} onFile={onFile} />
						) : (
							[0, 1, 2, 3].map((i) => <Skeleton key={i} className={cn("h-16", i % 2 ? "w-3/4" : "ml-auto w-2/3")} />)
						)}
						<div ref={bottom} />
					</div>
				</div>
				{w && <Composer project={project} session={session} w={w} status={st} />}
			</div>

			{wide && panel && (
				<aside className={cn("flex shrink-0 flex-col border-l", panel === "outline" ? "w-72" : "w-[min(44rem,45vw)]")}>
					<div className="flex h-11 shrink-0 items-center gap-2 border-b pr-1.5 pl-4 text-xs font-medium text-muted-foreground">
						<span className="flex-1">{title}</span>
						<Button variant="ghost" size="icon-sm" onClick={() => go({ panel: "none" })} aria-label="关掉面板">
							<X className="size-3.5" />
						</Button>
					</div>
					{body}
				</aside>
			)}
			{!wide && (
				<Sheet open={!!panel} onOpenChange={(o) => !o && go({ panel: "none" })}>
					<SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
						<SheetHeader className="border-b">
							<SheetTitle>{title}</SheetTitle>
							<SheetDescription className="sr-only">这个会话的{title}</SheetDescription>
						</SheetHeader>
						{body}
					</SheetContent>
				</Sheet>
			)}
		</div>
	);
}
