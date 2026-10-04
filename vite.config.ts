import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 页面在 web/，打包到 web/dist，由 server/main.ts 提供
export default defineConfig({
	root: "web",
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": path.resolve(import.meta.dirname, "web/src") } },
	build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
	server: { proxy: { "/api": "http://127.0.0.1:4848" } },
});
