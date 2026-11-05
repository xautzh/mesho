# Mesho

**Humans lead. Agents collaborate.**

[GitHub](https://github.com/xautzh/mesho) · [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md)

Mesho 是面向人与 Agent 协作的桌面即时通信工具。一个团队服务端连接多个本地客户端，支持私聊、群聊、@ 提醒和明确授权的 Agent 任务。

## 从源码开始

当前为 Windows x64 MVP，使用 MIT 许可证。macOS / Linux 桌面端尚未验证。需要 Node.js 22.12+ 和 Go 1.26+；Agent 功能还需自行安装、登录对应 CLI。普通聊天无需模型账号。

```powershell
git clone https://github.com/xautzh/mesho.git
cd mesho
.\Start-Server.cmd
```

保留服务端终端，在新终端打开同一目录并运行 `Start-Mesho.cmd`。首次启动会安装桌面依赖并构建；填写服务端显示的邀请码即可连接。`Start-Mesho-Test2.cmd` 使用独立本地数据，可用另一个用户 ID 测试通信。

人负责目标与决策；Agent 在各自授权范围内工作，通过即时通信完成协作。源码包含 Go 服务端、Electron/TypeScript 桌面端和 `website/` 静态官网。

## Windows 本地启动

运行包解压后：

1. 运行 `Start-Server.cmd`，保留服务端窗口，复制显示的团队邀请码。
2. 运行 `Start-Mesho.cmd`，填写服务地址 `http://127.0.0.1:7331` 和邀请码。
3. 填写唯一用户 ID、姓名和职责，连接后即可聊天。
4. 要执行 Agent 任务，在「设置」中选择本地工作目录、消息处理方式和执行器，并在系统终端提前完成对应 CLI 的安装和登录。

`Mesho.exe` 依赖同目录的运行文件，不要单独移动。关闭窗口会收进系统托盘；完全退出请使用托盘菜单「退出 Mesho」。默认本地数据目录是 `%APPDATA%\Mesho`，可通过 `MESHO_DATA_DIR` 指定独立目录。

使用 `npm run package` 构建目录包后，可执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-server.ps1
.\desktop\release\win-unpacked\Mesho.exe
```

## 一台电脑模拟多位同事

构建目录包后，在源码根目录运行（未打包时也可以使用两个启动脚本）：

```powershell
$meshoExe = (Resolve-Path .\desktop\release\win-unpacked\Mesho.exe).Path
$env:MESHO_DATA_DIR = "$env:LOCALAPPDATA\Mesho-Test-Dev"
Start-Process -FilePath $meshoExe
$env:MESHO_DATA_DIR = "$env:LOCALAPPDATA\Mesho-Test-QA"
Start-Process -FilePath $meshoExe
Remove-Item Env:MESHO_DATA_DIR
```

两个客户端使用同一个服务地址与邀请码，但填写不同用户 ID。各自的登录、消息、项目和执行器配置独立。

## 聊天与群协作

- 左侧导航切换消息、通讯录、Agent 任务和设置。
- 中间显示会话、最近消息、未读数和 @ 提醒，支持搜索及群聊/未读筛选。
- 右侧显示选中会话，支持查看成员和加载更早消息。
- 通讯录点击「发消息」开始私聊；消息列表点击 `+` 创建群聊或私聊。
- 普通消息以本人的身份发送，不依赖模型账号或项目配置。
- 输入 `@`，选择群成员；支持上下键选择、Enter 确认。发送内容中的 `@用户ID` 与成员匹配时也会记录提醒。
- Enter 发送，Shift + Enter 换行；中文输入法确认候选字不会误发送。
- 发送方只发送普通消息，不选择 Agent 或项目。接收方选择自己回复、处理前确认，或自动处理信任同事的消息。
- 接收方只需选择一个本地工作目录。群聊自动处理仅针对 @ 自己的普通消息，启用前的历史消息不自动执行。
- 接收方可以逐条点击「交给我的 Agent」。处理结果可自动回复到原聊天，或先保留在任务详情，确认后点击「发送 Agent 回复」。失败、停止和拒绝会同步处理状态，具体诊断保留在本地任务中。
- 消息先进入本地发件箱，断线恢复后补发；失败有明确状态和重试入口。已发送表示服务端收件，不表示对方已读。

当前群聊成员在创建时确定，最多 50 人。暂不支持成员增删、群转让、附件和语音视频。输入草稿在本次客户端运行期间按会话保留；消息与已读位置持久化。

## 围绕目标协作

在私聊或群聊点击「发起协作」，发布共同目标与验收提案。提案不会启动任何人的 Agent。群聊可容纳多名前端、后端、测试等参与者，同一角色可以由多人承担。

1. 每个人阅读提案，点击「确认我的分工」，填写自己的角色、负责范围和验收标准。
2. 本人选择人工参与，或选择 Agent 参与。确认分工只保存职责，不会执行；同步成功后，本人点击「开始我的任务」才启动。运行目录、CLI、权限和预算仍由本人本地配置决定。
3. 任何成员都可补充共同目标。提交后，所有旧分工需要重新确认；在线客户端收到更新后停止旧任务。离线客户端在重新同步后处理变更，已经发生的操作不会自动回滚。
4. 已授权的 Agent 可以向其他已确认参与的成员提问，一轮最多同时询问 10 人。接收者自行回答，或按本地规则交给自己的 Agent。收到全部关联答复后，提问方依本人选择自动继续或等待确认；Codex / Claude 沿用本地会话。
5. 每个人分别确认本人结果与验收证据。所有仍参与的成员都确认本轮完成后，发起人才可汇总关闭；发起人不能代替别人验收。

聊天上方只保留固定高度的任务切换栏，多个协作可分别选择。「查看协作」打开侧边详情，显示分工、状态和该项协作最近 200 条沟通与交付记录；更早记录可在聊天中加载。开始时间、计划、提问、答复、进度和实际结果可追溯。CLI 退出不代表交付成功，输出标记为待核对结果；Agent 可明确报告阻塞，阻塞任务不能直接验收，可补充反馈后继续。进度和完成通知不自动启动任务；重复答复不重复执行。单个 Agent 每轮只发一批协作问题，等待答复后再继续，每个目标每位 Agent 最多发送 40 条协作消息，仍受本地执行次数预算约束。普通咨询继续使用聊天消息，无需发起协作。

客户端使用 0.6.1，服务端使用 0.6.0。协作状态在客户端在线时同步；旧协作记录保留兼容处理流程。

## 执行器

在「设置 → Agent 执行器」选择类型。运行命令仅保存在本机，不接受远端消息覆盖。带空格的程序路径使用双引号；命令按程序与参数拆分，不自动经过 shell，任务材料通过标准输入传递。

### Codex / GPT

选择 `Codex · GPT`，运行命令留空时使用「Codex 可执行文件或安装路径」。也可以填写：

```text
codex
"C:\tools\codex.exe"
```

客户端追加 `exec --skip-git-repo-check --json` 或对应的 `resume` 参数，支持在用户选择的普通目录中咨询和工作，不要求目录本身是 Git 仓库，继承原生 CLI 配置、Skills、插件、MCP、权限策略及用户项目规则，不覆盖 developer_instructions 或 multi_agent。它管理自己的 CLI 会话，不注入或接管已打开的 Codex 桌面聊天。

### Claude Code

选择 `Claude Code`，运行命令留空使用 `claude`，也可填写：

```text
claude --model sonnet
"C:\tools\claude.exe" --model opus
```

客户端追加非交互 `-p --output-format json`，通过 `session_id` 记录和恢复本地会话。沿用 Claude 本机工具、MCP、Skills 和权限配置，不注入工具白名单或禁用技能。

### 自定义 CLI

选择 `自定义 CLI` 并填写完整运行命令，例如：

```text
python "C:\tools\my-agent.py"
node "C:\tools\agent-wrapper.mjs" --model my-model
```

约定：

1. 程序在本地映射的项目目录启动。
2. 从 stdin 读取 UTF-8 本地规则及外部请求材料，收到 EOF 后处理。
3. 将最终结论写到 stdout；诊断信息写 stderr。
4. 成功以 0 退出，失败以非 0 退出；不能等待交互式登录或终端审批。
5. stdout 上限 8MB，结果回告最多 16000 字符。超时或手动停止会终止进程树。

自定义 CLI 不自动恢复会话，权限由其原生配置决定，实际权限由所配置程序负责。Mesho 的接收审批、单次超时、暂停和次数限制仍生效。可显式指定本地脚本解释器；`.cmd` 只自动识别官方 Codex / Claude npm 包入口。

切换执行器、运行命令或项目路径后，会话绑定重新隔离，避免把 Codex 的会话 ID 交给 Claude。

## 本地执行规则

- 项目格式：`项目ID = 本机绝对目录`，目录不会向同事发布。
- 默认自己回复，启用 Agent 处理需要本地设置工作目录；自动处理只适用于信任同事，其他同事需确认。
- 远端不能设置运行命令、执行目录、会话 ID、权限、超时或预算。
- Agent 回复不触发自动执行；普通消息是否执行只由接收方的本地配置决定。
- 每个本地话题默认最多 4 次执行，每小时最多 20 次。
- 聊天 Agent 回复不会启动自动复验。旧版 CLI 协作任务保留独立的兼容处理流程。
- 客户端意外退出的运行任务会标记为「需核对」，不会盲目重跑。
- 本地规则和权限限制可以减少误执行，无法保证模型绝不会受消息或项目文件中的恶意内容影响。

## 团队内网部署

团队只需一台服务端。生产使用 TLS：

```powershell
$env:MESHO_INVITE = '使用至少16位的随机邀请码'
.\server\mesho-server.exe --listen 0.0.0.0:7331 --db .\server\mesho.db --tls-cert .\cert.pem --tls-key .\key.pem
```

测试环境可以显式允许内网明文：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-server.ps1 -Listen 0.0.0.0:7331 -AllowInsecureLan
```

同事使用服务器的内网 IP，而不是 `127.0.0.1`。按公司网络规则开放端口。明文连接不保护邀请码、访问凭证或聊天内容；默认服务端仅监听本机。

服务端 SQLite 数据包含公开身份和消息；邀请码保存在 `server/server.local.json`，用户访问凭证以哈希存储。桌面凭证使用操作系统加密存储。本地数据与凭证文件不要提交到 Git 或发送给同事。

升级前关闭所有客户端、停止服务端，并备份服务端和客户端数据目录。使用新服务端及新客户端，SQLite 会自动添加聊天数据表并将已有可关联任务消息纳入会话。请不要在运行时覆盖二进制文件。

## Agent CLI 接入

桌面端启动时提供只监听本机的认证桥接 API：

```powershell
node .\desktop\mesho-cli.mjs peers
node .\desktop\mesho-cli.mjs status
node .\desktop\mesho-cli.mjs send --to wang-dev --project orders --text "请检查订单接口"
```

CLI 发送的是协作任务，在同事客户端进入本地审批流程。发送和回告也会显示在对应私聊。多客户端使用相应 `MESHO_DATA_DIR` 或 `--bridge` 指向该客户端的凭证文件。Mesho 不注入委派禁用环境变量。Agent 回复仍不自动触发新的聊天执行。

## 开发与验证

Go 服务端使用 SQLite，桌面使用 Electron + TypeScript + Vite。依赖版本由 `go.mod` 和 `package-lock.json` 固定。

```powershell
cd server
go test ./...
go build -o mesho-server.exe .
cd ..\desktop
npm ci
npm run build
npm test
npm run test:e2e
npm run package
```

Windows 目录包输出到 `desktop/release/win-unpacked`。端到端测试启动真实服务端及独立 Electron 客户端，模型执行使用测试夹具，不消耗模型额度。可通过 `MESHO_DESKTOP_BINARY` 和 `MESHO_SERVER_BINARY` 指向待验收构建。

## 品牌

标志由两个相连的对话气泡形成 M：圆点代表人，四角星代表 AI，连接处代表沟通与协作。使用透明背景、蓝色主色与浅蓝连接点；界面以白灰色为主。Logo 位于 `desktop/public/logo.png`，应用图标位于 `desktop/assets`。

MIT License。


## 消息显示与处理进度

消息支持 Markdown 表格、代码块、标题、列表、引用和链接；原始 HTML 不执行，消息不加载远程图片。链接仅可由用户点击后在外部浏览器打开 HTTP(S) 地址。

打开并查看聊天后同步已读位置。私聊显示未读或已读，群聊显示已读人数。接收方把消息交给 Agent 后，发送者可查看待确认、排队、执行中、等待确认回复、回复发送中、已回复、失败、停止和中断状态。已读与 Agent 执行状态独立。运行状态超过一分钟未更新时显示状态待更新，不据此断言执行结束。离线时保留最后同步状态，上线后补发。

服务端须支持回执和活动接口；旧服务端会显示回执暂不可用。回执与状态只对原会话成员可见，只允许接收方更新自己的处理状态。
