// 读一个项目的仓库：文件列表（git 管的 + 没被忽略的新文件）、文件内容、git 状态、改动、最近的提交。只读。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const git = (root: string, args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

export function status(root: string) {
	if (!isGit(root)) return { git: false as const };
	const lines = git(root, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]).split("\n").filter(Boolean);
	const head = lines.shift() ?? "";
	const changes = lines.map((l) => ({ code: l.slice(0, 2), path: l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop() as string }));
	const log = git(root, ["log", "-20", "--pretty=format:%h%x09%s%x09%cI%x09%an"])
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [hash, subject, when, author] = l.split("\t");
			return { hash, subject, when, author };
		});
	return { git: true as const, branch: head.replace(/^## /, ""), changes, log };
}

export function diff(root: string, rel: string) {
	inside(root, rel);
	const tracked = git(root, ["ls-files", "--", rel]).trim() !== "";
	if (!tracked) {
		const f = file(root, rel);
		return f.kind === "text" ? f.text.split("\n").map((l) => `+${l}`).join("\n") : `（${f.kind}，${f.size} 字节）`;
	}
	return git(root, ["diff", "HEAD", "--", rel]);
}

export function commit(root: string, hash: string) {
	if (!/^[0-9a-f]{4,40}$/.test(hash)) throw new Error("不合法的提交");
	return git(root, ["show", "--stat", "--patch", "--format=%H%n%an  %ad%n%n%B", hash]);
}
