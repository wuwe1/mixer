# mixer

远程看、远程驱动本机的 Claude Code 会话。只给自己用。

## 用的人只需要懂这些

- **项目**：一个文件夹。侧栏按项目列会话，项目页能开新会话、看文件和改动
- **会话**：前面一个状态记号，平时看侧栏就知道哪些跑好了、哪些在跑：等你确认（琥珀色）、在跑（转圈）、跑完了没看（圆点）、出错了、终端里开着
- **开 agent 只有两种办法**：选文件夹开新会话；从一个会话分叉（在任意一条 Claude 的回答后面「从这里分叉」，或「改写后分叉」一条你的消息）。分叉出来的会话挂在原会话下面
- **接着说**：只有看着最新处、没在跑、终端里没开着时才行；其余情况输入框自动变成分叉，并写明原因
- **版本**：一条消息在终端里改写过（回退重写），那里有「第 i / n 版」切换。只是看，不产生新东西
- **确认**：Claude 动手前问你。当前会话的出现在对话里；别的会话的浮在右下角

## 跑

- `pnpm start`：服务在 127.0.0.1:4848（`MIXER_PORT` 可改）。`web/src` 比 `web/dist` 新时，启动会先重新打包
- `pnpm dev`：Vite 开发服务（5173），`/api` 转到 4848
- `pnpm check`：类型检查（web 和 server 各一遍）

## 结构

| 位置 | 做什么 |
|---|---|
| `server/sessions.ts` | 读 `~/.claude/projects/<目录>/<会话>.jsonl`，拼成显示用的节点树 |
| `server/repo.ts` | 仓库文件、git 状态、diff、提交；`inside()` 防止路径跑出仓库 |
| `server/dirs.ts` | 新会话选文件夹：列子文件夹、新建，只认家目录里面的 |
| `server/state.ts` | `data/state.json`（不进 git）：每个会话在 mixer 里最后跑完的时间、人最后看它的时间 →「跑完了没看」 |
| `server/runs.ts` | 起 `claude -p` 跑一次（新会话 / 续接 / 分叉 / 从中间分叉），管确认请求 |
| `mcp/approve.ts` | 每次运行带的 MCP 服务 `mixer`，工具 `approve` 把确认请求转给网页 |
| `server/main.ts` | HTTP 接口、SSE（`/api/events`）、监视 transcript 目录 |
| `web/` | Vite + React + Tailwind v4 + shadcn（radix-nova），组件在 `web/src/components/ui` |
| `web/src/lib/live.tsx` | 全页面共用的项目树、运行、确认请求，和会话状态的算法 |

## 会话记录的坑（`server/sessions.ts`）

- 记录靠 `uuid` / `parentUuid` 连成树；`isSidechain` 是 subagent。subagent 的记录在 `<会话>/subagents/agent-<id>.jsonl`，旁边的 `.meta.json` 有类型和描述
- 只按 `\n` 切行：行里有 U+2028，Node 的 readline 会在那里切断
- 同一个 uuid 会被重复追加，按第一次出现的算
- 并行的工具调用在树上看着像分叉，其实不是分支；分支只看用户消息
- `<task-notification>`、`<command-name>`、`<system-reminder>` 这类用户记录是系统插的，显示成事件，不当成人问的话

## 运行（`server/runs.ts`）

- 只用本机的 `claude` 命令行，走用户自己的订阅。不用 Agent SDK：它要 API key，而且不允许拿 claude.ai 的登录给别人用
- 参数：`claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode <m> --permission-prompt-tool mcp__mixer__approve --mcp-config <临时文件> [--resume <id> [--fork-session [--resume-session-at <uuid>]]]`，问题从 stdin 写入
- 分叉全交给命令行：`--fork-session` 开新会话、原会话不动；`--resume-session-at` 是一条 assistant 记录的 uuid，只带到它为止的上下文（命令行帮助里没写，试过可用）。新会话文件里原会话的记录原样复制（uuid 不变），所以「第一条记录的 uuid 相同」= 一家；文件建立之后的第一句是它自己的标题
- 确认：Claude 要用需要许可的工具时调 `mcp__mixer__approve`，它 POST 到 `/api/approvals`（带 `x-mixer-token`，每次启动随机生成），挂起直到网页上点了允许或拒绝；10 分钟没人管按拒绝处理。只读的命令（如 `echo`）Claude Code 自己会放行，不会来问
- 会话 90 秒内有写入（终端里可能正开着）就不让续接，免得两边同时写一个会话；最近那次写入是 mixer 自己跑完的就放行（按 `state.json` 判断，mixer 重启了也认得）
- 新会话可以开在家目录里任意文件夹（`server/dirs.ts`，没开过会话的也行）。项目 id 是 claude 的规则：路径里非字母数字的字符都换成 `-`

## 安全

能在这台 Mac 上执行命令，所以：
- 服务只听 127.0.0.1；写的接口只认本机或同源 https 的 Origin
- 放到外网只能经 Cloudflare Tunnel，而且前面必须挂 Cloudflare Access（只放行自己的邮箱）。不能撤掉 Access 只留隧道

## 部署

- 常驻：launchd `~/Library/LaunchAgents/com.mixer.server.plist`（PATH 里要有 `claude`、node、git），日志 `~/Library/Logs/mixer.log`。改了 server 代码后重启：`launchctl kickstart -k gui/$(id -u)/com.mixer.server`
