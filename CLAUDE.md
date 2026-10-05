# mixer

远程看、远程驱动本机的 Claude Code 会话。只给自己用。

## 用的人只需要懂这些

- **项目**：一个文件夹。侧栏按项目列会话，项目页能开新会话、看文件和改动
- **会话**：侧栏每行右边是时间和状态标记，看侧栏就知道哪些完成了、哪些在运行。标记全站一套：点是要你注意（待确认是琥珀点、带一圈扩散；已完成未读是蓝点；出错未读是红点），运行中是转圈，终端中打开是灰色空心圈。颜色只有这几种意思：琥珀要你确认、红出错、蓝没看过、灰中性
- **开 agent 只有两种办法**：选文件夹开新会话；从一个会话分叉（每条 Claude 的回复、每组工具调用后面的分叉图标「从这里分叉」，每条你的消息后面的铅笔图标「编辑并分叉」）。分叉出来的会话挂在原会话下面
- **继续**：Claude 正在 mixer 里运行时发送的会排队，本次运行结束（或被中断）后一起发出，排队中的可以取消；看着旧版本、终端中打开时不行，输入框自动变成分叉，并写明原因
- **版本**：一条消息在终端里编辑过（回退重写），那里有「第 i / n 版」切换。只是看，不产生新东西
- **不是人和 Claude 说的话**：小结、上下文已压缩（点开看压缩前的摘要）、系统提示是分隔线；后台任务的通知是一行；子代理的回报是单独的卡片
- **确认**：Claude 动手前请求确认。当前会话的出现在对话里；别的会话的浮在右下角
- **用词**：你的「消息」、Claude 的「回复」、「继续」、「分叉」、「编辑并分叉」、「排队」、「运行中」；权限是「自动 / 每次询问 / 计划模式」。界面上的字照这套来

## 设计

token 定义在 `web/src/index.css` 最后一段。界面上只用 token，不直接写 `amber-500`、`text-[13px]` 这种具体值；review 时看到具体值就是要改的地方。

- **状态标记**：`StatusIcon`（`side.tsx`）是唯一的画法，侧栏、项目汇总、顶栏都用它。点 = 要你注意，转圈 = 运行中，灰色空心圈 = 终端中打开
- **颜色**：`waiting` 琥珀 = 要你确认（待确认的点、确认卡片）；`unread` 蓝 = 没看过；`destructive` 红 = 出错；`muted-foreground` 灰 = 中性。只有这四种意思，别的地方不上色（比如「后台任务 · 完成」是灰的）
- **改动色**：`added` / `removed` / `modified` / `renamed`，只用在文件改动和 diff 上（git 工具的习惯配色）
- **字号**：`text-2xs` 11px（时间、徽标、小按钮）、`text-xs` 12px（代码、diff、次要文字）、`text-md` 13px（列表行、工具行）、`text-sm` 14px（消息正文）。名字必须是 t-shirt 尺寸：`cn`（tailwind-merge）不认识的 `text-xxx` 会被当成颜色，和 `text-muted-foreground` 写在一起时被删掉
- **图标按钮**：Button 的 `size="icon-xs"`（24px，消息后面）/ `"icon-sm"`（28px，面板里）/ `"icon"`（32px，顶栏、发送），不在 className 里另写 `size-*`；小文字按钮用 `size="xs"`
- **转圈**：一律 `Spinner`；**展开收起**：一律左边一个 `›`，展开时转 90°；**空状态**：一律 `Placeholder`（`Empty`）
- **时间**：列表里用 `since()`（刚刚 / 5 分钟 / 3 小时 / 2 天 / 10/3），消息上用 `clock()`（10/5 11:58）

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
- `<task-notification>`、`<command-name>`、`<system-reminder>` 这类用户记录是系统插的，显示成事件，不当成人说的话
- 运行中插进来的东西是 `attachment` 的 `queued_command`：可能是人在终端里打的，也可能是任务通知（`commandMode: task-notification`）或子代理的回报（`<agent-message from=…>`），要分开
- 压缩：`system` 的 `compact_boundary` 的 `parentUuid` 是空的，`logicalParentUuid` 指向压缩之后的记录、靠不住；按文件顺序接在它前面最后一个显示节点上。紧跟着的 `isCompactSummary` 用户记录是摘要，不是人说的话
- 从工具调用分叉，`--resume-session-at` 要给工具结果那条 user 记录的 uuid；给工具调用那条，结果会丢

## 运行（`server/runs.ts`）

- 只用本机的 `claude` 命令行，走用户自己的订阅。不用 Agent SDK：它要 API key，而且不允许拿 claude.ai 的登录给别人用
- 参数：`claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode <m> --permission-prompt-tool mcp__mixer__approve --mcp-config <临时文件> [--resume <id> [--fork-session [--resume-session-at <uuid>]]]`，问题从 stdin 写入
- 分叉全交给命令行：`--fork-session` 开新会话、原会话不动；`--resume-session-at` 是一条 assistant 记录的 uuid，只带到它为止的上下文（命令行帮助里没写，试过可用）。新会话文件里原会话的记录原样复制（uuid 不变），所以「第一条记录的 uuid 相同」= 一家；文件建立之后的第一句是它自己的标题
- 确认：Claude 要用需要许可的工具时调 `mcp__mixer__approve`，它 POST 到 `/api/approvals`（带 `x-mixer-token`，每次启动随机生成），挂起直到网页上点了允许或拒绝；10 分钟没人管按拒绝处理。只读的命令（如 `echo`）Claude Code 自己会放行，不会来问
- 会话正在 mixer 里跑时续接就进队列（`runs.ts` 的 `queue`，只在内存里，重启就没了）；运行结束时（跑完、出错、被停）把这个会话排着的话按顺序用空行连成一条续接
- 会话 90 秒内有写入（终端里可能正开着）就不让续接，免得两边同时写一个会话；最近那次写入是 mixer 自己跑完的就放行（按 `state.json` 判断，mixer 重启了也认得）
- 新会话可以开在家目录里任意文件夹（`server/dirs.ts`，没开过会话的也行）。项目 id 是 claude 的规则：路径里非字母数字的字符都换成 `-`

## 安全

能在这台 Mac 上执行命令，所以：
- 服务只听 127.0.0.1；写的接口只认本机或同源 https 的 Origin
- 放到外网只能经 Cloudflare Tunnel，而且前面必须挂 Cloudflare Access（只放行自己的邮箱）。不能撤掉 Access 只留隧道

## 部署

- 常驻：launchd `~/Library/LaunchAgents/com.mixer.server.plist`（PATH 里要有 `claude`、node、git），日志 `~/Library/Logs/mixer.log`。改了 server 代码后重启：`launchctl kickstart -k gui/$(id -u)/com.mixer.server`
