// 权限确认：claude -p 跑起来以后，遇到要确认的工具调用（执行命令、改文件……），会调这个 MCP 工具（--permission-prompt-tool mcp__mixer__approve）。
// 它把请求转给 mixer 服务，服务在网页上弹出来，人点了「允许 / 拒绝」才返回。
// 返回值是 claude 约定的 JSON：{"behavior":"allow","updatedInput":{...}} 或 {"behavior":"deny","message":"..."}。
// MIXER_URL、MIXER_TOKEN、MIXER_RUN 由 mixer 启动 claude 时经 --mcp-config 传进来。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const URL = process.env.MIXER_URL ?? "http://127.0.0.1:4848";
const TOKEN = process.env.MIXER_TOKEN ?? "";
const RUN = process.env.MIXER_RUN ?? "";

const server = new McpServer({ name: "mixer", version: "0.1.0" });

server.registerTool(
	"approve",
	{
		description: "Ask the human in the mixer web UI whether this tool call may run.",
		inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
	},
	async ({ tool_name, input, tool_use_id }) => {
		let decision: { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string };
		try {
			const r = await fetch(`${URL}/api/approvals`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-mixer-token": TOKEN },
				body: JSON.stringify({ run: RUN, tool: tool_name, input, toolUseId: tool_use_id ?? null }),
			});
			const d = (await r.json()) as { allow: boolean; message?: string };
			decision = d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.message || "在 mixer 里被拒绝了" };
		} catch (e) {
			decision = { behavior: "deny", message: `连不上 mixer：${e instanceof Error ? e.message : e}` };
		}
		return { content: [{ type: "text", text: JSON.stringify(decision) }] };
	},
);

await server.connect(new StdioServerTransport());
