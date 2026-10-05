// 读一个项目的仓库：文件列表（git 管的 + 没被忽略的新文件）、文件内容、git 状态、改动、最近的提交。只读。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

// quotePath=false：中文文件名原样给，不转成 "\346\226…"
const git = (root: string, args: string[]) => execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const tryGit = (root: string, args: string[]) => {
	try { return git(root, args); } catch { return ""; }
};
const isGit = (root: string) => {
	try { return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { return false; }
};

/** 路径只许在仓库里面（防 ../ 和软链接逃出去） */
export function inside(root: string, rel: string): string {
	const f = join(root, rel);
	const real = existsSync(f) ? realpathSync(f) : f;
	const r = realpathSync(root);
	if (real !== r && !real.startsWith(r + sep)) throw new Error("路径不在仓库里");
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
const base = (root: string) => (tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"]) ? "HEAD" : EMPTY);

export function status(root: string) {
	if (!isGit(root)) return { git: false as const };
	const lines = git(root, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]).split("\n").filter(Boolean);
	// 「## main...origin/main [ahead 1, behind 2]」「## No commits yet on main」「## HEAD (no branch)」
	const m = /^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(lines.shift() ?? "");
	const track = m?.[3] ?? "";
	const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
	const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
	// 每个文件加了几行、删了几行（和 HEAD 比，暂存没暂存的都算）；二进制是「-」
	const stat = new Map<string, { add: number; del: number }>();
	for (const l of tryGit(root, ["diff", base(root), "--numstat", "--no-renames"]).split("\n")) {
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
	const local = new Set(m?.[2] ? tryGit(root, ["rev-list", "@{u}..HEAD"]).split("\n").filter(Boolean) : []);
	const log = tryGit(root, ["log", "-30", "--pretty=format:%H%x09%h%x09%s%x09%cI%x09%an"])
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
	if (tracked) return git(root, ["diff", base(root), "--", rel]);
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
