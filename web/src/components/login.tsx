// 登录：远程来的要先认出是谁（server/access.ts）。本机、经 Cloudflare Access 来的直接进；Tailscale Funnel 来的用 passkey。
// 第一台设备：Mac 上 `pnpm mixer pair` 出二维码，扫开的地址带着配对码（?pair=），在这里建 passkey。
// 之后（包括添加到主屏幕的 app，它和 Safari 的 cookie 不通）点「登录」用同一个 passkey。
// passkey 的库点了才加载：认出来了的（绝大多数时候）用不着它
import type { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { KeyRound } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

/** via：认出来是谁（null 是没认出来）；passkey：这个地址能不能用 passkey 登录 */
type Auth = { via: string | null; passkey: boolean; passkeys: number };

/** 认出来了才画里面；接口说没登录（mixer:login）就再问一次 */
export function Gate({ children }: { children: ReactNode }) {
	const [auth, setAuth] = useState<Auth | null>(null);
	const check = useCallback(() => {
		fetch("/api/auth/status").then(
			// 问不到（服务还是旧版本、断网）：照旧进去，接口自己会报错
			async (r) => setAuth(r.ok ? ((await r.json()) as Auth) : { via: "unknown", passkey: false, passkeys: 0 }),
			() => setAuth({ via: "unknown", passkey: false, passkeys: 0 }),
		);
	}, []);
	useEffect(() => {
		check();
		window.addEventListener("mixer:login", check);
		return () => window.removeEventListener("mixer:login", check);
	}, [check]);
	if (!auth) return <div className="flex h-svh items-center justify-center text-muted-foreground"><Spinner /></div>;
	return auth.via ? children : <Login auth={auth} />;
}

function Login({ auth }: { auth: Auth }) {
	const code = new URLSearchParams(location.search).get("pair");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// 先把 passkey 的库拿来：点按钮时就不用等它了
	useEffect(() => { import("@simplewebauthn/browser").catch(() => {}); }, []);
	// 登录了：去掉配对码，整页重新载入
	const done = () => {
		const u = new URL(location.href);
		u.searchParams.delete("pair");
		location.replace(u.toString());
	};
	const attempt = (f: () => Promise<void>) => async () => {
		setBusy(true);
		setError(null);
		try {
			await f();
			done();
		} catch (e) {
			setError(e instanceof Error && e.name === "NotAllowedError" ? "没完成：取消了，或者超时了" : e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};
	const create = attempt(async () => {
		const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/register/options", { code });
		const w = await import("@simplewebauthn/browser");
		await api("/api/auth/register", { code, response: await w.startRegistration({ optionsJSON }) });
	});
	const login = attempt(async () => {
		const o = await api<{ id: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/auth/login/options", {});
		const w = await import("@simplewebauthn/browser");
		await api("/api/auth/login", { id: o.id, response: await w.startAuthentication({ optionsJSON: o.options }) });
	});

	const [title, text, action] = !auth.passkey
		? ["进不来", "这个地址不认识你。用 Cloudflare Access 的话，看看 Mac 上 pnpm mixer setup cloudflare 填的 AUD 和邮箱对不对", null]
		: code
			? ["在这台设备上建一个 passkey", "以后打开 mixer 用面容 / 指纹登录", { label: "建 passkey", run: create }]
			: auth.passkeys
				? ["登录 mixer", "用这台设备上的 passkey。还没有 passkey 的设备：在 Mac 上运行 pnpm mixer pair，扫码", { label: "登录", run: login }]
				: ["还没有能登录的设备", "在 Mac 上运行 pnpm mixer pair，用这台设备扫码", null];
	return (
		<Empty className="h-svh">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<KeyRound />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{text}</EmptyDescription>
			</EmptyHeader>
			{(action || error) && (
				<EmptyContent>
					{action && (
						<Button onClick={action.run} disabled={busy} className="gap-1.5">
							{busy && <Spinner />}
							{action.label}
						</Button>
					)}
					{error && <p className="text-xs text-destructive">{error}</p>}
				</EmptyContent>
			)}
		</Empty>
	);
}
