// 读一个项目的仓库：文件列表（git 管的 + 没被忽略的新文件）、文件内容、git 状态、改动、最近的提交。只读。
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

// quotePath=false：中文文件名原样给，不转成 "\346\226…"。stderr 收着不打出来（「not a git repository」这种会刷满日志）
const GIT = (root: string, args: string[]) => ["-C", root, "-c", "core.quotePath=false", ...args];
const git = (root: string, args: string[]) => execFileSync("git", GIT(root, args), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const isGit = (root: string) => {
	try { return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { return false; }
};
/** 不卡住服务的 git：状态在运行时每半秒拉一次，同步跑会把别的请求都挡住 */
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

export function files(root: string): string[] {
	if (isGit(root)) return git(root, ["ls-files", "-co", "--exclude-standard"]).split("\n").filter(Boolean).sort();
	// 不是 git 仓库：自己走一遍，跳过常见的大目录
	const out: string[] = [];
	const skip = new Set(["node_modules", ".git", "dist", ".venv", "__pycache__"]);
	const walk = (dir: string) => {
		for (const d of readdirSync(dir, { withFileTypes: true })) {
			if (skip.has(d.name) || out.length > 20000) continue;
			const f = join(dir, d.name);
			if (d.isDirectory()) walk(f);
			else out.push(relative(root, f));
		}
	};
	walk(root);
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

// 还没有提交的仓库没有 HEAD，跟空树比
const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const base = async (root: string) => ((await tryGitAsync(root, ["rev-parse", "--verify", "-q", "HEAD"])) ? "HEAD" : EMPTY);
const baseSync = (root: string) => { try { return git(root, ["rev-parse", "--verify", "-q", "HEAD"]) ? "HEAD" : EMPTY; } catch { return EMPTY; } };

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
	if ((await tryGitAsync(root, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") return { git: false as const };
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
		// 没进 git 的新文件：数它有几行（太多就不数了）
		if (!n && code === "??" && counted++ < 200) {
			try {
				const f = file(root, path);
				if (f.kind === "text") n = { add: f.text.split("\n").length - (f.text.endsWith("\n") ? 1 : 0), del: 0 };
			} catch {}
		}
		return { code, path, ...n };
	});
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
export function diff(root: string, rel: string) {
	const f = inside(root, rel);
	const tracked = git(root, ["ls-files", "--", rel]).trim() !== "";
	if (tracked) return git(root, ["diff", baseSync(root), "--", rel]);
	if (statSync(f).size > 2 * 1024 * 1024) return "";
	try {
		return git(root, ["diff", "--no-index", "--", "/dev/null", rel]);
	} catch (e) {
		// 有差别时 git diff --no-index 退出码是 1
		return String((e as { stdout?: string }).stdout ?? "");
	}
}

export function commit(root: string, hash: string) {
	if (!/^[0-9a-f]{4,40}$/.test(hash)) throw new Error("不合法的提交");
	const [full, author, when, ...body] = git(root, ["show", "-s", "--format=%H%x00%an%x00%aI%x00%B", hash]).split("\0");
	// 合并提交只和第一个父提交比，不出 combined diff
	const diff = git(root, ["show", "--format=", "--patch", "--diff-merges=first-parent", hash]);
	return { hash: full, author, when, body: body.join("\0").trim(), diff };
}
