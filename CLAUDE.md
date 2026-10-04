# mixer

远程看、远程驱动本机的 Claude Code 会话：浏览仓库文件、把会话当成一棵树来看（分支、subagent、问题目录、搜索），在网页上续接或分叉会话，Claude 要执行命令、改文件时在网页上点允许或拒绝。只给自己用。

## 跑

- `pnpm start`：服务在 127.0.0.1:4848（`MIXER_PORT` 可改）。`web/src` 比 `web/dist` 新时，启动会先重新打包
- `pnpm dev`：Vite 开发服务（5173），`/api` 转到 4848
- `pnpm check`：类型检查（web 和 server 各一遍）

## 结构

| 位置 | 做什么 |
|---|---|
| `server/sessions.ts` | 读 `~/.claude/projects/<目录>/<会话>.jsonl`，拼成显示用的节点树 |
| `server/repo.ts` | 仓库文件、git 状态、diff、提交；`inside()` 防止路径跑出仓库 |
| `server/runs.ts` | 起 `claude -p` 跑一次（新会话 / 续接 / 分叉 / 从中间分叉），管确认请求 |
| `mcp/approve.ts` | 每次运行带的 MCP 服务 `mixer`，工具 `approve` 把确认请求转给网页 |
| `server/main.ts` | HTTP 接口、SSE（`/api/events`）、监视 transcript 目录 |
| `web/` | Vite + React + Tailwind v4 + shadcn（radix-nova），组件在 `web/src/components/ui` |

## 会话记录的坑（`server/sessions.ts`）

- 记录靠 `uuid` / `parentUuid` 连成树；`isSidechain` 是 subagent。subagent 的记录在 `<会话>/subagents/agent-<id>.jsonl`，旁边的 `.meta.json` 有类型和描述
- 只按 `\n` 切行：行里有 U+2028，Node 的 readline 会在那里切断
- 同一个 uuid 会被重复追加，按第一次出现的算
- 并行的工具调用在树上看着像分叉，其实不是分支；分支只看用户消息
- `<task-notification>`、`<command-name>`、`<system-reminder>` 这类用户记录是系统插的，显示成事件，不当成人问的话

## 运行（`server/runs.ts`）

- 只用本机的 `claude` 命令行，走用户自己的订阅。不用 Agent SDK：它要 API key，而且不允许拿 claude.ai 的登录给别人用
- 参数：`claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode <m> --permission-prompt-tool mcp__mixer__approve --mcp-config <临时文件> [--resume <id> [--fork-session]]`，问题从 stdin 写入
- 确认：Claude 要用需要许可的工具时调 `mcp__mixer__approve`，它 POST 到 `/api/approvals`（带 `x-mixer-token`，每次启动随机生成），挂起直到网页上点了允许或拒绝；10 分钟没人管按拒绝处理。只读的命令（如 `echo`）Claude Code 自己会放行，不会来问
- 会话 90 秒内有写入（终端里可能正开着）就不让续接，免得两边同时写一个会话
- 「从中间分叉」：命令行只能从末尾分叉，所以把到那个节点为止的记录链复制成一个新会话文件，再续接它。实验性的

## 安全

能在这台 Mac 上执行命令，所以：
- 服务只听 127.0.0.1；写的接口只认本机或同源 https 的 Origin
- 放到外网只能经 Cloudflare Tunnel，而且前面必须挂 Cloudflare Access（只放行自己的邮箱）。不能撤掉 Access 只留隧道
