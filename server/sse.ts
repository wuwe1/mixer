// SSE（/api/events）的连接们：运行的输出、运行状态、确认请求、排队、会话文件有变化，推给每一条。
// 连上先发 hello：这时的全部状态（运行、确认请求、排队、用量、工作区、在跑的那几次正在写的那几段），页面拿它整个换掉，不再另外拉几个接口：
// 另外拉的快照可能比已经推来的事件旧，旧的盖掉新的（跑完了还显示运行中、点过的确认卡片又冒出来）。hello 和之后的事件在同一条流里，先后不乱。
// 算 hello 要等（工作区要读会话）：这期间给这条连接的事件先攒着，hello 发完再接着发。攒着的比 hello 旧也没关系：
// 每次变化都有事件、按顺序接上，最后还是现在的样子；正在写的那几段按序号接，旧的页面自己扔掉
type Out = { write: (m: string) => unknown; end: () => unknown };

/** 值：还在等 hello 时攒着的事件；null 是已经发过 hello、直接推 */
const clients = new Map<Out, string[] | null>();

export const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

export function emit(type: string, data: unknown) {
	const m = frame(type, data);
	for (const [c, held] of clients) held ? held.push(m) : c.write(m);
}

/** 新连上的：hello 算好了先发它、再发攒着的。hello 里同步拿的部分要放在 await 之后，才是发出去那一刻的。算不出来就断开，页面会重连 */
export async function join(c: Out, hello: () => Promise<unknown>) {
	const held: string[] = [];
	clients.set(c, held);
	let h: unknown;
	try {
		h = await hello();
	} catch (e) {
		clients.delete(c);
		c.end();
		throw e;
	}
	// 等的时候断了
	if (clients.get(c) !== held) return;
	c.write(frame("hello", h) + held.join(""));
	clients.set(c, null);
}

export const leave = (c: Out) => { clients.delete(c); };
