import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./app";
import { LiveProvider } from "./lib/live";
import "./index.css";

// 跟系统的深浅色
const dark = matchMedia("(prefers-color-scheme: dark)");
const theme = () => document.documentElement.classList.toggle("dark", dark.matches);
dark.addEventListener("change", theme);
theme();

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<TooltipProvider>
			<LiveProvider>
				<App />
			</LiveProvider>
			<Toaster position="top-center" />
		</TooltipProvider>
	</StrictMode>,
);
