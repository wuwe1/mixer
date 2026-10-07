import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/lib/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./app";
import { Gate } from "./components/login";
import { Boundary } from "./components/placeholder";
import { LiveProvider } from "./lib/live";
import "./index.css";

// 跟系统的深浅色
const dark = matchMedia("(prefers-color-scheme: dark)");
const theme = () => document.documentElement.classList.toggle("dark", dark.matches);
dark.addEventListener("change", theme);
theme();

// 按需加载的那几块拿不到：多半是重新打包过了，旧的文件已经没了。刷新换成新版本；
// 10 秒内刚这样刷过就不再刷（断网时不会一直刷），错误照常抛给 Boundary
addEventListener("vite:preloadError", (e) => {
	const KEY = "mixer.reloaded";
	const last = Number(sessionStorage.getItem(KEY) ?? 0);
	if (Date.now() - last < 10_000) return;
	sessionStorage.setItem(KEY, String(Date.now()));
	e.preventDefault();
	location.reload();
});

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<TooltipProvider>
			<Boundary className="h-svh">
				<Gate>
					<LiveProvider>
						<App />
					</LiveProvider>
				</Gate>
			</Boundary>
			<Toaster />
		</TooltipProvider>
	</StrictMode>,
);
