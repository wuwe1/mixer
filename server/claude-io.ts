// 和 claude -p（stream-json）说话的两样东西，runs.ts 和 models.ts 共用：按行读输出；发要回音的 control_request、等它的 control_response
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

/**
 * 输出一行一个 JSON：只按 \n 切（行里有 U+2028，readline 会在那里切断），没有换行的半行留着等下一块。
 * 按 utf8 解码再拼：一个汉字可能被切在两块之间。流结束时最后一行没有换行也算
 */
export function onLines(stream: Readable, f: (line: string) => void) {
	let buf = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buf += chunk;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const l = buf.slice(0, i);
			buf = buf.slice(i + 1);
			f(l);
		}
	});
	stream.on("end", () => {
		const l = buf;
		buf = "";
		if (l) f(l);
	});
}

type Wait = { ok: (r: Record<string, unknown>) => void; fail: (e: Error) => void };

/**
 * 要回音的 control_request：request 写一条、等同一个 request_id 的 control_response。回 success 给 response，
 * 回 error（旧版命令行不认识这个 subtype）、ms 毫秒没回、failAll（进程没了）算失败。
 * reply：输出里的每个事件交给它，是等着的回音就收下（返回 true）；没人等的（发了不等的 set_model 这些）不管
 */
export function requests(write: (msg: unknown) => void) {
	const wait = new Map<string, Wait>();
	return {
		request(request: Record<string, unknown>, ms: number, id: string = randomUUID()) {
			return new Promise<Record<string, unknown>>((ok, fail) => {
				const timer = setTimeout(() => {
					wait.delete(id);
					fail(new Error(`claude ${ms / 1000} 秒没回`));
				}, ms).unref();
				wait.set(id, { ok: (r) => { clearTimeout(timer); ok(r); }, fail: (e) => { clearTimeout(timer); fail(e); } });
				write({ type: "control_request", request_id: id, request });
			});
		},
		reply(ev: Record<string, unknown>) {
			if (ev.type !== "control_response") return false;
			const r = (ev.response ?? {}) as { subtype?: string; request_id?: string; response?: Record<string, unknown>; error?: unknown };
			const w = r.request_id ? wait.get(r.request_id) : undefined;
			if (!w || !r.request_id) return false;
			wait.delete(r.request_id);
			if (r.subtype === "error") w.fail(new Error(String(r.error ?? "出错了")));
			else w.ok(r.response ?? {});
			return true;
		},
		failAll(e: Error) {
			for (const w of wait.values()) w.fail(e);
			wait.clear();
		},
	};
}
