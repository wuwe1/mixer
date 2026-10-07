# mixer

远程看、远程驱动本机的 Claude Code 会话。只给自己用。

## 用的人只需要懂这些

- **项目**：一个文件夹。项目页能开新会话、看文件和改动
- **侧栏是工作区**：只放你放进来的文件夹和会话，一开始是空的。新会话、分叉、在 mixer 里跑过的会话自动放进来；已有的从「浏览会话」里挑（点一个就打开并放进来）。文件夹按你拖的顺序（按住文件夹图标拖），新放进来的在最上面；文件夹里的会话按时间排，新的在上面。移出：电脑上指着会话点 ×、文件夹的「…」；手机上在会话顶栏的图钉；长按（手机）、右键（电脑）一行也有菜单。移出不删记录，移出后提示里能「撤销」（文件夹连同里面的会话放回原处）。手机上侧栏的行高 44px 好按。手机上侧栏从左边拉出来，跟着手指走，松手时甩得快或拉过一半就打开
- **面板**：会话右边的目录、文件、改动。顶栏右边一个按钮开关，三个 tab 在面板顶上（目录带你的消息条数、改动带这个会话改过几个文件），打开的是这台设备上次看的那个。手机上是整屏一页，也能从右边往左拉出来（和侧栏一样跟手），往右滑关上；按在能横着滚的代码、表格上是在滚它
- **Codex**：开新会话时在模型菜单里选（Claude Code、Codex 的模型分两组列在一起，选了哪组的就是哪个；记在这台设备上）；本机 Codex 的会话也在「浏览会话」里（标着 Codex），和同一个文件夹的 Claude 会话在一组。一个会话只能是一种。Codex 的会话和 Claude 的一样能继续、排队、停止、确认、分叉，只是分叉按轮：从一条回复分叉带上的是它那一整轮
- **会话**：侧栏每行右边是时间和状态标记，看侧栏就知道哪些完成了、哪些在运行。标记全站一套，都是小点：待确认是琥珀点、带一圈扩散；运行中是蓝点、带一圈扩散；后台任务在跑（Claude 闲着，跑完了会叫醒它）是蓝色空心圈、带一圈扩散；已完成未读是蓝点；出错未读是红点；终端中打开是灰色空心圈。颜色只有这几种意思：琥珀要你确认、红出错、蓝 Claude 在跑或跑完没看、绿一步工具调用成功了、灰中性。Claude Code 会在启动时删掉 `cleanupPeriodDays`（默认 30）天没动的会话：7 天内要被清理的，时间那里换成灰色的「N 天后清理」/「今天清理」（Codex 不清理）
- **删除**：侧栏长按 / 右键会话的菜单里「删除…」，先问一句。Claude 的会话记录（和旁边的子代理文件夹）挪进废纸篓里「mixer 删除的会话 …」文件夹，带一份「原来的位置.txt」，挪回去就恢复，终端里 `claude --resume` 也看不到了；Codex 的用 `codex archive` 归档，`codex unarchive` 恢复。在 mixer 里运行中、有后台任务在跑的、有排队的、待确认的、终端中打开的不让删。分叉出来的会话是完整的一份，留着
- **开 agent 只有两种办法**：选文件夹开新会话；从一个会话分叉（每条 Claude 的回复、每组工具调用后面的分叉图标「从这里分叉」，每条你的消息后面的铅笔图标「编辑并分叉」；平时收着，电脑上指着、手机上点一下那条才出现，最后一条回复的常驻，手机上工具组的常驻）。从最新处分叉就是最后一条后面的那个图标，输入框里不另选。分叉出来的会话挂在原会话下面
- **继续**：Claude 正在 mixer 里运行时发送的会排队，本次运行结束（或被中断）后一起发出，排队中的可以取消；看着旧版本、终端中打开时不行，输入框自动变成分叉，并写明原因
- **后台任务**：Claude 开的后台命令、Monitor、后台子代理在跑时，这个会话的 claude 进程一直开着，跑完了通知会叫醒 Claude 接着做（和终端里一样）。输入框那一排有「后台 N」（手机上只有个数），点开列出每一个：是什么、跑了多久、停止；后台命令能展开看输出的最后一段。这时 Claude 闲着，发的消息直接接着跑，不排队。停止（输入框那一排的方块）只停 Claude 这一轮，后台任务接着跑
- **用时**：每条回复后面、复制和分叉的左边，是从这一轮开头（你的消息，或叫醒 Claude 的后台任务通知）到这条回复用了多久
- **版本**：一条消息在终端里编辑过（回退重写），那里有「第 i / n 版」切换。只是看，不产生新东西
- **子代理**：Claude 开的子代理（Agent 工具调用）在跑时，那一行带蓝色 ping 点和耗时，下面一行灰字是它现在在做什么（最后一个工具调用，或者最后一段回复的第一行）；工具组收着时在跑的子代理每个都露出来（最多 3 个，再多写「还有 N 个」）。点那一行打开它的对话，开着时跟着它往下长；跑完了那一行留着，点开看完整的。往上翻着时「↓」左上角的灰色小数字是还在跑的子代理有几个
- **不是人和 Claude 说的话**：小结、上下文已压缩（点开看压缩前的摘要）、系统提示是分隔线；后台任务的通知是一行；子代理的回报是单独的卡片
- **运行中**：你发的消息、正在写的回复、正在写参数的工具调用直接接在对话末尾，样子和写完的一样，刷新也还在；正在执行的那一步带蓝色 ping 点和耗时（工具组收着也露出来；跑完了的组收着只剩一行，就是最后那一步，成功绿点、失败红点，后面跟着「N 次」），什么都没在动时末尾留一个 ping 点；输入框那一排有停止，带着时长。虚线框只用在排队的消息上，意思是「还没发出」
- **滚动**：停在底部时新内容长出来跟着滚，往上翻了就不跟；右下角「↓」回到最新，离开后有新内容带蓝点。长对话先只画最后一段，往上翻快到顶时自动接上更早的，位置不跳；目录里点到还没画的那条，先画出来再跳过去。切走再切回来，先显示上次的内容、停在离开时的位置（当时在底部就还在底部），新的随后补上
- **主屏幕**：添加到主屏幕后，打开时回到上次看的地方
- **消息不丢**：输入框随打随存（这台设备上）；发出去的真写进会话记录才算数，没发出去的放回输入框
- **上下文**：输入框右下角的小圆环是你正在看的那条路上用了多少上下文（只有百分比，多少 token 指着看）
- **输入框底下**：权限、模型和思考强度（一个菜单：默认、各系列最新的（出了新版自动换）、固定版本，最下面一排思考强度，只列这个模型支持的；列表是问本机的 claude / codex 的，Claude 出了新模型菜单里就有，7 天内标「新」。选了之后这个会话一直用它；没选过就接着用上一条回复的那个系列）、「+」里是图片（选图或粘贴，点缩略图画箭头、随手画线）和 skill（也可以打「/」，选了在开头插入「/名字 」）。只能分叉时发送按钮是分叉的图标
- **用量**：侧栏最底下一行是 Claude、Codex 所有窗口里用得最多的那个（「Codex · 5 小时 82% · 10/6 19:40 重置」）和一条灰色细条，点开「用量」看每个账号的每个窗口（电脑上是浮层，手机上从下面出来）；用 pi 花了钱的，每个 provider 一段「pi · deepseek」，今天、本月花了多少美元（按 pi 自己记的价，本月花得多的在前，不算进侧栏那一行）。Claude 的 mixer 里每次运行时更新，终端里用掉的要等下次 mixer 运行才算进来；Codex 的每 10 分钟读一次、跑完一轮也读；pi 的每分钟读一次。旧了写明多久前更新。正在看的会话那个 agent 有窗口用到 80% 以上，输入框里上下文旁边多一句「5 小时 82%」
- **图解**：Claude 讲概念、流程、算法、取舍、数据时，会在回复里放图：流程图、时序图、树、图表、逐帧演示（上一步 / 下一步 / 播放）、对比、小测验等。指着图表看数值，「看数据」换成表格。只有在 mixer 里跑的会话里 Claude 才知道能画（终端里开的会话不知道）；写坏的那一块显示「画不出来」和哪里不对，别的照画
- **确认**：Claude 动手前请求确认。当前会话的出现在对话里；别的会话的浮在右下角
- **用词**：你的「消息」、Claude 的「回复」、「继续」、「分叉」、「编辑并分叉」、「排队」、「运行中」；权限是「自动 / 每次询问 / 计划模式」。界面上的字照这套来

## 设计

token 定义在 `web/src/index.css` 最后一段。界面上只用 token，不直接写 `amber-500`、`text-[13px]` 这种具体值；review 时看到具体值就是要改的地方。

- **状态标记**：`StatusIcon`（`side.tsx`）是唯一的画法，侧栏、项目汇总、顶栏都用它。实心点 = 要你注意，带扩散的蓝点 = 运行中，带扩散的蓝色空心圈 = 后台任务在跑（Claude 闲着），灰色空心圈 = 终端中打开（90 秒内有不是 mixer 的写入）；工具组收着时露出的最后一步，跑完了是绿点（成功）/ 红点（失败）
- **颜色**：`waiting` 琥珀 = 要你确认（待确认的点、确认卡片）；`unread` 蓝 = 在跑（带扩散）/ 跑完没看过；`success` 绿 = 一步工具调用成功了；`destructive` 红 = 出错；`muted-foreground` 灰 = 中性。只有这五种意思，别的地方不上色（比如「后台任务 · 完成」是灰的）
- **改动色**：`added` / `removed` / `modified` / `renamed`，只用在文件改动和 diff 上（git 工具的习惯配色）
- **系列色**：`--series-1…8`，只用在图解的图表里，表示「这是哪一组数据」，按顺序用、不循环（dataviz 参考调色板，深浅色各一套）。图解别的地方不上色，强调靠字重和黑白对比
- **字号**：`text-2xs` 11px（时间、徽标、小按钮）、`text-xs` 12px（代码、diff、次要文字）、`text-md` 13px（列表行、工具行）、`text-sm` 14px（消息正文）、`text-lg` 18px（标题：侧栏的 mixer、项目页的项目名）；代码块、diff 的行高用 `leading-code`。名字必须是 t-shirt 尺寸：`cn`（tailwind-merge）不认识的 `text-xxx` 会被当成颜色，和 `text-muted-foreground` 写在一起时被删掉
- **图标按钮**：Button 的 `size="icon-xs"`（24px，消息后面）/ `"icon-sm"`（28px，面板里）/ `"icon"`（32px，顶栏、发送），不在 className 里另写 `size-*`；小文字按钮用 `size="xs"`（自带 `text-2xs`）/ `"sm"`（自带 `text-xs`），className 里不再写字号、高度
- **加载中**：一律 `Spinner`（和状态标记同样的点带扩散，颜色跟文字）；Claude 运行中用 `StatusIcon` 的 `running`（蓝）。不用转圈；**展开收起**：一律左边一个 `›`，展开时转 90°；**空状态**：一律 `Placeholder`（`Empty`）；渲染出错是 `Boundary`（`placeholder.tsx`），显示「出错了」和「刷新」
- **时间**：列表里用 `since()`（刚刚 / 5 分钟 / 3 小时 / 2 天 / 10/3），消息上用 `clock()`（10/5 11:58）

## 跑

- `pnpm start`：服务在 127.0.0.1:4848（`MIXER_PORT` 可改）。`web/src` 比 `web/dist` 新时，启动会先重新打包
- `pnpm dev`：Vite 开发服务（5173），`/api` 转到 4848
- `pnpm check`：类型检查（web、server、test 各一遍）
- `pnpm test`：node:test，测试在 `test/*.test.ts`、fixtures 是小的 jsonl（`test/fixtures/`）。HOME、`MIXER_DATA` 指到临时目录，不读本机的 `~/.claude`、`~/.codex`、`data/`。CI（`.github/workflows/ci.yml`，macOS）跑 check、test、build
- `pnpm mixer`：手机怎么访问。`setup cloudflare`（Tunnel + Access，要有托管在 Cloudflare 的域名）/ `setup funnel`（Tailscale Funnel + passkey，不要域名）/ `pair`（出二维码，手机扫了建 passkey）/ `passkeys [rm <id>]`。改的是 `data/access.json`，服务不用重启

## 结构

| 位置 | 做什么 |
|---|---|
| `server/sessions.ts` | 读 `~/.claude/projects/<目录>/<会话>.jsonl`，拼成显示用的节点树。记下读到第几个字节，文件长了只读新写的；节点新建、改过记 `rev`，网页带 `?since=<version>` 只拿之后变了的。工具调用的参数、结果在节点里只是预览，点开时拿 `/tool/<id>`；思考也只给前 120 字（`cut`），展开时拿 `/thinking/<uuid>`。读过的会话按最近使用留在内存，总量超 200MB（按文件大小算）丢最久没用的。会话信息带 `expires`：修改时间 + `~/.claude/settings.json` 的 `cleanupPeriodDays`（默认 30，文件改了重读），Codex 的是 null |
| 子代理（`sessions.ts` 的 `subs` / `sub` / `agent`） | `/api/sessions/:项目/:会话/agents` 列出 `<会话>/subagents/` 里的子代理：`agent-<id>.meta.json` 的 `toolUseId`（开它的 Agent 工具调用）、类型、描述，`latest`（它在做什么：最后一个工具调用「工具名 摘要」或最后一段回复的第一行，80 字；10 分钟没动的不读记录、给 null），`mtime`。`main.ts` 监视到子代理的记录、meta 变了（每个 0.5 秒一次）推 `agent`（同样的一份带上 project、session）。`/agents/<id>?since=` 和会话一样给增量 |
| `server/codex.ts` | 读 Codex 的会话（`~/.codex/sessions/年/月/日/rollout-*.jsonl`），拼成和 Claude 一样的节点和会话信息；`sessions.ts` 按会话 id 分派过来、列表里合进去。文件变了整个重读，按 uuid 和上一份比出增量（和 Claude 一样的「epoch:rev」：没变的留原来的 rev；上一份的节点没了就换 epoch）。推理摘要同样只给开头，全文走 `/thinking/<uuid>` |
| `server/codex-run.ts` | 在 mixer 里跑 Codex：一个常驻的 `codex app-server`，item 通知翻成和 Claude 一样的 stream_event（tail.ts 原样用），确认请求转成 mixer 的确认。`runs.ts` 按会话是谁的分派过来，排队、停止、结束两边一套。`request` / `onNote` 给别处用这个连接（用量） |
| `server/jsonl.ts` | 按 `\n` 一行一行读（两边共用） |
| `server/repo.ts` | 仓库文件、git 状态、diff、提交；`inside()` 防止路径跑出仓库。git 状态是异步的：同一个仓库同时来的共用一次，缓存 1.5 秒 |
| `server/dirs.ts` | 新会话选文件夹：列子文件夹、新建，只认家目录里面的 |
| `server/access.ts` | 谁能用：本机直接放行；Cloudflare Access 验 JWT（签名、iss、aud、邮箱）；passkey 登录的签名 cookie。配置 `data/access.json`（不进 git；`data/` 的位置 `MIXER_DATA` 可改，测试用），按修改时间重读 |
| `server/tunnel.ts` | `access.json` 里有 `cloudflare.tunnel` 就起一个 cloudflared（自己写一份配置，不读 `~/.cloudflared/config.yml`），挂了退避再起 |
| `server/cli.ts` | `pnpm mixer …` |
| `server/state.ts` | `data/state.json`（不进 git）：每个会话在 mixer 里最后跑完的时间、人最后看它的时间 →「跑完了没看」；工作区（文件夹的顺序、放进来的会话）；每个账号最后的用量（旧版本的 `limits` 起来时换成 Claude 的账号） |
| `server/usage.ts` | 用量：每个账号一样的样子（`web/src/lib/usage.ts` 的 `Account`：`quota` 是窗口，`spend` 是花的钱、`budget` 还没地方设），`hello` 里带整张表，变了推 `usage`。Claude 的来自 `rate_limit_event`；Codex 的是 app-server 的 `account/rateLimits/read`（借 `codex-run.ts` 的连接：起来 15 秒后、每 10 分钟、`account/rateLimits/updated` 和 `turn/completed` 后攒 3 秒，没登录不读、出错不吵）；pi 的是 `~/.pi/agent/sessions/<目录>/*.jsonl` 里每条回复（`message` 的 role assistant）的 `provider` 和 `usage.cost.total`（美元），按 provider、本地日期（回复自己的 `message.timestamp`，毫秒）按天记在内存，算出今天、本月，本月花了钱的一个 provider 一个账号 `pi:<provider>`；每个文件记读到第几个字节、只读新写的（半行等写完，变短、换了 ino 从头读，没了不算），起来 5 秒后、之后每分钟扫一遍（换天换月也靠它），数变了才推，不进 `state.json`。压缩、分支小结的花费没有 provider，不算。`web/src/lib/usage.ts` 挑最紧的窗口（过了重置时间的不算，`spend` 不参与）给侧栏、输入框，`money` 写钱（`$0.42`，不到一分「<$0.01」） |
| `server/workspace.ts` | `/api/workspace`：工作区的文件夹带上放进来的会话（`add` 可带 `sessions`：撤销移出文件夹时一起放回）。第一次（还没有工作区）把运行中、跑完没看的放进去。`/api/tree`（扫所有会话）只有「浏览会话」用 |
| `server/trash.ts` | 删会话（`POST /api/sessions/:项目/:会话/delete`）：Claude 的 jsonl 和 `<会话>/` 用 rename 挪进 `~/.Trash/mixer 删除的会话 <标题前 20 字> (<id 前 8 位>)`，写 `原来的位置.txt`；Codex 的 `codex archive <id>`（execFile，失败 500 带 stderr）。`runs.busy()`（运行中、从它分叉中、排队、待确认）和 90 秒内不是 mixer 的写入回 409。删完 `state.forget`（移出工作区、忘掉跑完 / 看过 / 模型）、丢 `sessions.ts` / `codex.ts` 的缓存，推 `workspace` |
| `server/runs.ts` | 起 `claude -p`（新会话 / 续接 / 分叉 / 从中间分叉），一个会话一个进程（`Proc`），一轮是一次运行（`Run`）；管确认请求、后台任务（`stopTask`、`taskOutput`），开着的进程推 `host`、在 hello 的 `hosts` 里 |
| `server/skills.ts` | 输入框里能选的 skill：名字按 init 事件记下的，加上扫 skill 文件夹补的新建的，描述从 `SKILL.md` 读 |
| 图解（`web/src/lib/visual.ts`） | 回复里 ```ui 代码块的格式：每种组件的 zod 定义和「什么时候用」，`prompt()` 给 Claude 的说明（`runs.ts` 起进程时 `--append-system-prompt` 带上，从定义生成，约 2k token），`parse` 读 JSON（正在写的半截也读：没写完的字符串照已有的算、括号补上，`done` 说明写完没有），`checkNode` / `check` 逐个组件校验（中文的错误，带路径）。不碰 React，服务端也用；改它和改 `tail.ts` 一样算服务端的代码。加一种组件改两处：这里的 `DEFS`、`components/visual/index.tsx` 的 `VIEWS` |
| `server/models.ts` | 能选的模型（`/api/models/claude`、`/api/models/codex`，一个样子：`web/src/lib/model-info.ts` 的 `ModelInfo`，第一项是默认）。Claude 的起一个 `claude -p --safe-mode`（不跑 hooks、不写会话）只发 `control_request` 的 `initialize`，回的 `models` 有默认、别名（最新的）、固定版本、`supportedEffortLevels`；存进 `state.json`，起来 5 秒后、每小时、运行的 init 里 `claude_code_version` 变了、网页要时超过 10 分钟就重读。Codex 的是 `model/list`（`supportedReasoningEfforts`、`defaultReasoningEffort`）。第一次见到的型号记时间（按 agent，头一回那批不算），7 天内 `isNew` |
| `web/src/components/visual/` | 画图解：`markdown.tsx` 遇到 ```ui 交给它（`lazy.tsx` 的 `Visual`，第一次遇到才加载，带着 dagre、katex）。一个组件一个组件地画：没写完的是「正在画」，写完了还不对的是「画不出来」加原因和原文。`graph.tsx` 的 Graph 用 dagre 排；Tree 自己排（dagre 会调换兄弟的先后）；Sequence 自己排；字宽用 canvas 量。`chart.tsx` 按容器宽度画（手机上字不缩小），一个纵轴、悬停出数、能切成表格。`layout.tsx` 的 `usePlayer` / `Controls` 是 Stepper、ArrayViz 共用的播放条 |
| `mcp/approve.ts` | 每次运行带的 MCP 服务 `mixer`，工具 `approve` 把确认请求转给网页 |
| `server/main.ts` | HTTP 接口、SSE（`/api/events`）、监视 transcript 目录；打包出来的 js / css 第一次被要时压成 br、gzip 存着。接口的 JSON 大于 8KB 就压（br 质量 5，不收 br 的 gzip），在线程池里压、不挡别的请求和推送。会话文件变了推 `session`（0.5 秒合一次），在工作区里的带上侧栏那一行（`sessions.row`，不算 parent）。SSE 连上先发 `build`（入口脚本的路径当版本号，重新打包后再发一次），再发 `hello`（`sse.ts`）；每 25 秒一个 `ping`。`keepAliveTimeout` 120 秒：cloudflared 会把空闲连接留约 90 秒，Node 默认的 5 秒会偶发 502。打包不清空 `dist`（开着的旧页面还要按需拿旧的块），打包后删一天前、没被引用的旧文件 |
| `server/sse.ts` | SSE 的连接们。连上先发 `hello`（运行、确认请求、排队、用量、工作区、在跑的那几次正在写的那几段），和之后的事件在同一条流里、先后不会乱；算 hello 期间的事件攒着接在后面。页面拿它整个换掉，不再另外拉 |
| `web/` | Vite + React + Tailwind v4 + shadcn（radix-nova），组件在 `web/src/components/ui` |
| `side.tsx` / `browse.tsx` | 侧栏（工作区，文件夹用 dnd-kit 拖；行上的 ContextMenu 长按 / 右键出菜单，菜单只挂在文件夹那一行，免得长按会话两个菜单一起开；菜单开着时 `useSwipe` 不接手势、行的点按不算；删除的 AlertDialog；别的对话框开着时 `useSwipe` 也不接）/ 浏览会话的对话框 |
| `tasks.tsx` | 输入框那一排的「后台 N」和点开的后台任务列表（电脑上 Popover，手机上底部 Sheet）：类型图标、说明、跑了多久、停止，› 展开输出（开着时每 2 秒拿 `/api/hosts/:进程/tasks/:任务/output`） |
| `usage.tsx` | 侧栏最底下那行用量和点开的「用量」（电脑上 Popover，手机上底部 Sheet）；`pct` / `resets` 输入框的提醒也用 |
| `web/src/components/lazy.tsx` | 首屏用不着的按需加载：浏览会话、新会话、skill 选择第一次打开才拿，项目页、文件、改动面板加载时是 Spinner |
| `composer.tsx` / `fork-dialog.tsx` | 输入框和底下那排选项 / 从这里分叉、编辑并分叉的对话框 |
| `web/src/components/login.tsx` | `Gate`：上次认出来了的设备先画应用、同时问 `/api/auth/status`，没认出来再换成登录页（配对码建 passkey / passkey 登录）；第一次打开的先问。接口回 401 时也换成它 |
| `web/src/lib/live.tsx` | 全页面共用的工作区、运行、开着的 claude 进程（`hosts`，带后台任务）、确认请求，和会话状态的算法。`change` 移出后弹「已移出工作区 · 撤销」。`session` 通知带的那一行攒 1.5 秒就地换掉（parent 留原来的）；运行结束、看过了、放进来移出去这些才整个重拉工作区。第一次和重连全靠 `hello`（用量也在这里）：hello 来了，攒着的侧栏行作废，hello 之前发出的工作区请求回来就丢掉 |
| `web/src/lib/tail.ts` | 运行输出流 → 正在写的那几段，服务端和网页共用。服务端把 `stream_event` 缩成短事件（`project`：`["m",消息id]` / `["b",第几段,种类,…]` / `["d",第几段,字]`；签名、stop、`message_delta`、空增量不推），同一段连着的增量攒 60ms 合成一个（`coalesce`），再攒一份、编序号（只数推出去的）。Codex 的流也走这一套。快照在 `hello` 里带着，新开始的运行、接不上的才拿 `/api/runs/:id/tail`（先把攒着的推出去），再按序号接推送（`run-event` 带 `seq`） |
| `web/src/lib/thread.ts` | 会话记录 → 对话的纯函数：节点树、走成一条路、工具调用收成一组、分叉点、正在写的段变成节点；增量合并（`merge`，会话、子代理的对话共用） |
| `web/src/lib/agents.ts` | 子代理：`useSubs`（会话里有 Agent 调用才拿 `/agents`，跟着 `agent` 事件、重连再拿）按 toolUseId 存；`spawns` 算每个 Agent 调用的子代理在不在跑（前台的：没结果、会话在跑、是这一轮的；后台的：结果是「Async agent launched」，会话在跑或 90 秒内写过，且最后写的时间晚于它的结束通知）。`SessionView` 算好传给对话（只给有 Agent 调用的那几组，`Steps` 的 memo 不破），「↓」上的数字也从这里来；对话里的 `AgentSheet` 开着时收到 `agent` 事件就带 version 拉增量 |
| `useStream`（`lib/use-stream.ts`） | 还没写进会话记录的那几段变成和记录里一样的节点接在对话末尾（正在写的思考是全文；写进记录后换成开头，展开时再拿全文，拿到之前留着流里的全文不缩回去）；记录里有了同一段（「消息 id : 第几段」）就换成记录里的。运行结束后留着最后几段，直到记录里都有了（最多 10 秒），不闪 |
| `web/src/lib/events.ts` | 整页一条 SSE。断了退避重连（1–30 秒），回到前台、`pageshow`、`online` 都重连，60 秒什么都没收到（包括 `ping`）也重连。连上先收 `hello`。`build` 和本页入口脚本不同：在前台弹「有新版本」，在后台就等回到前台时直接刷新 |
| `web/src/lib/highlight-worker.ts` | 代码高亮在 Worker 里：`shiki/core` + JS 正则引擎（没有 wasm），语言按需加载 |
| `web/src/lib/route.ts` | 地址就是状态（`/p/<项目>/s/<会话>?panel=…`）。记下最后的地址，主屏幕 App 冷启动时跳回去（iOS 记的是添加时那页，不一定认 manifest 的 `start_url`）；manifest 用 `crossorigin="use-credentials"` 拿，不然被 Access 转去登录页 |
| `SessionView`（`session.tsx`） | 会话在内存里留最近 12 个，切回来先画上次的、带 version 拉增量；失效靠服务端的「epoch:rev」（同一个 epoch 里节点只增不删，测试钉着）。离开时记下最上面那条和偏移，回来用 `Reveal` 的 `offset` 放回去 |
| `web/src/lib/drawer.ts` | 手机上的两个抽屉：左边的侧栏（`sidebar`）、右边的面板（`panel`，`session.tsx` 的 `PanelDrawer`）。位置是进度 0–1，拖的时候直接改样式跟手（不经过 React），松手按速度或过没过半动画到底；手势 `useSwipe` 两边共用、方向相反，另一边的抽屉开着（`role="dialog"`、`data-drawer`）时不接。面板拖开时先画上次的 tab，关到底藏起来才卸掉里面的东西 |
| `web/src/lib/outbox.ts` | 草稿随打随存；发件箱：发出去的写进记录才删，没发出去的放回输入框，其实发出去了的把输入框里原样的清掉 |

## 会话记录的坑（`server/sessions.ts`）

- 记录靠 `uuid` / `parentUuid` 连成树；`isSidechain` 是 subagent。subagent 的记录在 `<会话>/subagents/agent-<id>.jsonl`（边跑边写），旁边的 `.meta.json` 有类型、描述和 `toolUseId`（开它的 Agent 工具调用的 id，开的时候就写）。前台的子代理跑完 Agent 调用才有结果；后台的（`requestShape: background`）结果马上回来（「Async agent launched …agentId: …」），跑完靠后台任务通知（`<task-id>` 是 agentId）或子代理回报（`<agent-message from=agentId>`）；之后还能被 SendMessage 叫起来接着往同一个文件写
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
- 新版本（有 `item_completed` 的）按 item 拼：item 的 id 和 app-server 流里的一样（回复 `msg_…`、命令 `exec-…`、你的消息是 uuid），节点 key 是「item id:0」，运行中正在写的那段写进记录后能对上。`response_item` 里命令被包在 `call_…` 里，对不上，所以新版本不用它
- 记录里的 item 是 PascalCase、snake_case（`CommandExecution`、`exit_code`、`stdout`），流里是 camelCase（`commandExecution`、`exitCode`、`aggregatedOutput`）：`codex.ts` 的 `toolOf` 两种都认，名字、参数两边一样（命令叫 `exec_command`、参数 `{command}`，「/bin/zsh -lc '…'」只留里面那句）
- 分叉出来的会话文件里**只有自己的记录**：`session_meta` 的 `forked_from_id` + `forked_from_ordinal_exclusive`，前面要接上原会话那个 ordinal 之前的节点。分叉挂在原会话下面（`parent`）
- 命令行没在 PATH 上，是 Codex.app 带的：`/Applications/Codex.app/Contents/Resources/codex`（`MIXER_CODEX` 可改）。`codex exec` 不能中途确认，所以用 `codex app-server`

## 跑 Codex（`server/codex-run.ts`）

- `codex app-server` 是 stdio 上一行一个 JSON-RPC（没有 `jsonrpc` 字段）：先 `initialize`，再发 `initialized` 通知。调用都有超时：控制类 30 秒，载入线程和 `turn/start` 120 秒；`initialize` 没成就杀掉进程，下次重起。协议的类型 `codex app-server generate-ts --out <目录>` 生成
- 新会话 `thread/start`；续接 `thread/resume`（这个进程里没载入过的）再 `turn/start`；分叉 `thread/fork` 的 `lastTurnId`（带到这一轮为止，含）：节点按所在的轮换算（`codex.turnOf`）；停 `turn/interrupt`；`turn/completed` 的 `status`（completed / interrupted / failed）就是这次运行结束
- 模型一定要给：`config.toml` 里写的可能是这个账号用不了的（`gpt-5.4` 报 400），不给就用 `model/list` 的 `isDefault`。**分叉不继承模型**，也要给。思考强度是 `turn/start` 的 `effort`，管到之后的轮次：没选也给这个模型的 `defaultReasoningEffort`，免得留着上次的。`thread/turns/list` 是新的在前
- 推理摘要要 `turn/start` 带 `summary: "detailed"`，不然只有加密内容
- 权限：自动 = `on-request` + `workspace-write`（Codex 自己的 Auto：工作区里随便写，越界、要网络才问）；每次询问 = `untrusted`；计划模式 = `read-only`
- 确认：`item/commandExecution/requestApproval` → 卡片上是 Bash + 命令 + Codex 说的理由，回 `accept` / `decline`；`item/fileChange/requestApproval` → Edit + 文件；`item/permissions/requestApproval` → 回要的权限或空的。Codex 提问（`item/tool/requestUserInput`）mixer 还答不了，回空
- 出错：先来一个 `error` 通知，再是 `failed` 的 `turn/completed`，错误信息常常是一段 JSON，取里面的 `error.message`
- 用量：`account/read` 的 `account` 是 null 就是没登录；`account/rateLimits/read`（不带参数）回 `{rateLimits, rateLimitsByLimitId, rateLimitResetCredits, …}`，`rateLimits.primary` / `secondary` 是 `{usedPercent（0–100）, windowDurationMins（300、10080）, resetsAt（秒）}`，`credits` 是 `{hasCredits, unlimited, balance}`。`account/rateLimits/updated` 是零碎的，重新读一次

## 运行（`server/runs.ts`）

- 只用本机的 `claude` 命令行，走用户自己的订阅。不用 Agent SDK：它要 API key，而且不允许拿 claude.ai 的登录给别人用
- 参数：`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --thinking-display summarized --permission-mode <m> --permission-prompt-tool mcp__mixer__approve --mcp-config <临时文件> --append-system-prompt <图解的说明> [--model <别名>] [--effort <强度>] [--resume <id> [--fork-session [--resume-session-at <uuid>]]]`，环境变量 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`。stdin 一行一条：`{"type":"user","message":{"role":"user","content":文字或[文字块, 图片块…]}}`，`/名字` 照样展开成 skill
- 进程跑完一轮不退（stdin 不关）：`claude -p` 一关 stdin 就退出，Claude 开的后台命令被它杀掉（输出里只剩 `[killed]`），通知也就没了。每一轮开始、结束有 `system` 的 `session_state_changed`（`running` / `idle`）；没写消息却来了 `running` 是后台任务的通知叫醒了 Claude（这一轮的 `result.origin.kind` 是 `task-notification`），另起一次运行，`prompt` 是空的。`idle` 时这一轮才结束（`result` 先到，记下是否出错）；结束后没有后台任务、没有排队的就关 stdin。停掉后台任务之后会补一个 `idle`：刚写进去、还没来过 `running` 的那一轮不能被它结束
- 后台任务：`background_tasks_changed` 是整张表（`task_id`、`task_type`：`local_bash` / `local_agent` / …、`description`），`task_started` 带开它的 `tool_use_id`，那个工具结果里写着输出文件（「Output is being written to: ….output」）。停一个：`control_request` 的 `stop_task`（`task_id`），Claude 不会被叫醒
- 进程开着、Claude 闲着时接着说：直接写进 stdin（不另起进程）；权限、模型、思考强度和上一轮不同先发 `control_request` 的 `set_permission_mode`（`mode`）/ `set_model`（`model`，`default` 是默认）/ `apply_flag_settings`（`settings: {effortLevel}`，null 回到设置里的；帮助里没写，试过可用）。起进程时思考强度是 `--effort`
- 确认请求：MCP 的 `MIXER_RUN` 是进程的 id，`ask` 归到它正在跑的那一轮
- `--thinking-display summarized`（帮助里没写）：思考给摘要，流里有 `thinking_delta`、记录里也有文字。不加的话 `-p` 下思考大多是空的、只有签名，没东西可看
- 用量：流里的 `rate_limit_event` 的 `rate_limit_info.unifiedWindows` 有 `five_hour`、`seven_day` 的 `utilization`（0–1）和 `resetsAt`（秒），交给 `usage.ts`（记进 `state.json`，推 `usage` 事件）
- init 事件里有这个文件夹能用的全部 `skills` 和 `plugins`（内置的 skill 磁盘上没有文件），每次运行都按项目记进 `state.json`
- 分叉全交给命令行：`--fork-session` 开新会话、原会话不动；`--resume-session-at` 是一条 assistant 记录的 uuid，只带到它为止的上下文（命令行帮助里没写，试过可用）。新会话文件里原会话的记录原样复制（uuid 不变），所以「第一条记录的 uuid 相同」= 一家；文件建立之后的第一句是它自己的标题
- 确认：Claude 要用需要许可的工具时调 `mcp__mixer__approve`，它 POST 到 `/api/approvals`（带 `x-mixer-token`，每次启动随机生成），挂起直到网页上点了允许或拒绝；10 分钟没人管按拒绝处理，MCP 那边断开了也作废（卡片消失）。`approve.ts` 用 `node:http` 不用 fetch：fetch 等响应头最多 5 分钟。只读的命令（如 `echo`）Claude Code 自己会放行，不会来问
- 停止：发 `control_request` 的 `interrupt`，只停这一轮（`result` 是 `error_during_execution`），后台任务接着跑；这一轮真结束了（`idle`）才算，之前状态还是运行中，这期间发的照样排队。10 秒还没停下来就 SIGINT 整个进程（后台任务一起没了），再 5 秒 SIGKILL。Codex 10 秒没回音也按停止结束
- 会话正在 mixer 里跑时续接就进队列（`runs.ts` 的 `queue`，只在内存里，重启就没了）；运行结束时（跑完、出错、被停）把这个会话排着的话按顺序用空行连成一条续接
- 会话 90 秒内有写入（终端里可能正开着）就不让续接，免得两边同时写一个会话；最近那次写入是 mixer 自己跑完的就放行（按 `state.json` 判断，mixer 重启了也认得）
- 新会话可以开在家目录里任意文件夹（`server/dirs.ts`，没开过会话的也行）。项目 id 是 claude 的规则：路径里非字母数字的字符都换成 `-`

## 安全

能在这台 Mac 上执行命令，所以：
- 服务只听 127.0.0.1；写的接口只认本机或同源 https 的 Origin
- `/api/` 全部先过 `access.who()`（`/api/auth/` 那几个登录用的除外，远程每个 IP 一分钟 30 次；Funnel 上 IP 取 x-forwarded-for 最后一段，前面的对方能伪造）。请求体最多 20MB，页面本身谁都能拿。MCP 的确认请求只认 token
- 「本机」= Host 是 127.0.0.1 / localhost、对方是回环地址、没有任何代理加的头（x-forwarded-for、cf-*、tailscale-*）。隧道转来的都是远程；Host 不对（DNS rebinding）也是远程
- 放到外网两种：Cloudflare Tunnel + Access（mixer 再验一遍 JWT，隧道配错了漏掉 Access 也进不来）；Tailscale Funnel + passkey（公网，前面没人拦，全靠 mixer 的登录）。配 Funnel 时先写配置再开，开完自检经 Funnel 的请求不会被当成本机
- `access.json` 什么都没配：远程的一律 401，第一次远程请求时提示去 `pnpm mixer setup …`（看到的 Access JWT 记下来给 setup 当默认值）
- 仓库文件 `/raw`：只有常见图片能直接显示，别的（包括 SVG、HTML）一律下载，都带 `nosniff` 和 sandbox CSP，免得仓库里的文件在 mixer 的域名下跑脚本；页面不让别人嵌入
- passkey：配对码一次性、10 分钟；登录要 user verification；cookie 30 天、HMAC 签名，删掉 passkey 它登录的 cookie 一起作废

## 部署

- Node `^22.18.0 || >=23.6.0`（直接跑 `.ts`），`.nvmrc` 是 24
- 常驻：`pnpm mixer service install` 写 launchd `~/Library/LaunchAgents/com.mixer.server.plist` 并装上（已经有了要 `--force`；不带参数只显示要写的；`uninstall` 卸掉）（`KeepAlive`，PATH 里要有 `claude`、node、git），日志 `~/Library/Logs/mixer.log`
- 改了自己的代码会自动换上（`main.ts`）：停手 3 秒、mixer 也闲下来（没有运行、排队、待确认、开着的 claude 进程：等后台任务的进程一重启就没了）之后，服务端的代码（`server/`、`mcp/`、`web/src/lib/tail.ts`）类型检查过了就退出、launchd 拉起新的；只改了页面就重新打包。检查没过不重启，日志里有原因。要马上重启：`launchctl kickstart -k gui/$(id -u)/com.mixer.server`
- 这台机器上的外网地址、隧道这些写在 `CLAUDE.local.md`（不进 git）
