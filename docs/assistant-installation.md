# Codex、Qwen Code 与 WorkBuddy 安装入口

官方入口核对日期：2026-10-19。三种助手都使用本仓库 `skills/douyin-hotspot-game-creation/SKILL.md` 及其配套文件，后端接口不变。下面是安装方法；不表示本轮已在三个宿主分别完成真实模型与腾讯交付验收。

先按 [README](../README.md) 安装本机 Node/Python/FFmpeg/Ollama、下载两个模型，配置本人的红狐 API Key，再启动 `npm start`。助手须有本机文件及终端权限，能访问这个后端的 localhost；云端助手的 localhost 不会自动连接到你的电脑。安装 Skill 本身不会下载模型，也不会带入任何人的密钥或腾讯权限。

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

Qwen Code 所连接的对话模型与本机 `qwen3-vl:8b-instruct` 是两件事：前者负责助手执行，后者由创作台实际读取视频抽帧。仍需安装 Whisper 多语言 Small。

## WorkBuddy 桌面版

使用 [WorkBuddy 官方“技能”说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) 中的界面导入方式，不假定它使用 CodeBuddy CLI 的技能目录。

1. 仅将仓库 `skills/douyin-hotspot-game-creation/` 打成技能压缩包；不要压缩整个仓库、`.env`、`data/` 或 `models/`。例如已完成 setup 后，在仓库运行下面命令（Windows 将 Python 路径替换为 `.venv\Scripts\python.exe`）：

   ```sh
   .venv/bin/python -c "import shutil; shutil.make_archive('data/douyin-hotspot-game-creation', 'zip', 'skills', 'douyin-hotspot-game-creation')"
   ```

2. WorkBuddy 左侧“专家·技能·连接器” → “技能” → “添加技能” → “上传技能”，选择生成的 `data/douyin-hotspot-game-creation.zip`。
3. 在“已安装”中确认启用。选择本机仓库作为工作目录，并说明服务地址。对话安装仅针对其技能市场中的技能；本仓库自定义包用上传入口。
4. 若该客户端版本拒绝包格式或不能运行本机命令，保留明确的限制，使用下面的手动后备；不能宣称已经安装成功。手机/云模式不纳入本机工作流验收。

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
