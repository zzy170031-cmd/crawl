# Codex、Qwen Code 与 WorkBuddy 安装入口

官方入口核对日期：2026-10-20。三种助手都使用本仓库 `skills/douyin-hotspot-game-creation/SKILL.md` 及其配套文件，后端接口不变。下面是安装方法；不表示本轮已在三个宿主分别完成真实模型与腾讯交付验收。

先按 [README](../README.md) 安装本机 Node/Python/FFmpeg；新候选入口使用既有助手图文能力（兼容 Codex CLI 或 WorkBuddy Skill 协作模式）与本地多语言 Small，Ollama/Qwen 权重为旧实验可选配置，配置本人的红狐 API Key，再启动 `npm start`。助手须有本机文件及终端权限，能访问这个后端的 localhost；云端助手的 localhost 不会自动连接到你的电脑。安装 Skill 本身不会下载模型，也不会带入任何人的密钥或腾讯权限。

## Codex

[OpenAI 官方技能文档](https://learn.chatgpt.com/docs/build-skills) 当前约定项目目录 `.agents/skills/`、用户目录 `~/.agents/skills/`；本说明使用项目安装。

1. 在克隆的 `crawl` 目录创建 `.agents/skills/`。
2. 将完整 `skills/douyin-hotspot-game-creation/` 文件夹复制进去，最终得到 `.agents/skills/douyin-hotspot-game-creation/SKILL.md`，同时保留 `references/`、`scripts/` 等文件。已存在同名目录时先核对自定义修改，不直接覆盖。
3. 在 Codex 打开该仓库，通过技能列表或 `$douyin-hotspot-game-creation` 明确调用。若没有发现新技能，重启 Codex 或使用下方通用后备。

也可在 Codex 使用内置 `$skill-installer` 并明确给出仓库 `https://github.com/zzy170031-cmd/crawl` 和路径 `skills/douyin-hotspot-game-creation`，由安装器处理其本机版本支持的目录；不要仅复制一份 SKILL.md 丢失配套文件。

## Qwen Code

[Qwen Code 官方技能文档](https://qwenlm.github.io/qwen-code-docs/zh/users/features/skills/) 约定项目目录 `.qwen/skills/`、用户目录 `~/.qwen/skills/`。

1. 在 `crawl` 中创建 `.qwen/skills/`，复制完整技能文件夹。
2. 最终路径为 `.qwen/skills/douyin-hotspot-game-creation/SKILL.md`。
3. 在此项目启动 Qwen Code，用 `/skills` 检查并启用技能；请求使用 `douyin-hotspot-game-creation`。若当前版本未自动刷新，重新打开会话。

Qwen Code 的 Skill 安装不代表它支持当前 `codex exec` 后台协议。采集功能可用；自动学习与创作需另外配置已测试的兼容宿主和 Whisper 多语言 Small，不应为此盲目下载 Qwen 视觉模型。当前没有 Qwen Code 整链验收记录。

## WorkBuddy 桌面版

使用 [WorkBuddy 官方“技能”说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) 的自定义技能上传入口，不假定它使用 CodeBuddy CLI 的技能目录。此模式不需要安装 Codex 或新视觉/文本模型；WorkBuddy 用自己的图文能力处理本机有期限请求，语音转写仍用本地多语言 Small。

1. 下载本仓库的 `dist/douyin-hotspot-game-creation-workbuddy.zip`。它只包含完整 Skill 文件夹与配套说明，不含完整应用、密钥、用户素材或模型。
2. WorkBuddy 左侧“专家·技能·连接器” → “技能” → “添加技能” → “上传技能”，选择该压缩包，在“已安装”中确认启用。对话安装只针对其市场技能，本仓库使用自定义上传入口。
3. 将完整 [crawl 仓库](https://github.com/zzy170031-cmd/crawl) 克隆或解压到本机，并在 WorkBuddy 选择此目录为工作目录。按 README 安装 Node.js 24+、Python 3.11/3.12、FFmpeg/ffprobe、Python 依赖及多语言 Small（约484MB）；已有兼容依赖可复用，不重复下载。
4. 首次初始化运行 `node scripts/setup.mjs --host=workbuddy`，它仅在 `.env` 不存在时创建配置。已有 `.env` 不会被覆盖；请本人在本机编辑器将 `CRAWL_STUDY_HOST_PROVIDER=workbuddy`，保留其他配置后重启服务。不要将 `CRAWL_STUDY_HOST_CLI` 当作 WorkBuddy 路径，此模式不调用它。
5. 用本机设置界面或编辑器配置本人红狐 API 和腾讯授权；助手不读取、打印 `.env`、Token 或 Key。用 `npm run doctor -- --layer=host` 检查宿主与语音依赖（不要求Ollama视觉模型），再运行 `npm start`，打开它显示的 localhost 地址，不能直接双击 `index.html`。
6. 在网页完成一次明确批准的查询及原片预算，启动学习或创作时，回 WorkBuddy 明确请求处理本轮任务。助手按 [WorkBuddy 运行合同](../skills/douyin-hotspot-game-creation/references/workbuddy.md) 读取请求、实际画面和转写，回交符合 schema 的候选。它必须保持本轮会话运行；网页点击后关闭 WorkBuddy 不会无人值守完成。

可复制这段首次初始化提示，先将路径替换为自己的绝对路径：

> 使用已安装的 douyin-hotspot-game-creation Skill，为我配置 WorkBuddy 版创作台。仓库目录是「我的绝对路径/crawl」；若目录不存在，先从 https://github.com/zzy170031-cmd/crawl 克隆到我指定的位置。先读取 README、Skill 和 references/workbuddy.md，检查 Node/Python/FFmpeg 与语音模型是否已有，再安装缺少的依赖并用 node scripts/setup.mjs --host=workbuddy 初始化；已有配置保留，不读出凭据，不自动下载新模型。需要 Small 时先告知大小与官方来源，由我确认下载。告诉我如何在本机填写自己的红狐 API、腾讯 MCP Token 和表格链接，再启动创作台。先不调用收费搜索、不写腾讯。后续我明确要求处理学习或创作时，用 npm run workbuddy 的请求/响应协议在当前会话接续，不启动 Codex。

服务运行后可复制日常接续提示：

> 请处理我这次在创作台明确启动的学习或创作任务，按 references/workbuddy.md 逐个领取本轮请求、查看实际图片并提交候选；不要追加收费查询或原片解析，不写腾讯。若没有待办，最多等待45秒后告诉我；已取消或过期的任务不重建、不重试。候选完成后先让我审阅。

命令速查（在仓库目录运行；Windows 使用 `npm.cmd`）：

```sh
npm run workbuddy -- list
npm run workbuddy -- wait 45
npm run workbuddy -- request KIND UUID
npm run workbuddy -- submit KIND UUID RESPONSE.json
```

`KIND` 只允许请求列表实际返回的 `game-study-tasks` 或 `creative-candidate-tasks`，`UUID` 使用同条记录的 `id`。响应文件恰好包含 `nonce`、`request_sha256`、`input_sha256`、`value` 四个字段，前三项原样取自该请求，`value` 满足返回的 schema；不凭空生成绑定值。每个请求最多等待10分钟，超时、取消或已提交就停止，不能回填旧请求或无限轮询。提交通过结构校验不表示内容质量通过，仍需审阅后确认腾讯目标与写入。

本设备未安装 WorkBuddy，因此不能声称已在真实客户端完成导入、帧读取或腾讯交付。若客户端拒绝包、无本机终端权限或无法读取图片，报告缺口，不以文字猜图、不静默回退 Codex、也不声称任务完成；手机/云模式不纳入本机工作流验收。

## 共用的运行路径与后备方式

告诉助手当前仓库绝对路径，并在它的执行环境设置 `CRAWL_HOME`。macOS 的仓库终端：

```sh
export CRAWL_HOME="$PWD"
npm run task -- list
```

Windows PowerShell：

```powershell
$env:CRAWL_HOME = (Get-Location).Path
npm.cmd run task -- list
```

当前终端的环境变量不会自动传播到已经运行的桌面助手；应在该助手使用的执行环境配置，或在提示里明确仓库位置并要求先切换到此目录。后端服务仍由 `npm start` 保持运行。

可复制这段给任何能读本机文件、运行 Node CLI 的助手：

> 请读取当前仓库 skills/douyin-hotspot-game-creation/SKILL.md 及它引用的运行说明，使用这个仓库已运行的本机创作台。先列出任务与配置缺口，不发起收费查询、不写腾讯。后续只有我明确点击或批准的一次查询/原片预算才可执行；使用真实查询回执和实际音画，不以标题推断游戏机制。我的 API 和腾讯 Token 只在本机配置，不要输出它们。

日常可用 `npm run task -- list`、`status TASK_ID`、`cancel TASK_ID`；Windows 使用 `npm.cmd`。任务 CLI 自动读取仓库 `.env`。学习、选题与付费查询的当前字段以 [Skill 运行合同](../skills/douyin-hotspot-game-creation/references/runtime.md) 和应用实际接口为准，不绕过网页的预算确认。

## 各自账号与费用

每位用户自行在 [红狐官网](https://redfox.hk/) 注册，再到 [API 密钥管理](https://redfox.hk/dashboard/keys) 取得 Key、检查余额和当前接口价格。公开包不附开发者 Key。切换条件/刷新状态不计费；明确开始查询才会收费，原片解析另行确认。

腾讯文档使用该用户自己的 [MCP 授权](https://docs.qq.com/scenario/open-claw.html) 和目标在线表格链接。后端腾讯客户端独立通过 HTTP 工作，不要求必须是 Codex；WorkBuddy 自带腾讯连接器或其他助手已登录，也不等于本机后端自动得到其 Token。分享链接不是写入权限，正式交付必须验证当前账号可编辑，并由用户确认文档内容及目标。
