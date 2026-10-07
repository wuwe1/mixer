# mixer

远程看、远程驱动本机的 Claude Code 会话。只给自己用。

## 用的人只需要懂这些

- **项目**：一个文件夹。项目页能开新会话、看文件和改动
- **侧栏是工作区**：只放你放进来的文件夹和会话，一开始是空的。新会话、分叉、在 mixer 里跑过的会话自动放进来；已有的从「浏览会话」里挑（点一个就打开并放进来）。文件夹按你拖的顺序（按住文件夹图标拖），新放进来的在最上面；文件夹里的会话按时间排，新的在上面。移出：电脑上指着会话点 ×、文件夹的「…」；手机上在会话顶栏的图钉；长按（手机）、右键（电脑）一行也有菜单。移出不删记录，移出后提示里能「撤销」（文件夹连同里面的会话放回原处）。手机上侧栏的行高 44px 好按。手机上侧栏从左边拉出来，跟着手指走，松手时甩得快或拉过一半就打开
- **面板**：会话右边的目录、文件、改动。顶栏右边一个按钮开关，三个 tab 在面板顶上（目录带你的消息条数、改动带这个会话改过几个文件，连子代理和命令改的），打开的是这台设备上次看的那个。手机上是整屏一页，也能从右边往左拉出来（和侧栏一样跟手），往右滑关上；按在能横着滚的代码、表格上是在滚它
- **会话**：侧栏每行右边是时间和状态标记，看侧栏就知道哪些完成了、哪些在运行。标记全站一套，都是小点：待确认是琥珀点、带一圈扩散；运行中是蓝点、带一圈扩散；后台任务在跑（Claude 闲着，跑完了会叫醒它）是蓝色空心圈、带一圈扩散；已完成未读是蓝点；出错未读是红点；终端中打开（终端、IDE、桌面版里开着这个会话，闲着也算，关了马上就没了）是灰色空心圈，这时只能分叉、不能删。颜色只有这几种意思：琥珀要你确认、红出错、蓝 Claude 在跑或跑完没看、绿一步工具调用成功了、灰中性。Claude Code 会在启动时删掉 `cleanupPeriodDays`（默认 30）天没动的会话：7 天内要被清理的，时间那里换成灰色的「N 天后清理」/「今天清理」
- **删除**：侧栏长按 / 右键会话的菜单里「删除…」，先问一句。会话记录（和旁边的子代理文件夹）挪进废纸篓里「mixer 删除的会话 …」文件夹，带一份「原来的位置.txt」，挪回去就恢复，终端里 `claude --resume` 也看不到了。在 mixer 里运行中、有后台任务在跑的、有排队的、待确认的、终端中打开的不让删。分叉出来的会话是完整的一份，留着
- **开 agent 只有两种办法**：选文件夹开新会话；从一个会话分叉（每条 Claude 的回复、每组工具调用后面的分叉图标「从这里分叉」，每条你的消息后面的铅笔图标「编辑并分叉」，先填上那条的字和图；平时收着，电脑上指着、手机上点一下那条才出现，最后一条回复的常驻，手机上工具组的常驻）。从最新处分叉就是最后一条后面的那个图标，输入框里不另选。分叉出来的会话挂在原会话下面
- **继续**：Claude 正在 mixer 里运行时发送的会排队，本次运行结束（或被中断）后一起发出，排队中的可以取消；看着旧版本、终端中打开时不行，输入框自动变成分叉，并写明原因
- **后台任务**：Claude 开的后台命令、Monitor、后台子代理在跑时，这个会话的 claude 进程一直开着，跑完了通知会叫醒 Claude 接着做（和终端里一样）。输入框那一排有「后台 N」（手机上只有个数），点开列出每一个：是什么、跑了多久、停止；后台命令能展开看输出的最后一段。这时 Claude 闲着，发的消息直接接着跑，不排队。停止（输入框那一排的方块）只停 Claude 这一轮，后台任务接着跑
- **用时**：每条回复后面、复制和分叉的左边，是从这一轮开头（你的消息，或叫醒 Claude 的后台任务通知）到这条回复用了多久
- **版本**：一条消息在终端里编辑过（回退重写），那里有「第 i / n 版」切换。只是看，不产生新东西
- **子代理**：Claude 开的子代理（Agent 工具调用）在跑时，那一行带蓝色 ping 点和耗时，下面一行灰字是它现在在做什么（最后一个工具调用，或者最后一段回复的第一行）；工具组收着时在跑的子代理每个都露出来（最多 3 个，再多写「还有 N 个」）。点那一行打开它的对话，开着时跟着它往下长；跑完了那一行留着，点开看完整的。往上翻着时「↓」左上角的灰色小数字是还在跑的子代理有几个
- **不是人和 Claude 说的话**：小结、上下文已压缩（点开看压缩前的摘要）、系统提示是分隔线；后台任务的通知是一行；子代理的回报是单独的卡片
- **运行中**：你发的消息、正在写的回复、正在写参数的工具调用直接接在对话末尾，样子和写完的一样，刷新也还在；正在执行的那一步带蓝色 ping 点和耗时（工具组收着也露出来；跑完了的组收着只剩一行，就是最后那一步，成功绿点、失败红点，后面跟着「N 次」），什么都没在动时末尾留一个 ping 点；输入框那一排有停止，带着时长。虚线框只用在排队的消息上，意思是「还没发出」
- **滚动**：停在底部时新内容长出来跟着滚，往上翻了就不跟；右下角「↓」回到最新，离开后有新内容带蓝点。长对话先只画最后一段，往上翻快到顶时自动接上更早的，位置不跳；目录里点到还没画的那条，先画出来再跳过去。切走再切回来，先显示上次的内容、停在离开时的位置（当时在底部就还在底部），新的随后补上
- **主屏幕**：添加到主屏幕后，打开时回到上次看的地方
- **消息不丢**：输入框随打随存（这台设备上；继续、分叉、新会话都存：继续按会话，分叉按分叉点，新会话按文件夹）；发出去的真写进会话记录才算数，没发出去的放回输入框
- **上下文**：输入框右下角的小圆环是你正在看的那条路上用了多少上下文（只有百分比，多少 token 指着看）
- **输入框底下**：权限、模型和思考强度（一个菜单：默认、各系列最新的（出了新版自动换）、固定版本，最下面一排思考强度，只列这个模型支持的；列表是问本机的 claude 的，出了新模型菜单里就有，7 天内标「新」。选了之后这个会话一直用它；没选过就接着用上一条回复的那个系列）、「+」里是图片（选图或粘贴，点缩略图画箭头、随手画线）和 skill（也可以打「/」，选了在开头插入「/名字 」）。继续、分叉、新会话是同一个输入框。只能分叉时发送按钮是分叉的图标
- **用量**：侧栏最底下一行是 Claude 的窗口里用得最多的那个（「Claude · 5 小时 82% · 10/6 19:40 重置」）和一条灰色细条，点开「用量」看每个账号的每个窗口（电脑上是浮层，手机上从下面出来）；用 pi 花了钱的，每个 provider 一段「pi · deepseek」，今天、本月花了多少美元（按 pi 自己记的价，本月花得多的在前，不算进侧栏那一行）。Claude 的每 10 分钟问一次本机的 claude（终端里用掉的也算），mixer 里运行时随时更新；pi 的每分钟读一次。旧了写明多久前更新。Claude 有窗口用到 80% 以上，输入框里上下文旁边多一句「5 小时 82%」
- **表格**：放得下就是普通的表；手机上放不下时，长句子的表一行一张卡片（列名写在每格上面），数字多、列多的横着滚（第一列钉住）；右上角「按表格看 / 按卡片看」换着看
- **图解**：Claude 讲概念、流程、算法、取舍、数据时，会在回复里放图：流程图、时序图、树、图表、逐帧演示（上一步 / 下一步 / 播放）、对比、小测验等。指着图表看数值，「看数据」换成表格。只有在 mixer 里跑的会话里 Claude 才知道能画（终端里开的会话不知道）；写坏的那一块显示「画不出来」和哪里不对，别的照画
- **确认**：Claude 动手前请求确认，子代理来问时卡片上写是哪个子代理。当前会话的出现在对话里；别的会话的浮在右下角
- **用词**：你的「消息」、Claude 的「回复」、「继续」、「分叉」、「编辑并分叉」、「排队」、「运行中」；权限是「自动 / 每次询问 / 计划模式」。界面上的字照这套来

## 设计

token 定义在 `web/src/index.css` 最后一段。界面上只用 token，不直接写 `amber-500`、`text-[13px]` 这种具体值；review 时看到具体值就是要改的地方。

- **状态标记**：`StatusIcon`（`side.tsx`）是唯一的画法，侧栏、项目汇总、顶栏都用它。实心点 = 要你注意，带扩散的蓝点 = 运行中，带扩散的蓝色空心圈 = 后台任务在跑（Claude 闲着），灰色空心圈 = 终端中打开（在 mixer 外面开着，`terminals.ts`）；工具组收着时露出的最后一步，跑完了是绿点（成功）/ 红点（失败）
- **颜色**：`waiting` 琥珀 = 要你确认（待确认的点、确认卡片）；`unread` 蓝 = 在跑（带扩散）/ 跑完没看过；`success` 绿 = 一步工具调用成功了；`destructive` 红 = 出错；`muted-foreground` 灰 = 中性。只有这五种意思，别的地方不上色（比如「后台任务 · 完成」「已停止」是灰的，只有「失败」是红的）
- **改动色**：`added` / `removed` / `modified` / `renamed`，只用在文件改动和 diff 上（git 工具的习惯配色）
- **系列色**：`--series-1…8`，只用在图解里表示「这是哪一类」：图表里是哪一组数据，Graph 里是节点的类型（`kinds`，浅底色加同色边框，同一类的另一种状态 `alt` 更浅带斜线，图下出图例）。按顺序用、不循环（dataviz 参考调色板，深浅色各一套）。图解别的地方不上色，强调靠字重和黑白对比
- **字号**：`text-2xs` 11px（时间、徽标、小按钮）、`text-xs` 12px（代码、diff、次要文字）、`text-md` 13px（列表行、工具行）、`text-sm` 14px（消息正文）、`text-lg` 18px（标题：侧栏的 mixer、项目页的项目名）；代码块、diff 的行高用 `leading-code`。名字必须是 t-shirt 尺寸：`cn`（tailwind-merge）不认识的 `text-xxx` 会被当成颜色，和 `text-muted-foreground` 写在一起时被删掉
- **图标按钮**：Button 的 `size="icon-xs"`（24px，消息后面）/ `"icon-sm"`（28px，面板里）/ `"icon"`（32px，顶栏、发送），不在 className 里另写 `size-*`；小文字按钮用 `size="xs"`（自带 `text-2xs`）/ `"sm"`（自带 `text-xs`），className 里不再写字号、高度
- **加载中**：有形状的内容（列表、正文、diff、正在画的图解）在等，用 `Skeleton` 先画出轮廓（会话、文件、改动、侧栏）；没有形状的一块地方在等（对话框、整页），一律 `Loading`（居中的 `Spinner`，className 定高）；按钮里、行内的直接用 `Spinner`（和状态标记同样的点带扩散，颜色跟文字）；Claude 运行中用 `StatusIcon` 的 `running`（蓝）。不用转圈；**展开收起**：一律左边一个 `Chevron`（`›`，展开时转 90°）；**空状态**：一律 `Placeholder`（`Empty`，图标可以不给）；渲染出错是 `Boundary`。这几个都在 `placeholder.tsx`
- **代码块**：代码、命令、输出一律 `CodeBlock`（`message.tsx`），调用处只给 `max-h-*` 和出错的红；**浮层**：电脑上 Popover、手机上底部 Sheet 一律 `Popsheet`（`popsheet.tsx`）
- **提示**：一律 `toast`（`lib/toast.tsx`，不用 sonner）：顶栏下面浮出一条（不挡顶栏，页面不跳），几秒后收回，同时只有一条；出错的字是红的、多留一会儿，带按钮的（撤销、刷新）也多留一会儿
- **时间**：列表里用 `since()`（刚刚 / 5 分钟 / 3 小时 / 2 天 / 10/3），消息上用 `clock()`（10/5 11:58）

## 跑

- `pnpm start`：服务在 127.0.0.1:4848（`MIXER_PORT` 可改）。`web/src` 比 `web/dist` 新时，启动会先重新打包
- `pnpm dev`：Vite 开发服务（5173），`/api` 转到 4848
- `pnpm check`：类型检查（web、server、test 各一遍）
- `pnpm test`：node:test，测试在 `test/*.test.ts`、fixtures 是小的 jsonl（`test/fixtures/`）。HOME、`MIXER_DATA` 指到临时目录，不读本机的 `~/.claude`、`data/`。CI（`.github/workflows/ci.yml`，macOS）跑 check、test、build
- `pnpm mixer`：手机怎么访问。`setup cloudflare`（Tunnel + Access，要有托管在 Cloudflare 的域名）/ `setup funnel`（Tailscale Funnel + passkey，不要域名）/ `pair`（出二维码，手机扫了建 passkey）/ `passkeys [rm <id>]`。改的是 `data/access.json`，服务不用重启

## 结构

| 位置 | 做什么 |
|---|---|
| `server/sessions.ts` | 读 `~/.claude/projects/<目录>/<会话>.jsonl`，拼成显示用的节点树。记下读到第几个字节，文件长了只读新写的；节点新建、改过记 `rev`，网页带 `?since=<version>` 只拿之后变了的。工具调用的参数、结果在节点里只是预览，点开时拿 `/tool/<id>`；思考也只给前 120 字（`cut`），展开时拿 `/thinking/<uuid>`。读过的会话按最近使用留在内存，总量超 200MB（按文件大小算）丢最久没用的，一分钟内用过的不丢（比 200MB 还大的会话不会被旁边的子代理挤掉、反复整份重读）。会话信息带 `expires`：修改时间 + `~/.claude/settings.json` 的 `cleanupPeriodDays`（默认 30，文件改了重读）。parent 是直接的原会话：mixer 分叉的看 `state.forkOf`，终端 `/branch` 的看记录里的 `forkedFrom`，都没有（终端 `--fork-session`、老的）才 `guess`（同一个第一句 uuid 的一家里建得最早的，写明是猜）；fresh（分叉后自己问的第一句）= 第一句 uuid 不在原会话里的。标题 `custom-title` 优先，其次 `ai-title`。会话接口带 `leaf`（命令行续接时接着的那条）、`touched`（这个会话连子代理改过的文件）；工具节点的 agent / async / task / file / files 从结构化的 `toolUseResult` 来（`facts()`），不对文字做正则 |
| 子代理（`sessions.ts` 的 `subs` / `sub` / `agent`） | `/api/sessions/:项目/:会话/agents` 列出 `<会话>/subagents/` 里的子代理：`agent-<id>.meta.json` 的 `toolUseId`（开它的 Agent 工具调用）、类型、描述，`latest`（它在做什么：最后一个工具调用「工具名 摘要」或最后一段回复的第一行，80 字；10 分钟没动的不读记录、给 null），`mtime`。`main.ts` 监视到子代理的记录、meta 变了（每个 0.5 秒一次）推 `agent`（同样的一份带上 project、session）。`/agents/<id>?since=` 和会话一样给增量 |
| `server/jsonl.ts` | 读记录的办法：按 `\n` 一行一行读；接着上次读（`Cursor` / `resume`：变短、换了 ino 从头读，pi 的用量也用）；截开头（`cut`）；`epoch()` 越晚给的越大，网页用 `reached()` 比两个版本谁新；读过的留多少（`lru`：200MB，一分钟内用过的不丢） |
| `server/repo.ts` | 仓库文件、git 状态、diff、提交；`inside()` 防止路径跑出仓库。git 都是异步的（不挡别的请求）；状态同一个仓库同时来的共用一次，缓存 1.5 秒 |
| `server/dirs.ts` | 新会话选文件夹：列子文件夹、新建，只认家目录里面的 |
| `server/access.ts` | 谁能用：本机直接放行；Cloudflare Access 验 JWT（签名、iss、aud、邮箱）；passkey 登录的签名 cookie。配置 `data/access.json`（不进 git；`data/` 的位置 `MIXER_DATA` 可改，测试用），按修改时间重读 |
| `server/tunnel.ts` | `access.json` 里有 `cloudflare.tunnel` 就起一个 cloudflared（自己写一份配置，不读 `~/.cloudflared/config.yml`），挂了退避再起（听 `close`：没装 cloudflared 时只有 error、close）。SIGTERM / SIGINT 在 `main.ts` 里先停隧道再退出 |
| `server/terminals.ts` | 哪些会话在 mixer 外面开着（「终端中打开」，确切的，不猜）：`~/.claude/sessions/<pid>.json` 登记表，进程活着、启动时间对得上（`LC_ALL=C TZ=UTC ps -o lstart=`）、不带 `parkedJobId`、不是 mixer 自己起的（`mine`）；`status` 给出在跑 / 闲着。查的时机：登记的文件夹有变化 0.3 秒合一次、每 2 秒 `kill(pid, 0)` 看开着的进程还在不在、每 30 秒整个查一次兜底；续接、删除前 `held` 当场查 |
| `server/cli.ts` | `pnpm mixer …` |
| `server/log.ts` | `say`：带时间的日志，服务端各处共用。端口是 `access.ts` 的 `PORT` |
| `server/state.ts` | `data/state.json`（不进 git）：每个会话在 mixer 里最后跑完的时间、人最后看它的时间 →「跑完了没看」；工作区（文件夹的顺序、放进来的会话）；每个账号最后的用量；mixer 开的分叉从哪来（`forks`） |
| `server/usage.ts` | 用量：每个账号一样的样子（`shared/usage.ts` 的 `Account`：`quota` 是窗口，`spend` 是花的钱、`budget` 还没地方设），`hello` 里带整张表，变了推 `usage`。Claude 的来自 `models.ts` 每 10 分钟那次探测里的 `get_usage`（`rate_limits.five_hour/seven_day`，utilization 0–100、`resets_at` 是 ISO 时间，命令行标着 Experimental；旧版、没登录、出错不吵）和运行时的 `rate_limit_event`（0–1、秒），只要 5 小时、本周两个窗口；pi 的是 `~/.pi/agent/sessions/<目录>/*.jsonl` 里每条回复（`message` 的 role assistant）的 `provider` 和 `usage.cost.total`（美元），按 provider、本地日期（回复自己的 `message.timestamp`，毫秒）按天记在内存，算出今天、本月，本月花了钱的一个 provider 一个账号 `pi:<provider>`；每个文件记读到第几个字节、只读新写的（半行等写完，变短、换了 ino 从头读，没了不算），起来 5 秒后、之后每分钟扫一遍（换天换月也靠它），数变了才推，不进 `state.json`。压缩、分支小结的花费没有 provider，不算。`shared/usage.ts` 挑最紧的窗口（过了重置时间的不算，`spend` 不参与）给侧栏、输入框，`money` 写钱（`$0.42`，不到一分「<$0.01」） |
| `server/workspace.ts` | `/api/workspace`：工作区的文件夹带上放进来的会话（`add` 可带 `sessions`：撤销移出文件夹时一起放回）。第一次（还没有工作区）把运行中、跑完没看的放进去。`/api/tree`（扫所有会话）只有「浏览会话」用 |
| `server/trash.ts` | 删会话（`POST /api/sessions/:项目/:会话/delete`）：jsonl 和 `<会话>/` 用 rename 挪进 `~/.Trash/mixer 删除的会话 <标题前 20 字> (<id 前 8 位>)`，写 `原来的位置.txt`。标题先读好，查完到挪走之间不再 await。`runs.busy()`（运行中、从它分叉中、排队、待确认）和 `terminals.held`（当场查，在 mixer 外面开着）回 409。删完 `state.forget`（移出工作区、忘掉跑完 / 看过 / 模型）、丢 `sessions.ts` 的缓存，推 `workspace` |
| `server/runs.ts` | 起 `claude -p`（新会话 / 续接 / 分叉 / 从中间分叉），一个会话一个进程（`Proc`），一轮是一次运行（`Run`）；管确认请求（走 stdio 的 `can_use_tool`）、后台任务（`stopTask`、`taskOutput`），开着的进程推 `host`、在 hello 的 `hosts` 里 |
| `server/models.ts` | 能选的模型（`/api/models`：`shared/model-info.ts` 的 `ModelInfo`，第一项是默认）。`control()` 起一个 `claude -p --safe-mode`（不跑 hooks、不写会话、不花 token），一个进程里问 `initialize` 和 `get_usage`（用量交给 `usage.ts`），pid 记进 `terminals.mine`（它也在 `~/.claude/sessions` 登记）；`initialize` 回的 `models` 有默认、别名（最新的：`value ≠ resolvedModel`）、固定版本、`supportedEffortLevels`；存进 `state.json`，起来 5 秒后、每 10 分钟、运行的 init 里 `claude_code_version` 变了、网页要时超过 10 分钟就重读。第一次见到的型号记时间（头一回那批不算），7 天内 `isNew` |
| `server/skills.ts` | 输入框里能选的 skill：名字按 init 事件记下的，加上扫 skill 文件夹补的新建的，描述从 `SKILL.md` 读。`/api/skills/:项目?cwd=` 给还没开过会话的文件夹用 |
| 图解（`shared/visual.ts`） | 回复里 ```ui 代码块的格式：每种组件的 zod 定义和「什么时候用」，`prompt()` 给 Claude 的说明（`runs.ts` 起进程时 `--append-system-prompt` 带上，从定义生成，约 2k token），`parse` 读 JSON（正在写的半截也读：没写完的字符串照已有的算、括号补上，`done` 说明写完没有），`checkNode` / `check` 逐个组件校验（中文的错误，带路径）。不碰 React，服务端也用。加一种组件改两处：这里的 `DEFS`、`components/visual/index.tsx` 的 `VIEWS` |
| `web/src/components/visual/` | 画图解：`markdown.tsx` 遇到 ```ui 交给它（`lazy.tsx` 的 `Visual`，第一次遇到才加载，带着 dagre、katex）。一个组件一个组件地画：没写完的是「正在画」，写完了还不对的是「画不出来」加原因和原文。`graph.tsx` 的 Graph 用 dagre 排（组能套组：实线框浅底是真实存在的东西、虚线框是逻辑上的一组；`kinds` 按类型上系列色；`stack` 叠成几层；`note` 便签）；给 Claude 的说明里有画 Graph 的五步（先列内容，再包含、关联、按类型上色、强调）；Tree 自己排（dagre 会调换兄弟的先后）；Sequence 自己排；字宽用 canvas 量。`chart.tsx` 按容器宽度画（手机上字不缩小），一个纵轴、悬停出数、能切成表格。`layout.tsx` 的 `usePlayer` / `Controls` 是 Stepper 的播放条。组件宁少而强：数组上的算法不另设组件，用 Stepper 每帧一个没有箭头的 Graph（没有箭头、没有组时节点按顺序排成等宽一行，`dim` 淡掉、指针写在 `note`）；删掉的组件在 `visual.ts` 的 `legacy` 里换成现在的写法，旧回复照样画 |
| `server/main.ts` | HTTP 接口（`ROUTES` 一张表，每条写明谁能用：`user` / `open`）、SSE（`/api/events`）、监视 transcript 目录；打包出来的 js / css 第一次被要时压成 br、gzip 存着。接口的 JSON 大于 8KB 就压（br 质量 5，不收 br 的 gzip），在线程池里压、不挡别的请求和推送。会话文件变了推 `session`（0.5 秒合一次），在工作区里的带上侧栏那一行（`sessions.row`，parent 也算好，`terminal` 是在 mixer 外面开着：`"busy"` / `"idle"` / null）；`terminals.ts` 发现开了、关了、在跑闲着换了也推。SSE 连上先发 `build`（入口脚本的路径当版本号；只在 `refreshVersion` 里改：打包后、`dist/index.html` 变了、SSE 连上时，换了就推给开着的页面），再发 `hello`（`sse.ts`）；每 25 秒一个 `ping`。`keepAliveTimeout` 120 秒：cloudflared 会把空闲连接留约 90 秒，Node 默认的 5 秒会偶发 502。打包不清空 `dist`（开着的旧页面还要按需拿旧的块），打包后删一天前、没被引用的旧文件 |
| `server/sse.ts` | SSE 的连接们。连上先发 `hello`（运行、确认请求、排队、用量、工作区、在跑的那几次正在写的那几段），和之后的事件在同一条流里、先后不会乱；算 hello 期间的事件攒着接在后面。页面拿它整个换掉，不再另外拉 |
| `shared/` | 服务端和网页都用的：`tail.ts`、`visual.ts`（运行时）、`api.ts`、`usage.ts`、`model-info.ts`（类型和纯函数）。网页里是 `@shared/…`，服务端 `../shared/….ts`。整个目录算服务端的代码（改了要类型检查、重启） |
| `web/` | Vite + React + Tailwind v4 + shadcn（radix-nova），组件在 `web/src/components/ui` |
| `side.tsx` / `browse.tsx` | 侧栏（工作区，文件夹用 dnd-kit 拖；行上的 ContextMenu 长按 / 右键出菜单，菜单只挂在文件夹那一行，免得长按会话两个菜单一起开；菜单开着时 `useSwipe` 不接手势、行的点按不算；删除的 AlertDialog；别的对话框开着时 `useSwipe` 也不接）/ 浏览会话的对话框。分叉按 `families` 挂：顺着 parent 往上挂到这批里最上面的祖先（两边的 parent 都是直接的原会话，只有猜的那种挂到一家最早的） |
| `tasks.tsx` | 输入框那一排的「后台 N」和点开的后台任务列表（`Popsheet`）：类型图标、说明、跑了多久、停止，› 展开输出（开着时每 2 秒拿 `/api/hosts/:进程/tasks/:任务/output`，服务端问 claude 的 `get_task_output`） |
| `usage.tsx` | 侧栏最底下那行用量和点开的「用量」（`Popsheet`）；`pct` / `resets` 输入框的提醒也用 |
| `web/src/components/lazy.tsx` | 首屏用不着的按需加载：浏览会话、新会话、skill 选择第一次打开才拿，项目页、文件、改动面板加载时是 Spinner |
| `table.tsx` | 表格（Markdown 的、图解的 Table、图表的「看数据」共用 `TableFrame`）：按每列要多宽估（最长那格的字数，一列最多算 14 个字宽）放不放得下；放不下时列不多或多是长句子排成卡片（第一列当标题，其余每格上面小字写列名，列名在 `data-label`：Markdown 的由 `markdown.tsx` 的 `rehypeTableLabels` 补），不然横着滚、第一列钉住、右边没到头时渐隐；右上角能换着看。外框 `contain: inline-size`，宽表不把整条回复撑宽。样子在 `index.css` 的 `.table-frame` |
| `prompt.tsx` / `model-menu.tsx` / `composer.tsx` / `fork-dialog.tsx` | 三处共用的输入框：`usePrompt(target)`（继续 / 分叉 / 新会话）管草稿、图、权限 / 模型 / 思考强度（一套默认）、skill、发送（`start`），`PromptBox` 画出来 / 权限、模型和思考强度的菜单 / 会话底下的那个，加上后台任务、运行中、用量、上下文（发送成功后 `onSent`，会话页用它滚到底：只有自己发了才滚）/ 从这里分叉、编辑并分叉的对话框 |
| `web/src/components/login.tsx` | `Gate`：上次认出来了的设备先画应用、同时问 `/api/auth/status`，没认出来再换成登录页（配对码建 passkey / passkey 登录）；第一次打开的先问。接口回 401 时也换成它 |
| `web/src/lib/live.tsx` | 全页面共用的工作区、运行、开着的 claude 进程（`hosts`，带后台任务）、确认请求，和会话状态的算法。`change` 移出后弹「已移出工作区 · 撤销」。`session` 通知带的那一行攒 1.5 秒就地整行换掉；运行结束、看过了、放进来移出去这些才整个重拉工作区。「终端中打开」就是服务端给的 `terminal` 不是 null（开了关了都会推过来）。第一次和重连全靠 `hello`（用量也在这里）：hello 来了，攒着的侧栏行作废，hello 之前发出的工作区请求回来就丢掉 |
| `shared/tail.ts` | 运行输出流 → 正在写的那几段，服务端和网页共用。服务端把 `stream_event` 缩成短事件（`project`：`["m",消息id]` / `["b",第几段,种类,…]` / `["d",第几段,字]`；签名、stop、`message_delta`、空增量不推），同一段连着的增量攒 60ms 合成一个（`coalesce`），再攒一份、编序号（只数推出去的）。快照在 `hello` 里带着，新开始的运行、接不上的才拿 `/api/runs/:id/tail`（先把攒着的推出去），再按序号接推送（`run-event` 带 `seq`） |
| `web/src/lib/thread.ts` | 会话记录 → 对话的纯函数：节点树、走成一条路、工具调用收成一组、分叉点、正在写的段变成节点；增量合并（`merge`，会话、子代理的对话共用） |
| `web/src/lib/agents.ts` | 子代理：`useSubs`（会话里有 Agent 调用才拿 `/agents`，跟着 `agent` 事件、`hello` 时再拿）按 toolUseId 存；`useSpawns` 算（纯函数在 `spawns.ts`，测试钉着）每个 Agent 调用的子代理在不在跑：前台的：没结果、会话在跑、是这一轮的；后台的（节点上的 `async`，服务端照 toolUseResult 标的；以 forked 在后台跑的 Skill 也算）：会话在 mixer 里开着 claude 进程（`hosts` 里有它），就看进程报的后台任务里有没有它（任务的 `tool` 是这个调用，或者任务 id 是它的 agentId：`task_started` 先于整张表来时 `tool` 是空的）；没有进程（终端里开的、进程退了）才猜：会话在跑或 90 秒内写过，且最后写的时间晚于它的结束通知（到点重算）。`SessionView` 算好传给对话（只给有 Agent 调用的那几组，`Steps` 的 memo 不破），「↓」上的数字也从这里来；对话里的 `AgentSheet` 开着时收到 `agent` 事件就带 version 拉增量 |
| `useStream`（`lib/use-stream.ts`） | 还没写进会话记录的那几段变成和记录里一样的节点接在对话末尾（正在写的思考是全文；写进记录后换成开头，展开时再拿全文，拿到之前留着流里的全文不缩回去）；记录里有了同一段（「消息 id : 第几段」）就换成记录里的。运行结束后留着最后几段，直到会话数据的 version 到了这次运行结束时的 `version`（`reached()`），不闪、不靠计时 |
| `web/src/lib/events.ts` | 整页一条 SSE。断了退避重连（1–30 秒），回到前台、`pageshow`、`online` 都重连，60 秒什么都没收到（包括 `ping`）也重连。连上先收 `hello`（没有另外的「重连了」事件：看着的会话、子代理也在 hello 时拉增量）。`build` 和本页入口脚本不同：在前台弹「有新版本」，在后台就等回到前台时直接刷新。服务端每次连上都从磁盘重读 `dist/index.html` 的版本，也监视它（终端里 `pnpm build` 过也认得），不然记着的旧版本会让页面一直提示刷新 |
| `web/src/lib/highlight-worker.ts` | 代码高亮在 Worker 里：`shiki/core` + JS 正则引擎（没有 wasm），语言按需加载 |
| `web/src/lib/route.ts` | 地址就是状态（`/p/<项目>/s/<会话>?panel=…`）。记下最后的地址，主屏幕 App 冷启动时跳回去（iOS 记的是添加时那页，不一定认 manifest 的 `start_url`）；manifest 用 `crossorigin="use-credentials"` 拿，不然被 Access 转去登录页 |
| `SessionView`（`session.tsx`） | 会话在内存里留最近 12 个，切回来先画上次的、带 version 拉增量（`use-incremental.ts`：一次只拉一个、带 `?since=`、merge，子代理的对话也用）；失效靠服务端的「epoch:rev」（同一个 epoch 里节点只增不删，测试钉着）。离开时记下最上面那条和偏移，回来用 `Reveal` 的 `offset` 放回去 |
| `web/src/lib/drawer.ts` | 手机上的两个抽屉：左边的侧栏（`sidebar`）、右边的面板（`panel`），都是 `components/drawer.tsx` 的 `Drawer`（手机上一直挂着，里面调 `useSwipe`，关着时也接手势）。从屏幕边上滑不退回上一页：`guardEdges`（主屏幕 app 里两条边 24px 以内一按下就拦，补 click）。位置是进度 0–1，拖的时候直接改样式跟手（不经过 React），松手按速度或过没过半动画到底；手势 `useSwipe` 两边共用、方向相反，另一边的抽屉开着（`role="dialog"`、`data-drawer`）时不接；在选字时不接（按在选区两头 44px 以内是在拖把手，按着时选区变了是长按选字）。面板拖开时先画上次的 tab，关到底藏起来才卸掉里面的东西 |
| `web/src/lib/steps.ts` | 工具组收着时露出什么（`exposed`：在跑的那一步、在跑的子代理最多 3 个、不然最后一步；跑完了最后一步当标题）。纯函数，`message.tsx` 的 Steps 照着画，测试钉着 |
| `web/src/lib/match.ts` | cmdk 的筛选：按子串（开头对上的排前面），不用默认的模糊匹配。新会话、浏览会话、skill 共用 |
| `web/src/lib/outbox.ts` / `arrival.ts` | 草稿随打随存（按 key：会话 / 会话@分叉点 / new.项目，只存文字）。发件箱只管继续：每条带网页给的 uuid（服务端拿它当记录里那条的 uuid），到没到按 uuid 认（`arrival.ts` 的 `fate`，纯函数、测试钉着）：记录里有它（或带着它的那次合并）就是到了；运行结束、数据到了运行的 `version` 还没有它，或者排队的没了，就放回输入框；请求明确被拒（4xx）马上删，请求没回来的等运行和队列说了算 |

## 会话记录的坑（`server/sessions.ts`）

- 记录靠 `uuid` / `parentUuid` 连成树；`isSidechain` 是 subagent。subagent 的记录在 `<会话>/subagents/agent-<id>.jsonl`（边跑边写），旁边的 `.meta.json` 有类型、描述和 `toolUseId`（开它的 Agent 工具调用的 id，开的时候就写）。前台的子代理跑完 Agent 调用才有结果；后台的（`requestShape: background`）结果马上回来（「Async agent launched …agentId: …」），跑完靠后台任务通知（`<task-id>` 是 agentId）或子代理回报（`<agent-message from=agentId>`）；之后还能被 SendMessage 叫起来接着往同一个文件写
- 只按 `\n` 切行：行里有 U+2028，Node 的 readline 会在那里切断
- 同一个 uuid 会被重复追加，按第一次出现的算
- `parentUuid` 偶尔指向后面才写的记录（先写回复、后写它挂着的附带记录）：边读边拼时先当根，那条读到了再接上
- 并行的工具调用在树上看着像分叉，其实不是分支；分支只看用户消息
- `<task-notification>`、`<command-name>`、`<system-reminder>` 这类用户记录是系统插的，显示成事件，不当成人说的话
- 运行中插进来的东西是 `attachment` 的 `queued_command`：可能是人在终端里打的，也可能是任务通知（`commandMode: task-notification`）或子代理的回报（`<agent-message from=…>`），要分开
- 压缩：`system` 的 `compact_boundary` 的 `parentUuid` 是空的，`logicalParentUuid` 指向压缩之后的记录、靠不住；按文件顺序接在它前面最后一个显示节点上。紧跟着的 `isCompactSummary` 用户记录是摘要，不是人说的话
- 一条 assistant 记录是一条消息里的一段：同一个 `message.id` 的记录按文件顺序数，第几段（流里 `content_block` 的 `index`）有 `apiBlockIndex` 就照它（2.1.2xx 起都有，按顺序数会因为没写出来的段错位），老记录才按文件顺序数，空的思考也算。`sessions.ts` 给节点标上 `key`「消息 id : 第几段」
- 上下文用量：每条 assistant 记录的 `message.usage` 里 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。窗口大小记录里没有，只有 `claude -p` 结束时 `result` 事件的 `modelUsage.<模型>.contextWindow` 有，按模型记进 `state.json`
- 调 skill：先是一条 `<command-name>/名字</command-name><command-args>…` 的 user 记录，下一条 isMeta 的是 skill 正文（`Base directory for this skill:` 开头）。有正文的才是 skill，显示成人说的「/名字 参数」；`/clear`、`/model` 这类后面没有正文，不显示
- 从工具调用分叉，`--resume-session-at` 要给工具结果那条 user 记录的 uuid；给工具调用那条，结果会丢
- 调 skill 时 stdin 的 uuid 落在 `<command-name>` 那条记录上（试过），skill 节点用它
- 运行中插进来的 `queued_command` 的 `attachment.source_uuid` 是发的时候的 uuid（节点的 `source`）
- 停止后命令行补一条 user「[Request interrupted by user]」（停在工具调用上是「… for tool use]」），显示成事件「被打断了」，不算人说的话
- `custom-title`（终端 /rename、/branch 起的名）优先于 `ai-title`
- `last-prompt` 的 `leafUuid`：命令行续接时从它接；`explicit: true`（回退后还没写别的）就停在它，否则从最后写的、是它后代的那条往下走；压缩后作废
- 终端 `/branch` 复制过来的记录带 `forkedFrom: {sessionId, messageUuid}`，uuid 不变；`--fork-session` 没有这个标记
- `toolUseResult` 是结构化的：后台子代理 `{status: "async_launched", agentId, outputFile}`，后台 Bash `backgroundTaskId`，Monitor `taskId`，Write / Edit `filePath` + `structuredPatch`，Bash 改了文件 `bashEditDiff.changedFiles`（`shared` 的不算）。子代理 meta 有 `worktreePath` 的，它在那个 worktree 里改的不算这个会话的
- 进程登记 `~/.claude/sessions/<pid>.json`：`sessionId` 跟着终端里的 `/resume`、`/clear`、分叉变；`procStart` 是 UTC，`ps` 要带 `LC_ALL=C TZ=UTC` 才对得上；进程被杀了文件会留下，所以要看进程还活着、启动时间对得上

## 运行（`server/runs.ts`）

- 只用本机的 `claude` 命令行，走用户自己的订阅。不用 Agent SDK：它要 API key，而且不允许拿 claude.ai 的登录给别人用
- 参数：`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --thinking-display summarized --permission-mode <m> --permission-prompt-tool stdio --append-system-prompt <图解的说明> [--model <别名>] [--effort <强度>] [--resume <id> [--fork-session [--resume-session-at <uuid>]]] [--session-id <mixer 定的 id>]`，环境变量 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`。stdin 一行一条：`{"type":"user","uuid":<网页给的（POST 的 `uuid`，只认 UUID，发过的 409）>,"message":{"role":"user","content":文字或[文字块, 图片块…]}}`，`/名字` 照样展开成 skill。uuid 就是记录里那条的 uuid，命令行按它报 `command_lifecycle`
- 进程跑完一轮不退（stdin 不关）：`claude -p` 一关 stdin 就退出，Claude 开的后台命令被它杀掉（输出里只剩 `[killed]`），通知也就没了。一条消息一次运行：`{"type":"command_lifecycle","command_uuid","state"}` 的 `started` 开始，`completed`（按它那一轮 result 的 `is_error`）/ `cancelled`（停止）/ `discarded`、`refused`（出错）结束；result、assistant 带 `user_message_uuids`。后台任务的通知叫醒 Claude 的那一轮没有 uuid（result 的 `origin.kind` 是 `task-notification`），从它的主线输出开始、到它的 result 结束，前面不一定有 `running`。`idle`（`session_state_changed`）要等后台子代理全跑完才来（可能半小时），所以不拿它结束运行，只用来关 stdin：没有没结束的消息、叫醒的一轮、后台任务、排队的才关
- 后台任务：`background_tasks_changed` 是整张表（`task_id`、`task_type`：`local_bash` / `local_agent` / …、`description`），`task_started` 带 `tool_use_id`（单独记，和整张表谁先来都行）；看输出发 `control_request` 的 `get_task_output`（`task_id`），回 `{output, total_bytes, truncated}`，最后 8KB，只认 `local_bash`（后台命令、Monitor），任务结束后也能读。`ambient: true` 的任务不算在干活：不列、不留着进程、不挡删和重启。停一个：`control_request` 的 `stop_task`（`task_id`），Claude 不会被叫醒。只有后台任务在跑时会话不算运行中：网页上是「后台任务在跑」，没有停止按钮，发的消息直接写进去、不排队
- 进程开着、Claude 闲着时接着说：直接写进 stdin（不另起进程）；权限、模型、思考强度和上一轮不同先发 `control_request` 的 `set_permission_mode`（`mode`）/ `set_model`（`model`，`default` 是默认）/ `apply_flag_settings`（`settings: {effortLevel}`，null 回到设置里的；帮助里没写，试过可用）。起进程时思考强度是 `--effort`
- 确认请求归会话，不归哪一轮：命令行在 stdout 发 `control_request` 的 `can_use_tool`（`tool_name`、`input`、`tool_use_id`，子代理里的带 `agent_id`；之前先来一个 `session_state_changed: requires_action`），归到发它的那个进程的会话，Claude 闲着时后台子代理来问也一样；卡片带 `toolUse`、`agent`（说明取自 `task_started`）。别的 control_request（如 elicitation）回 error，免得命令行一直等
- `--thinking-display summarized`（帮助里没写）：思考给摘要，流里有 `thinking_delta`、记录里也有文字。不加的话 `-p` 下思考大多是空的、只有签名，没东西可看
- 用量：流里的 `rate_limit_event` 的 `rate_limit_info.unifiedWindows` 有 `five_hour`、`seven_day` 的 `utilization`（0–1）和 `resetsAt`（秒），交给 `usage.ts`（记进 `state.json`，推 `usage` 事件）
- init 事件里有这个文件夹能用的全部 `skills` 和 `plugins`（内置的 skill 磁盘上没有文件），每次运行都按项目记进 `state.json`
- 新会话、分叉的 id 由 mixer 起进程前定（`--session-id`；和 `--resume` 一起用要带 `--fork-session`），运行、进程、确认请求、工作区一开始就有；从哪分叉的当场记进 `state.json`（`state.fork` / `forkOf`）。分叉全交给命令行：`--fork-session` 开新会话、原会话不动；`--resume-session-at` 是一条 assistant 记录的 uuid，只带到它为止的上下文（命令行帮助里没写，试过可用）。新会话文件里原会话的记录原样复制（uuid 不变），所以「第一条记录的 uuid 相同」= 一家；第一句 uuid 不在原会话里的是它自己问的（当标题）
- 确认：人点了在 stdin 回 `control_response`：`{behavior: "allow", updatedInput: 原参数}`（updatedInput 会替换参数，试过）/ `{behavior: "deny", message}`（工具结果是 is_error，内容就是 message）；10 分钟没人管回 deny；`control_cancel_request`（这一轮被停了、工具调用取消了，试过）、claude 进程退出了就作废，不回；这一轮结束不作废（后台子代理可能还在等）。有没答的确认时不关 stdin。只读的命令（如 `echo`）Claude Code 自己会放行，不会来问
- 停止：发 `control_request` 的 `interrupt`，只停这一轮（`result` 是 `error_during_execution`，然后这条 `cancelled`），后台任务接着跑；这条消息 `cancelled` 了（叫醒的那一轮是它的 result）才算，之前状态还是运行中，这期间发的照样排队。10 秒还没停下来就 SIGINT 整个进程（后台任务一起没了），再 5 秒 SIGKILL
- 会话正在 mixer 里跑时续接就进队列（`runs.ts` 的 `queue`，只在内存里，重启就没了）；运行结束时（跑完、出错、被停）把这个会话排着的话按顺序用空行连成一条续接（只有一条就用它自己的 uuid，几条合成的另给 uuid、`merged` 记着带了哪几条；新的运行推出去之后才推 queue）。排着的在 `start` 查完终端（await）之后才拿出队列：拿早了，这期间来的 idle 看队列是空的就关 stdin，又得另起一个 claude。运行结束后服务端读一遍记录，把那时的 `version` 放进运行再推一次（claude 在 result 之前已经写完记录，试过；没有记录是 null）
- 会话在 mixer 外面开着（`terminals.ts`，在跑、闲着都算）就不让续接（409，输入框变成分叉），免得两边同时写一个会话；续接、删除前当场查，不用缓存
- 新会话可以开在家目录里任意文件夹（`server/dirs.ts`，没开过会话的也行）。项目 id 是 claude 的规则：路径里非字母数字的字符都换成 `-`

## 安全

能在这台 Mac 上执行命令，所以：
- 服务只听 127.0.0.1；写的接口只认本机或同源 https 的 Origin
- 每个接口在 `main.ts` 的 `ROUTES` 里写明谁能用：`user` 先过 `access.who()`；`open` 只有登录那几个（远程 POST 每个 IP 一分钟 30 次；Funnel 上 IP 取 x-forwarded-for 最后一段，前面的对方能伪造）。请求体最多 20MB、坏 JSON 回 400，页面本身谁都能拿
- 「本机」= Host 是 127.0.0.1 / localhost、对方是回环地址、没有任何代理加的头（x-forwarded-for、cf-*、tailscale-*）。隧道转来的都是远程；Host 不对（DNS rebinding）也是远程
- 放到外网两种：Cloudflare Tunnel + Access（mixer 再验一遍 JWT，隧道配错了漏掉 Access 也进不来）；Tailscale Funnel + passkey（公网，前面没人拦，全靠 mixer 的登录）。配 Funnel 时先写配置再开，开完自检经 Funnel 的请求不会被当成本机
- `access.json` 什么都没配：远程的一律 401，第一次远程请求时提示去 `pnpm mixer setup …`（团队域名、AUD 从 Access 后台复制，不拿请求里没验过的 JWT 当默认值）
- 仓库文件 `/raw`、会话里的图片（`sendImage`，类型是记录里写的、不可信）：只有常见图片能直接显示，别的（包括 SVG、HTML）一律下载，都带 `nosniff` 和 sandbox CSP，免得仓库里的文件在 mixer 的域名下跑脚本；页面不让别人嵌入
- passkey：配对码一次性、10 分钟；登录要 user verification；cookie 30 天、HMAC 签名，删掉 passkey 它登录的 cookie 一起作废

## 部署

- Node `^22.18.0 || >=23.6.0`（直接跑 `.ts`），`.nvmrc` 是 24
- 常驻：`pnpm mixer service install` 写 launchd `~/Library/LaunchAgents/com.mixer.server.plist` 并装上（已经有了要 `--force`；不带参数只显示要写的；`uninstall` 卸掉）（`KeepAlive`，PATH 里要有 `claude`、node、git），日志 `~/Library/Logs/mixer.log`
- 改了自己的代码会自动换上（`main.ts`）：停手 3 秒、mixer 也闲下来（没有运行、排队、待确认、开着的 claude 进程：等后台任务的进程一重启就没了）之后，服务端的代码（`server/`、`shared/`）类型检查过了就退出、launchd 拉起新的；只改了页面就重新打包。检查没过不重启，日志里有原因。要马上重启：`launchctl kickstart -k gui/$(id -u)/com.mixer.server`
- 这台机器上的外网地址、隧道这些写在 `CLAUDE.local.md`（不进 git）
