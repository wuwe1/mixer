import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// 页面在 web/，打包到 web/dist，由 server/main.ts 提供。
// 不清空 dist：已经开着的页面还要按需加载旧的那些块（旧文件 main.ts 打包后清，留一天）
export default defineConfig({
	root: "web",
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": path.resolve(import.meta.dirname, "web/src"), "@shared": path.resolve(import.meta.dirname, "shared") } },
	build: { outDir: "dist", emptyOutDir: false, chunkSizeWarningLimit: 4000 },
	// 高亮的 Worker 要按需加载语言，得是 ES 模块
	worker: { format: "es" },
	server: {
		proxy: {
			"/api": {
				target: "http://127.0.0.1:4848",
				// pnpm dev --host 时局域网里的设备也能连：转过去时带上它的地址，mixer 就把它当远程的（要登录），不当本机
				configure: (proxy) => {
					proxy.on("proxyReq", (req, from) => {
						const a = from.socket.remoteAddress;
						if (a && !LOOPBACK.has(a)) req.setHeader("x-forwarded-for", a);
					});
				},
			},
		},
	},
});
