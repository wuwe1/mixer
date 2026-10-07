// 哪些会话在 mixer 外面开着（终端、IDE、桌面版、别人起的 claude -p……）：照 Claude Code、Codex 自己记的算，不猜。
// 开着的（不管在跑还是闲着）mixer 只能分叉：不许续接、不许删，免得两边同时写一个会话。关了马上就能接着用。
//   Claude：每个 claude 进程在 ~/.claude/sessions/<pid>.json 登记自己（pid、sessionId、procStart、status busy / idle……）。
//     进程里 /resume、/clear、分叉换了会话，它跟着改 sessionId；正常退出删掉文件，被杀的留着（pid 还会被别的进程复用）。
//     所以要进程活着、启动时间和 procStart 对得上（ps 的 lstart，LC_ALL=C TZ=UTC：Claude Code 自己认「别的进程开着这个会话」也是这么核对的）；
//     有 parkedJobId 的是停放了的，不算（也照它）
//   Codex：有进程在写一个线程时拿着 ~/.codex/thread-writer-locks/<线程 id>.lock（TUI、exec、app-server、桌面版都是，没在跑一轮也拿着）。
//     被杀的文件留着，所以看有没有进程开着它（lsof）。看不出在不在跑，算 idle
//   mixer 自己起的 claude、codex app-server 不算：runs.ts、codex-run.ts 起进程时记进 mine
// 什么时候查：
//   两个文件夹有变化（登记、改状态、换会话、退出删文件，锁文件建了删了）：0.3 秒合一次
//   每 2 秒看一眼开着会话的那些进程还在不在（kill 0，不起进程）：被杀、崩了的不删文件，没了马上查
//   每 30 秒整个查一次兜底：Codex 重新拿一个留下的锁文件不一定有文件事件；pid 被复用；文件夹后来才有
//   续接、删除之前当场查一次（held），不用缓存
import { execFile } from "node:child_process";
import { existsSync, type FSWatcher, readdirSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { SessionMeta } from "../shared/api.ts";
import { say } from "./log.ts";

export const REGISTRY = join(homedir(), ".claude", "sessions");
export const LOCKS = join(homedir(), ".codex", "thread-writer-locks");
const PS = existsSync("/bin/ps") ? "/bin/ps" : "ps";
const LSOF = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
const run = promisify(execFile);

/** busy：Claude 登记的在跑；idle：闲着（Codex 看不出来，也是 idle） */
export type Terminal = NonNullable<SessionMeta["terminal"]>;
/** 开着一个会话的进程。cwd：Claude 登记的（推侧栏那一行时找项目用） */
type Holder = { pid: number; state: Terminal; cwd: string | null };

/** mixer 自己起的进程：claude（runs.ts）、codex app-server（codex-run.ts） */
export const mine = new Set<number>();

/** 会话 id → 开着它的进程（上次查的） */
let open = new Map<string, Holder>();
/** 这个会话在 mixer 外面开着没有（上次查的；给会话信息用） */
export const of = (id: string): Terminal | null => open.get(id)?.state ?? null;

/** 当场查一次（续接、删除之前）：这个会话在 mixer 外面开着没有 */
export async function held(id: string) {
	await refresh();
	return open.has(id);
}

/** Claude 登记表里的一项。不是登记文件（<pid>.key 这些）、坏的、停放了的给 null */
export type Entry = { pid: number; session: string; start: string | null; state: Terminal; cwd: string | null };
export function entry(name: string, text: string): Entry | null {
	const m = /^(\d+)\.json$/.exec(name);
	if (!m) return null;
	let j: Record<string, unknown>;
	try { j = JSON.parse(text); } catch { return null; }
	if (!j || j.pid !== Number(m[1]) || typeof j.sessionId !== "string" || typeof j.parkedJobId === "string") return null;
	return { pid: Number(m[1]), session: j.sessionId, start: typeof j.procStart === "string" ? norm(j.procStart) : null, state: j.status === "busy" ? "busy" : "idle", cwd: typeof j.cwd === "string" ? j.cwd : null };
}
const torn = (text: string) => {
	try {
		JSON.parse(text);
		return false;
	} catch {
		return true;
	}
};
/** 「Thu Oct  1 11:56:04 2026」：空格多少不算 */
const norm = (s: string) => s.trim().replace(/\s+/g, " ");

/** 进程还在不在（EPERM 是别人的进程，也在） */
function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

const warned = new Set<string>();
const warn = (what: string, e: unknown) => {
	if (warned.has(what)) return;
	warned.add(what);
	say(`${what}没成（之后不再提）：${e instanceof Error ? e.message : e}`);
};

/** 这些进程的启动时间（和 procStart 一样的写法）。ps 用不了给 null */
export async function starts(pids: number[]): Promise<Map<number, string> | null> {
	if (!pids.length) return new Map();
	let out: string;
	try {
		out = (await run(PS, ["-o", "pid=", "-o", "lstart=", "-p", pids.join(",")], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 5000 })).stdout;
	} catch (e) {
		// 一个都不在了：退出码 1，没有输出
		const err = e as { code?: unknown; stdout?: string };
		if (err.code !== 1) {
			warn("ps 查进程启动时间", e);
			return null;
		}
		out = err.stdout ?? "";
	}
	const m = new Map<number, string>();
	for (const l of out.split("\n")) {
		const x = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(l);
		if (x) m.set(Number(x[1]), norm(x[2]));
	}
	return m;
}

/** 读到一半的登记文件（正在写）：用上次读到的那份 */
let lastEntries = new Map<number, Entry>();
async function claude(): Promise<Map<string, Holder>> {
	let names: string[];
	try { names = readdirSync(REGISTRY); } catch { names = []; }
	const entries = new Map<number, Entry>();
	for (const n of names) {
		if (!/^\d+\.json$/.test(n)) continue;
		let text = "";
		try { text = readFileSync(join(REGISTRY, n), "utf8"); } catch { continue; }
		const e = entry(n, text);
		const pid = Number(n.slice(0, -5));
		const last = lastEntries.get(pid);
		if (e) entries.set(pid, e);
		else if (last && torn(text)) entries.set(pid, last);
	}
	lastEntries = entries;
	const outside = [...entries.values()].filter((e) => !mine.has(e.pid));
	const st = await starts(outside.filter((e) => e.start).map((e) => e.pid));
	const out = new Map<string, Holder>();
	for (const e of outside) {
		// 有 procStart 而且 ps 能用：启动时间要对得上（pid 被复用了就对不上）；不然只看进程在不在
		const live = e.start && st ? st.get(e.pid) === e.start : alive(e.pid);
		if (live) add(out, e.session, { pid: e.pid, state: e.state, cwd: e.cwd });
	}
	return out;
}

/** lsof 用不了时：Codex 的用上次查的 */
let lastCodex = new Map<string, Holder>();
async function codex(): Promise<Map<string, Holder>> {
	let names: string[];
	try { names = readdirSync(LOCKS); } catch { names = []; }
	const ids = new Set(names.flatMap((n) => /^([0-9a-f-]{36})\.lock$/.exec(n)?.[1] ?? []));
	if (!ids.size) return (lastCodex = new Map());
	let out: string;
	try {
		out = (await run(LSOF, ["-w", "-F", "pn", "+d", LOCKS], { timeout: 10_000 })).stdout;
	} catch (e) {
		// 谁都没开着：退出码 1
		const err = e as { code?: unknown; stdout?: string };
		if (err.code !== 1) {
			warn("lsof 查 Codex 的线程锁", e);
			return lastCodex;
		}
		out = err.stdout ?? "";
	}
	const m = new Map<string, Holder>();
	let pid = 0;
	for (const l of out.split("\n")) {
		if (l.startsWith("p")) pid = Number(l.slice(1));
		else if (l.startsWith("n") && pid && !mine.has(pid)) {
			const id = basename(l.slice(1)).replace(/\.lock$/, "");
			if (ids.has(id)) add(m, id, { pid, state: "idle", cwd: null });
		}
	}
	return (lastCodex = m);
}

/** 一个会话被几个进程开着：有一个在跑就算在跑 */
function add(m: Map<string, Holder>, id: string, h: Holder) {
	const o = m.get(id);
	if (!o || (o.state !== "busy" && h.state === "busy")) m.set(id, h);
}

/** 开着、关了、在跑和闲着换了：告诉 main.ts，推侧栏那一行 */
let listener: (id: string, cwd: string | null) => void = () => {};

async function check() {
	try {
		const [a, b] = await Promise.all([claude(), codex()]);
		const next = new Map([...b, ...a]);
		const before = open;
		open = next;
		for (const id of new Set([...before.keys(), ...next.keys()])) {
			if (before.get(id)?.state === next.get(id)?.state) continue;
			try { listener(id, next.get(id)?.cwd ?? before.get(id)?.cwd ?? null); } catch {}
		}
	} catch (e) {
		warn("查终端里开着的会话", e);
	}
}

/** 查一次；正在查的那次可能是在这之前开始的，就排一次在它后面（只排一次，后来的都等它） */
let checking: Promise<void> | null = null;
let again: Promise<void> | null = null;
export function refresh(): Promise<void> {
	if (!checking) {
		checking = check().finally(() => { checking = null; });
		return checking;
	}
	again ??= checking.then(() => {
		again = null;
		return refresh();
	});
	return again;
}

const watching = new Map<string, FSWatcher>();
/** 监视两个文件夹（还没有的下次再来） */
function arm() {
	for (const dir of [REGISTRY, LOCKS]) {
		if (watching.has(dir) || !existsSync(dir)) continue;
		try {
			// 不拖着进程不退（测试）：服务本来就一直开着
			const w = watch(dir, () => soon()).unref();
			w.on("error", () => {
				w.close();
				watching.delete(dir);
			});
			watching.set(dir, w);
		} catch {}
	}
}
let timer: NodeJS.Timeout | null = null;
const soon = () => {
	timer ??= setTimeout(() => {
		timer = null;
		void refresh();
	}, 300);
};

/** main.ts 起来时调：开始监视、定时查；f 是开着的状态变了的会话 */
export function start(f: (id: string, cwd: string | null) => void) {
	listener = f;
	arm();
	void refresh();
	setInterval(() => { if ([...open.values()].some((h) => !alive(h.pid))) void refresh(); }, 2000).unref();
	setInterval(() => {
		arm();
		void refresh();
	}, 30_000).unref();
}
