# mixer

远程看、远程驱动本机的 Claude Code 会话。只给自己用。

## 用的人只需要懂这些

- **项目**：一个文件夹。项目页能开新会话、看文件和改动
- **侧栏是工作区**：只放你放进来的文件夹和会话，一开始是空的。新会话、分叉、在 mixer 里跑过的会话自动放进来；已有的从「浏览会话」里挑（点一个就打开并放进来）。文件夹按你拖的顺序（按住文件夹图标拖），新放进来的在最上面；文件夹里的会话按时间排，新的在上面。移出：电脑上指着会话点 ×、文件夹的「…」；手机上在会话顶栏的图钉。移出不删记录。手机上侧栏从左边拉出来，跟着手指走，松手时甩得快或拉过一半就打开
- **Codex**：本机 Codex 的会话也在「浏览会话」里（标着 Codex），能放进工作区、打开看，和同一个文件夹的 Claude 会话在一组。现在只能看，继续、分叉要回到 Codex 里
- **会话**：侧栏每行右边是时间和状态标记，看侧栏就知道哪些完成了、哪些在运行。标记全站一套，都是小点：待确认是琥珀点、带一圈扩散；运行中是蓝点、带一圈扩散；已完成未读是蓝点；出错未读是红点；终端中打开是灰色空心圈。颜色只有这几种意思：琥珀要你确认、红出错、蓝 Claude 在跑或跑完没看、灰中性
- **开 agent 只有两种办法**：选文件夹开新会话；从一个会话分叉（每条 Claude 的回复、每组工具调用后面的分叉图标「从这里分叉」，每条你的消息后面的铅笔图标「编辑并分叉」）。分叉出来的会话挂在原会话下面
- **继续**：Claude 正在 mixer 里运行时发送的会排队，本次运行结束（或被中断）后一起发出，排队中的可以取消；看着旧版本、终端中打开时不行，输入框自动变成分叉，并写明原因
- **用时**：每条回复后面、复制和分叉的左边，是从这一轮开头（你的消息，或叫醒 Claude 的后台任务通知）到这条回复用了多久
- **版本**：一条消息在终端里编辑过（回退重写），那里有「第 i / n 版」切换。只是看，不产生新东西
- **不是人和 Claude 说的话**：小结、上下文已压缩（点开看压缩前的摘要）、系统提示是分隔线；后台任务的通知是一行；子代理的回报是单独的卡片
- **运行中**：你发的消息、正在写的回复、正在写参数的工具调用直接接在对话末尾，样子和写完的一样，刷新也还在；正在执行的那一步带蓝色 ping 点和耗时（工具组收着也露出来），什么都没在动时末尾留一个 ping 点；输入框那一排有时长和停止。虚线框只用在排队的消息上，意思是「还没发出」
- **滚动**：停在底部时新内容长出来跟着滚，往上翻了就不跟；右下角「↓」回到最新，离开后有新内容带蓝点。长对话先只画最后一段，往上翻快到顶时自动接上更早的，位置不跳；目录里点到还没画的那条，先画出来再跳过去
- **消息不丢**：输入框随打随存（这台设备上）；发出去的真写进会话记录才算数，没发出去的放回输入框
- **上下文**：输入框右下角的小圆环是你正在看的那条路上用了多少上下文（手机上只有百分比）
- **输入框底下**：权限、模型（选了之后这个会话一直用它；没选过就接着用上一条回复的那个系列）、skill（打「/」或点按钮，选了在开头插入「/名字 」）、图片（选图或粘贴，点缩略图画箭头、随手画线）
- **用量**：侧栏最底下是订阅的本周用量、什么时候重置，顺带 5 小时窗口。mixer 里每次运行时更新，终端里用掉的要等下次 mixer 运行才算进来，旧了写明多久前更新
- **确认**：Claude 动手前请求确认。当前会话的出现在对话里；别的会话的浮在右下角
- **用词**：你的「消息」、Claude 的「回复」、「继续」、「分叉」、「编辑并分叉」、「排队」、「运行中」；权限是「自动 / 每次询问 / 计划模式」。界面上的字照这套来

## 设计

token 定义在 `web/src/index.css` 最后一段。界面上只用 token，不直接写 `amber-500`、`text-[13px]` 这种具体值；review 时看到具体值就是要改的地方。

- **状态标记**：`StatusIcon`（`side.tsx`）是唯一的画法，侧栏、项目汇总、顶栏都用它。实心点 = 要你注意，带扩散的蓝点 = 运行中，灰色空心圈 = 终端中打开（90 秒内有不是 mixer 的写入）
- **颜色**：`waiting` 琥珀 = 要你确认（待确认的点、确认卡片）；`unread` 蓝 = 在跑（带扩散）/ 跑完没看过；`destructive` 红 = 出错；`muted-foreground` 灰 = 中性。只有这四种意思，别的地方不上色（比如「后台任务 · 完成」是灰的）
- **改动色**：`added` / `removed` / `modified` / `renamed`，只用在文件改动和 diff 上（git 工具的习惯配色）
- **字号**：`text-2xs` 11px（时间、徽标、小按钮）、`text-xs` 12px（代码、diff、次要文字）、`text-md` 13px（列表行、工具行）、`text-sm` 14px（消息正文）。名字必须是 t-shirt 尺寸：`cn`（tailwind-merge）不认识的 `text-xxx` 会被当成颜色，和 `text-muted-foreground` 写在一起时被删掉
- **图标按钮**：Button 的 `size="icon-xs"`（24px，消息后面）/ `"icon-sm"`（28px，面板里）/ `"icon"`（32px，顶栏、发送），不在 className 里另写 `size-*`；小文字按钮用 `size="xs"`
- **加载中**：一律 `Spinner`（和状态标记同样的点带扩散，颜色跟文字）；Claude 运行中用 `StatusIcon` 的 `running`（蓝）。不用转圈；**展开收起**：一律左边一个 `›`，展开时转 90°；**空状态**：一律 `Placeholder`（`Empty`）
- **时间**：列表里用 `since()`（刚刚 / 5 分钟 / 3 小时 / 2 天 / 10/3），消息上用 `clock()`（10/5 11:58）

## 跑

- `pnpm start`：服务在 127.0.0.1:4848（`MIXER_PORT` 可改）。`web/src` 比 `web/dist` 新时，启动会先重新打包
- `pnpm dev`：Vite 开发服务（5173），`/api` 转到 4848
- `pnpm check`：类型检查（web 和 server 各一遍）
- `pnpm mixer`：手机怎么访问。`setup cloudflare`（Tunnel + Access，要有托管在 Cloudflare 的域名）/ `setup funnel`（Tailscale Funnel + passkey，不要域名）/ `pair`（出二维码，手机扫了建 passkey）/ `passkeys [rm <id>]`。改的是 `data/access.json`，服务不用重启

## 结构

| 位置 | 做什么 |
|---|---|
| `server/sessions.ts` | 读 `~/.claude/projects/<目录>/<会话>.jsonl`，拼成显示用的节点树。记下读到第几个字节，文件长了只读新写的；节点新建、改过记 `rev`，网页带 `?since=<version>` 只拿之后变了的。工具调用的参数、结果在节点里只是预览，点开时拿 `/tool/<id>` |
| `server/codex.ts` | 读 Codex 的会话（`~/.codex/sessions/年/月/日/rollout-*.jsonl`），拼成和 Claude 一样的节点和会话信息；`sessions.ts` 按会话 id 分派过来、列表里合进去。文件变了整个重读 |
| `server/jsonl.ts` | 按 `\n` 一行一行读（两边共用） |
| `server/repo.ts` | 仓库文件、git 状态、diff、提交；`inside()` 防止路径跑出仓库 |
| `server/dirs.ts` | 新会话选文件夹：列子文件夹、新建，只认家目录里面的 |
| `server/access.ts` | 谁能用：本机直接放行；Cloudflare Access 验 JWT（签名、iss、aud、邮箱）；passkey 登录的签名 cookie。配置 `data/access.json`（不进 git），按修改时间重读 |
| `server/tunnel.ts` | `access.json` 里有 `cloudflare.tunnel` 就起一个 cloudflared（自己写一份配置，不读 `~/.cloudflared/config.yml`），挂了退避再起 |
| `server/cli.ts` | `pnpm mixer …` |
| `server/state.ts` | `data/state.json`（不进 git）：每个会话在 mixer 里最后跑完的时间、人最后看它的时间 →「跑完了没看」；工作区（文件夹的顺序、放进来的会话） |
| `server/workspace.ts` | `/api/workspace`：工作区的文件夹带上放进来的会话。第一次（还没有工作区）把运行中、跑完没看的放进去。`/api/tree`（扫所有会话）只有「浏览会话」用 |
| `server/runs.ts` | 起 `claude -p` 跑一次（新会话 / 续接 / 分叉 / 从中间分叉），管确认请求 |
| `server/skills.ts` | 输入框里能选的 skill：名字按 init 事件记下的，加上扫 skill 文件夹补的新建的，描述从 `SKILL.md` 读 |
| `mcp/approve.ts` | 每次运行带的 MCP 服务 `mixer`，工具 `approve` 把确认请求转给网页 |
| `server/main.ts` | HTTP 接口、SSE（`/api/events`）、监视 transcript 目录；打包出来的 js / css 第一次被要时压成 br、gzip 存着 |
| `web/` | Vite + React + Tailwind v4 + shadcn（radix-nova），组件在 `web/src/components/ui` |
| `side.tsx` / `browse.tsx` | 侧栏（工作区，文件夹用 dnd-kit 拖）/ 浏览会话的对话框 |
| `web/src/components/login.tsx` | `Gate`：先问 `/api/auth/status`，没认出来就是登录页（配对码建 passkey / passkey 登录）；接口回 401 时也换成它 |
| `web/src/lib/live.tsx` | 全页面共用的项目树、运行、确认请求，和会话状态的算法 |
| `web/src/lib/tail.ts` | 运行输出流 → 正在写的那几段，服务端和网页共用。服务端每次运行攒一份（`/api/runs/:id/tail` 是快照），网页先拿快照、再按序号接推送（`run-event` 带 `seq`），接不上就重新拿 |
| `useStream`（`conversation.tsx`） | 还没写进会话记录的那几段变成和记录里一样的节点接在对话末尾；记录里有了同一段（「消息 id : 第几段」）就换成记录里的 |
| `web/src/lib/drawer.ts` | 手机上的侧栏抽屉：位置是进度 0–1，拖的时候直接改样式跟手（不经过 React），松手按速度或过没过半动画到底；手势在 `side.tsx` 的 `useSwipe` |
| `web/src/lib/outbox.ts` | 草稿随打随存；发件箱：发出去的写进记录才删，没发出去的放回输入框，其实发出去了的把输入框里原样的清掉 |

## 会话记录的坑（`server/sessions.ts`）

- 记录靠 `uuid` / `parentUuid` 连成树；`isSidechain` 是 subagent。subagent 的记录在 `<会话>/subagents/agent-<id>.jsonl`，旁边的 `.meta.json` 有类型和描述
- 只按 `\n` 切行：行里有 U+2028，Node 的 readline 会在那里切断
- 同一个 uuid 会被重复追加，按第一次出现的算
- `parentUuid` 偶尔指向后面才写的记录（先写回复、后写它挂着的附带记录）：边读边拼时先当根，那条读到了再接上
- 并行的工具调用在树上看着像分叉，其实不是分支；分支只看用户消息
- `<task-notification>`、`<command-name>`、`<system-reminder>` 这类用户记录是系统插的，显示成事件，不当成人说的话
- 运行中插进来的东西是 `attachment` 的 `queued_command`：可能是人在终端里打的，也可能是任务通知（`commandMode: task-notification`）或子代理的回报（`<agent-message from=…>`），要分开
- 压缩：`system` 的 `compact_boundary` 的 `parentUuid` 是空的，`logicalParentUuid` 指向压缩之后的记录、靠不住；按文件顺序接在它前面最后一个显示节点上。紧跟着的 `isCompactSummary` 用户记录是摘要，不是人说的话
- 一条 assistant 记录是一条消息里的一段：同一个 `message.id` 的记录按文件顺序数，第几条就是流里 `content_block` 的第几段（`index`），空的思考也算。`sessions.ts` 给节点标上 `key`「消息 id : 第几段」
- 上下文用量：每条 assistant 记录的 `message.usage` 里 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。窗口大小记录里没有，只有 `claude -p` 结束时 `result` 事件的 `modelUsage.<模型>.contextWindow` 有，按模型记进 `state.json`
- 调 skill：先是一条 `<command-name>/名字</command-name><command-args>…` 的 user 记录，下一条 isMeta 的是 skill 正文（`Base directory for this skill:` 开头）。有正文的才是 skill，显示成人说的「/名字 参数」；`/clear`、`/model` 这类后面没有正文，不显示
- 从工具调用分叉，`--resume-session-at` 要给工具结果那条 user 记录的 uuid；给工具调用那条，结果会丢

## Codex 记录的坑（`server/codex.ts`）

- 格式跟着版本变：0.105 起有的 `response_item`（`message` / `reasoning` / `function_call` / `custom_tool_call` / `web_search_call` 和 `*_output`）各版本都有，回复、推理摘要、工具从这里拿。推理常常只有加密内容、`summary` 是空的，就不显示
- 人说的话从事件层拿：老的是 `event_msg` 的 `user_message`（`images` 是 data URL），新的是 `item_completed` 的 `UserMessage`。`response_item` 里 role=user 的混着 AGENTS.md、环境信息、插件推荐这些注入的
- 回答 Codex 提的问题是 `<send_user_message_question_reply>[{question, answer}]`，显示 answer
- 第一行 `session_meta` 很长（带系统提示）。`thread_source` 不是 `user`（比如 `guardian_review` 自动审批）、有 `parent_thread_id` 的是内部会话，不列
- 标题在 `~/.codex/session_index.jsonl`（`thread_name`，同一个 id 后写的算）。记录是一条直线，没有版本
- 上下文：`token_count` 的 `info.last_token_usage`（input + output）和 `model_context_window`；模型在 `turn_context.model`
- 命令行没在 PATH 上，是 Codex.app 带的：`/Applications/Codex.app/Contents/Resources/codex`。继续会话要用 `codex app-server`（JSON-RPC，有 `thread/fork`、`turn/start`、`item/*/requestApproval`）；`codex exec` 不能中途确认

## 运行（`server/runs.ts`）

- 只用本机的 `claude` 命令行，走用户自己的订阅。不用 Agent SDK：它要 API key，而且不允许拿 claude.ai 的登录给别人用
- 参数：`claude -p --output-format stream-json --verbose --include-partial-messages --thinking-display summarized --permission-mode <m> --permission-prompt-tool mcp__mixer__approve --mcp-config <临时文件> [--model <别名>] [--input-format stream-json] [--resume <id> [--fork-session [--resume-session-at <uuid>]]]`，问题从 stdin 写入
- `--thinking-display summarized`（帮助里没写）：思考给摘要，流里有 `thinking_delta`、记录里也有文字。不加的话 `-p` 下思考大多是空的、只有签名，没东西可看
- 带图片时加 `--input-format stream-json`，stdin 写一行 `{"type":"user","message":{"role":"user","content":[文字块, 图片块…]}}`。这样发的「/名字」不会被当成命令直接展开，Claude 会自己调 Skill 工具，结果一样
- 用量：流里的 `rate_limit_event` 的 `rate_limit_info.unifiedWindows` 有 `five_hour`、`seven_day` 的 `utilization`（0–1）和 `resetsAt`（秒），记进 `state.json`，推 `limits` 事件
- init 事件里有这个文件夹能用的全部 `skills` 和 `plugins`（内置的 skill 磁盘上没有文件），每次运行都按项目记进 `state.json`
- 分叉全交给命令行：`--fork-session` 开新会话、原会话不动；`--resume-session-at` 是一条 assistant 记录的 uuid，只带到它为止的上下文（命令行帮助里没写，试过可用）。新会话文件里原会话的记录原样复制（uuid 不变），所以「第一条记录的 uuid 相同」= 一家；文件建立之后的第一句是它自己的标题
- 确认：Claude 要用需要许可的工具时调 `mcp__mixer__approve`，它 POST 到 `/api/approvals`（带 `x-mixer-token`，每次启动随机生成），挂起直到网页上点了允许或拒绝；10 分钟没人管按拒绝处理。只读的命令（如 `echo`）Claude Code 自己会放行，不会来问
- 会话正在 mixer 里跑时续接就进队列（`runs.ts` 的 `queue`，只在内存里，重启就没了）；运行结束时（跑完、出错、被停）把这个会话排着的话按顺序用空行连成一条续接
- 会话 90 秒内有写入（终端里可能正开着）就不让续接，免得两边同时写一个会话；最近那次写入是 mixer 自己跑完的就放行（按 `state.json` 判断，mixer 重启了也认得）
- 新会话可以开在家目录里任意文件夹（`server/dirs.ts`，没开过会话的也行）。项目 id 是 claude 的规则：路径里非字母数字的字符都换成 `-`

## 安全

能在这台 Mac 上执行命令，所以：
- 服务只听 127.0.0.1；写的接口只认本机或同源 https 的 Origin
- `/api/` 全部先过 `access.who()`（`/api/auth/` 那几个登录用的除外，远程一分钟 30 次），页面本身谁都能拿。MCP 的确认请求只认 token
- 「本机」= Host 是 127.0.0.1 / localhost、对方是回环地址、没有任何代理加的头（x-forwarded-for、cf-*、tailscale-*）。隧道转来的都是远程；Host 不对（DNS rebinding）也是远程
- 放到外网两种：Cloudflare Tunnel + Access（mixer 再验一遍 JWT，隧道配错了漏掉 Access 也进不来）；Tailscale Funnel + passkey（公网，前面没人拦，全靠 mixer 的登录）。配 Funnel 时先写配置再开，开完自检经 Funnel 的请求不会被当成本机
- `access.json` 什么都没配（原来那种自己挂 Access 的用法）：远程的只认带 Access JWT 的、不验签，启动后第一次远程请求时提示去 `pnpm mixer setup cloudflare`
- passkey：配对码一次性、10 分钟；登录要 user verification；cookie 30 天、HMAC 签名，删掉 passkey 它登录的 cookie 一起作废

## 部署

- 常驻：launchd `~/Library/LaunchAgents/com.mixer.server.plist`（`KeepAlive`，PATH 里要有 `claude`、node、git），日志 `~/Library/Logs/mixer.log`
- 改了自己的代码会自动换上（`main.ts`）：停手 3 秒、mixer 也闲下来（没有运行、排队、待确认）之后，服务端的代码（`server/`、`mcp/`、`web/src/lib/tail.ts`）类型检查过了就退出、launchd 拉起新的；只改了页面就重新打包。检查没过不重启，日志里有原因。要马上重启：`launchctl kickstart -k gui/$(id -u)/com.mixer.server`
