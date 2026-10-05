// 输入框里能选的 skill。名字以命令行为准：每次运行开头的 init 事件带着这个文件夹能用的全部 skill（内置的在磁盘上没有文件，只能靠它），
// 按项目记进 state.json。运行中途新建的要等下一次运行才进 init，所以每次打开列表时再扫一遍放 skill 的文件夹，补上新的；描述也从这些文件里读。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as state from "./state.ts";

export type Skill = { name: string; desc: string | null };

const USER = join(homedir(), ".claude", "skills");

/** SKILL.md 开头的 name、description；user-invocable: false 的不给人选 */
function read(file: string): { name: string | null; desc: string | null; hidden: boolean } | null {
	let t: string;
	try { t = readFileSync(file, "utf8"); } catch { return null; }
	const fm = /^---\n([\s\S]*?)\n---/.exec(t)?.[1] ?? "";
	const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2").replace(/\\"/g, "\"") || null;
	return { name: field("name"), desc: field("description"), hidden: field("user-invocable") === "false" };
}

/** 一个放 skill 的文件夹：每个子文件夹一个 skill；prefix 是插件名（anthropic-skills:pdf） */
function scan(dir: string, prefix = ""): Map<string, { desc: string | null; hidden: boolean }> {
	const out = new Map<string, { desc: string | null; hidden: boolean }>();
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const s = read(join(dir, e.name, "SKILL.md"));
		if (s) out.set(prefix + (s.name ?? e.name), { desc: s.desc, hidden: s.hidden });
	}
	return out;
}

export function list(project: string, cwd: string): Skill[] {
	const files = new Map([
		...scan(USER),
		// claude.ai 上同步下来的 skill：命令行里叫 anthropic-skills:<名字>
		...(existsSync(join(USER, "synced")) ? readdirSync(join(USER, "synced")).filter((d) => !d.startsWith(".")).flatMap((d) => [...scan(join(USER, "synced", d), "anthropic-skills:")]) : []),
		...state.plugins(project).flatMap((p) => [...scan(join(p.path, "skills"), `${p.name}:`)]),
		...scan(join(cwd, ".claude", "skills")),
	]);
	const names = new Set(state.skills(project));
	// 文件夹里有、init 里还没有的：运行中途刚建的
	for (const [name, f] of files) if (!f.hidden) names.add(name);
	return [...names].filter((n) => !files.get(n)?.hidden).sort().map((name) => ({ name, desc: files.get(name)?.desc ?? null }));
}
