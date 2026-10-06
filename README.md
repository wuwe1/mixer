# mixer

mixer is a small web app that lets you watch and drive the Claude Code (and Codex) sessions on your Mac from a browser — including your phone. It reads the local session transcripts, runs your own logged-in `claude` CLI for new turns, forks and permission prompts, and serves everything on 127.0.0.1; remote access goes through Cloudflare Tunnel + Access or Tailscale Funnel + passkeys. It is a personal tool: whoever can reach it can run commands on your Mac as you.

远程看、远程驱动本机的 Claude Code 会话（也能看、能跑 Codex 的会话）。只给自己用。

## 是什么

- **侧栏是工作区**：放你挑进来的文件夹和会话。每行带状态标记：运行中、待确认、跑完没看、出错、终端里开着
- **会话页**：和 Claude 的对话按原样显示（思考、工具调用和结果、子代理、上下文压缩、后台任务通知），运行中的回复边写边出来。可以继续（运行中发的会排队）、停止、在请求确认时允许或拒绝，从任意一条回复或工具调用「分叉」，或「编辑并分叉」自己的一条消息
- **输入框**：权限（自动 / 每次询问 / 计划模式）、模型、skill、图片（可以在图上画箭头、随手画线）；右下角是上下文用了多少
- **项目页**：开新会话（选 Claude Code 或 Codex），看仓库文件、未提交的改动（GitHub 样式的 diff）和最近的提交
- **图解**：Claude 讲概念、流程、算法、数据时在回复里放图（流程图、时序图、图表、逐帧演示、对比、小测验……），像 claude.ai 的 artifact；模型只写 JSON，画法是 mixer 自己的组件
- **用量**：侧栏底下是订阅这周、5 小时窗口用了多少
- 手机上侧栏从左边拉出来，可以「添加到主屏幕」当 App 用

细节（会话记录怎么读、运行怎么起、界面约定）都在 [CLAUDE.md](CLAUDE.md)。

## 需要

- macOS（常驻用 launchd；别的系统没试过）
- Node.js 22.18+（直接跑 `.ts`，不用编译），pnpm 10，git
- 装好、登录过的 `claude` 命令行（mixer 只用它，走你自己的订阅，不要 API key）
- 可选：Codex.app（跑 Codex 会话，用它带的 `codex`，`MIXER_CODEX` 可改路径）；`cloudflared`（Cloudflare Tunnel）或 Tailscale（Funnel）——手机访问二选一

mixer 用到了 `claude` 命令行帮助里没写的参数（`--thinking-display summarized`、`--resume-session-at`），也直接读 Claude Code、Codex 的会话记录（内部格式）。在较新的 Claude Code 上用着没问题，但它们换了版本可能就要跟着改。

## 装和跑

```sh
pnpm i
pnpm start                 # http://127.0.0.1:4848（MIXER_PORT 可改）
```

常驻（开机自己起、挂了拉起来）：

```sh
pnpm mixer service         # 先看看要写的 plist
pnpm mixer service install # 写 ~/Library/LaunchAgents/com.mixer.server.plist 并启动；已经有了要加 --force
pnpm mixer service uninstall
```

日志在 `~/Library/Logs/mixer.log`。常驻时改了 mixer 自己的代码会在空闲时自动换上。

## 手机访问

> [!WARNING]
> **能连上 mixer 的人，就能以你的身份在这台 Mac 上执行任何命令。**
>
> - 不要把 4848 端口直接暴露出去（端口转发、`0.0.0.0`、反向代理都不要）。mixer 只听 127.0.0.1
> - 远程访问没配置之前，所有远程请求都会被拒绝；配置只用下面两种方式
> - 这台 Mac 上的其他用户（和本机跑的任何程序）连 127.0.0.1 都算「本机」，直接放行
> - 远程来的请求：经 Cloudflare 的，mixer 自己再验一遍 Access 的 JWT；经 Funnel 的，没有登录（passkey）就什么都拿不到

二选一：

```sh
pnpm mixer setup cloudflare  # Cloudflare Tunnel + Access：要有托管在 Cloudflare 的域名，手机用邮箱验证码登录
pnpm mixer setup funnel      # Tailscale Funnel + passkey：不要域名，Mac 上装 Tailscale，手机用面容 / 指纹登录
```

passkey：

```sh
pnpm mixer pair              # 出一个配对码（二维码，10 分钟、一次性），手机扫了建 passkey
pnpm mixer passkeys          # 登录过的设备
pnpm mixer passkeys rm <id>  # 删掉一台，它立刻登不进来
pnpm mixer                   # 现在的配置、手机打开哪个地址
```

配置在 `data/access.json`（不进 git），改了不用重启。

## 开发

```sh
pnpm dev     # Vite 开发服务（5173），/api 转到 4848
pnpm check   # 类型检查
pnpm test    # node:test，fixtures 在 test/fixtures，不读本机的会话记录
```

## 许可

MIT
