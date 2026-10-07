// 删掉一个会话，删了还能找回来：<会话>.jsonl 和旁边的 <会话>/（子代理、工具结果）挪进废纸篓里的一个文件夹
// 「mixer 删除的会话 <标题> (<id 前 8 位>)」，里面写一份「原来的位置.txt」。从 Claude Code 的历史里也就没了（claude --resume 看不到），
// 挪回去就又有了。同一个磁盘，rename 就行。
// 在 mixer 里在跑、排着队、待确认，或者在 mixer 外面开着（终端、IDE、桌面版：terminals.ts，当场查）的不许删：409。
// 删完移出工作区、忘掉 mixer 记的它的状态和缓存。从它分叉出来的会话是完整的一份，留着，只是没了原会话
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as runs from "./runs.ts";
import * as sessions from "./sessions.ts";
import * as state from "./state.ts";
import * as terminals from "./terminals.ts";

const no = (status: number, msg: string) => Object.assign(new Error(msg), { status });

export async function remove(project: string, id: string) {
	const file = sessions.locate(project, id);
	if (!file) throw no(404, "没有这个会话");
	// 标题先读好：查完「在不在跑」到挪走之间不能再 await，不然这期间来的续接会起一个 claude，往挪走了的路径写出个新文件
	const m = await sessions.row(project, id);
	if (await terminals.held(id)) throw no(409, "这个会话在终端里开着：关掉再删");
	// mixer 里的放在 await 之后看：查终端的时候可能刚开始跑
	const why = runs.busy(id);
	if (why) throw no(409, why);
	toTrash(file, m?.title ?? m?.first ?? null);
	sessions.forget(project, id);
	state.forget(id);
}

/** 挪进废纸篓：一个会话一个文件夹，重名了加编号 */
function toTrash(file: string, title: string | null) {
	const id = basename(file, ".jsonl");
	const dir = file.slice(0, -".jsonl".length);
	const name = (title ?? "").replace(/[/:\s]+/g, " ").trim().slice(0, 20).trim();
	const base = join(homedir(), ".Trash", `mixer 删除的会话 ${name ? `${name} ` : ""}(${id.slice(0, 8)})`);
	let to = base;
	for (let n = 2; existsSync(to); n++) to = `${base} ${n}`;
	mkdirSync(to, { recursive: true });
	const moved = [file, ...(existsSync(dir) ? [dir] : [])];
	writeFileSync(join(to, "原来的位置.txt"), `${moved.join("\n")}\n\n恢复：把这个文件夹里的 ${moved.map((f) => basename(f)).join(" 和 ")} 挪回上面的位置，claude --resume 和 mixer 里就又能看到了。\n`);
	try {
		renameSync(file, join(to, basename(file)));
	} catch (e) {
		rmSync(to, { recursive: true, force: true });
		throw e;
	}
	// 子代理、工具结果那个文件夹：挪不动也不要紧，原来的位置.txt 里写着
	if (moved.length > 1) {
		try { renameSync(dir, join(to, id)); } catch {}
	}
}
