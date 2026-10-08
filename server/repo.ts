// 读一个项目的仓库：文件列表（git 管的 + 没被忽略的新文件）、文件内容、git 状态、改动、最近的提交。只读。
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

// quotePath=false：中文文件名原样给，不转成 "\346\226…"。stderr 收着不打出来（「not a git repository」这种会刷满日志）
const GIT = (root: string, args: string[]) => ["-C", root, "-c", "core.quotePath=false", ...args];
/** 不卡住服务的 git：同步跑会把别的请求、推送都挡住（文件列表大的仓库要好一会儿） */
const run = promisify(execFile);
const gitAsync = async (root: string, args: string[]) => (await run("git", GIT(root, args), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
const tryGitAsync = (root: string, args: string[]) => gitAsync(root, args).catch(() => "");

/** 真实路径；还不存在的（比如删掉了的文件）取最近一层存在的上级的真实路径，再接上后面的 */
const real = (f: string): string => (existsSync(f) ? realpathSync(f) : dirname(f) === f ? f : join(real(dirname(f)), basename(f)));
/** 路径只许在仓库里面（防 ../ 和软链接逃出去） */
export function inside(root: string, rel: string): string {
	const f = join(root, rel);
	const p = real(f);
	const r = realpathSync(root);
	if (p !== r && !p.startsWith(r + sep)) throw Object.assign(new Error("路径不在仓库里"), { status: 403 });
	return f;
}

const isGit = async (root: string) => (await tryGitAsync(root, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";

export async function files(root: string): Promise<string[]> {
	if (await isGit(root)) return (await gitAsync(root, ["ls-files", "-co", "--exclude-standard"])).split("\n").filter(Boolean).sort();
	// 不是 git 仓库（家目录这种）：自己走一遍，异步的（不挡别的请求、推送）。跳过隐藏的文件夹、常见的大目录、Library；
	// 读不了的文件夹（没权限、macOS 保护的）跳过，不让整个列表出错；最多 2 万个
	const out: string[] = [];
	const skip = new Set(["node_modules", "dist", "build", ".venv", "venv", "__pycache__", "Library", "target"]);
	const walk = async (dir: string) => {
		let ds: import("node:fs").Dirent[];
		try { ds = await readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const d of ds) {
			if (out.length >= 20000) return;
			if (skip.has(d.name) || (d.isDirectory() && d.name.startsWith("."))) continue;
			const f = join(dir, d.name);
			if (d.isDirectory()) await walk(f);
			else if (d.isFile()) out.push(relative(root, f));
		}
	};
	await walk(root);
	return out.sort();
}

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export function file(root: string, rel: string) {
	const f = inside(root, rel);
	const st = statSync(f);
	if (IMAGE.has(extname(f).toLowerCase())) return { kind: "image" as const, size: st.size };
	if (st.size > 2 * 1024 * 1024) return { kind: "large" as const, size: st.size };
	const buf = readFileSync(f);
	if (buf.subarray(0, 8000).includes(0)) return { kind: "binary" as const, size: st.size };
	return { kind: "text" as const, size: st.size, text: buf.toString("utf8") };
}

/** 一个新文件有几行：256KB 以内的文本才数 */
async function newLines(root: string, rel: string) {
	try {
		const f = inside(root, rel);
		if (IMAGE.has(extname(f).toLowerCase()) || (await stat(f)).size > 256 * 1024) return null;
		const buf = await readFile(f);
		if (buf.subarray(0, 8000).includes(0)) return null;
		const text = buf.toString("utf8");
		return { add: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), del: 0 };
	} catch {
		return null;
	}
}

// 还没有提交的仓库没有 HEAD，跟空树比
const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const base = async (root: string) => ((await tryGitAsync(root, ["rev-parse", "--verify", "-q", "HEAD"])) ? "HEAD" : EMPTY);

/** git 状态：同一个仓库同时来的请求等同一次，结果留 1.5 秒（好几个页面一起拉也只跑一遍） */
type Status = Awaited<ReturnType<typeof readStatus>>;
const statuses = new Map<string, { at: number | null; p: Promise<Status> }>();
export function status(root: string): Promise<Status> {
	const hit = statuses.get(root);
	if (hit && (hit.at === null || Date.now() - hit.at < 1500)) return hit.p;
	const e: { at: number | null; p: Promise<Status> } = { at: null, p: readStatus(root) };
	statuses.set(root, e);
	e.p.then(() => { e.at = Date.now(); }, () => { if (statuses.get(root) === e) statuses.delete(root); });
	return e.p;
}

async function readStatus(root: string) {
	if (!(await isGit(root))) return { git: false as const };
	const [out, b] = await Promise.all([gitAsync(root, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]), base(root)]);
	const lines = out.split("\n").filter(Boolean);
	// 「## main...origin/main [ahead 1, behind 2]」「## No commits yet on main」「## HEAD (no branch)」
	const m = /^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(lines.shift() ?? "");
	const track = m?.[3] ?? "";
	const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
	const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
	// 每个文件加了几行、删了几行（和 HEAD 比，暂存没暂存的都算）；二进制是「-」
	const stat = new Map<string, { add: number; del: number }>();
	for (const l of (await tryGitAsync(root, ["diff", b, "--numstat", "--no-renames"])).split("\n")) {
		const [a, d, path] = l.split("\t");
		if (path && a !== "-") stat.set(path, { add: Number(a), del: Number(d) });
	}
	let counted = 0;
	const changes = lines.map((l) => {
		const code = l.slice(0, 2);
		const path = l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop() as string;
		let n = stat.get(path);
		return { code, path, ...n, count: !n && code === "??" && counted++ < 200 };
	});
	// 没进 git 的新文件：数它有几行（异步读，不挡别的请求；太多、太大的不数）
	await Promise.all(changes.map(async (c) => {
		if (c.count) Object.assign(c, (await newLines(root, c.path)) ?? {});
		delete (c as { count?: boolean }).count;
	}));
	// 还没推上去的提交
	const [unpushed, history] = await Promise.all([m?.[2] ? tryGitAsync(root, ["rev-list", "@{u}..HEAD"]) : "", tryGitAsync(root, ["log", "-30", "--pretty=format:%H%x09%h%x09%s%x09%cI%x09%an"])]);
	const local = new Set(unpushed.split("\n").filter(Boolean));
	const log = history
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [full, hash, subject, when, author] = l.split("\t");
			return { hash, subject, when, author, local: local.has(full) };
		});
	return { git: true as const, branch: m?.[1] ?? "", upstream: m?.[2] ?? null, ahead, behind, changes, log };
}

/** 一个文件没提交的改动（统一 diff）。没进 git 的新文件和 /dev/null 比，这样也有头、能认出二进制 */
export async function diff(root: string, rel: string) {
	const f = inside(root, rel);
	const tracked = (await gitAsync(root, ["ls-files", "--", rel])).trim() !== "";
	if (tracked) return gitAsync(root, ["diff", await base(root), "--", rel]);
	if (statSync(f).size > 2 * 1024 * 1024) return "";
	try {
		return await gitAsync(root, ["diff", "--no-index", "--", "/dev/null", rel]);
	} catch (e) {
		// 有差别时 git diff --no-index 退出码是 1：输出在错误的 stdout 上
		const out = (e as { code?: unknown; stdout?: string }).stdout;
		if ((e as { code?: unknown }).code === 1 && typeof out === "string") return out;
		throw e;
	}
}

export async function commit(root: string, hash: string) {
	if (!/^[0-9a-f]{4,40}$/.test(hash)) throw Object.assign(new Error("不合法的提交"), { status: 400 });
	// 合并提交只和第一个父提交比，不出 combined diff
	const [head, diff] = await Promise.all([gitAsync(root, ["show", "-s", "--format=%H%x00%an%x00%aI%x00%B", hash]), gitAsync(root, ["show", "--format=", "--patch", "--diff-merges=first-parent", hash])]);
	const [full, author, when, ...body] = head.split("\0");
	return { hash: full, author, when, body: body.join("\0").trim(), diff };
}
