// 选文件夹开新会话：只看家目录里面的文件夹（隐藏的、node_modules 不列），能在里面新建文件夹。
// 会话记录放在 ~/.claude/projects/<目录名>，目录名是 claude 把路径里非字母数字的字符都换成 "-"（例 /Users/a/.x → -Users-a--x）。
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { PROJECTS } from "./sessions.ts";

export const HOME = realpathSync(homedir());
export const projectId = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

const fail = (status: number, msg: string) => Object.assign(new Error(msg), { status });

/** 家目录里的一个文件夹（解析掉符号链接）；不在家目录里、不存在、不是文件夹都报错 */
export function folder(path: string): string {
	let real: string;
	try { real = realpathSync(path || HOME); } catch { throw fail(404, "没有这个文件夹"); }
	if (real !== HOME && !real.startsWith(HOME + sep)) throw fail(403, "只能用家目录里面的文件夹");
	if (!statSync(real).isDirectory()) throw fail(400, "这不是文件夹");
	return real;
}

export function list(path: string) {
	const dir = folder(path);
	const entries = readdirSync(dir, { withFileTypes: true })
		.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && (e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name)))))
		.map((e) => {
			const p = join(dir, e.name);
			return { name: e.name, path: p, git: existsSync(join(p, ".git")), project: existsSync(join(PROJECTS, projectId(p))) };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	return { path: dir, home: HOME, parent: dir === HOME ? null : join(dir, ".."), git: existsSync(join(dir, ".git")), entries };
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export function create(parent: string, name: string) {
	const dir = folder(parent);
	if (!name || name.startsWith(".") || /[/\\\0]/.test(name)) throw fail(400, "文件夹名不能以 . 开头，也不能有 /");
	const p = join(dir, name);
	if (existsSync(p)) throw fail(409, "已经有了");
	mkdirSync(p);
	return { path: p };
}
