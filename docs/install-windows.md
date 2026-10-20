# Windows 安装与排错

使用独立本机后端，不需要原开发者账号。当前默认红狐 API，采集不依赖 Chrome/CDP。以下为 Windows PowerShell 安装路径；Windows 本轮真实原片学习至腾讯交付尚未验收。

## 环境与依赖

安装 [Git](https://git-scm.com/downloads)、[Node.js 24+](https://nodejs.org/en/download)、[Python 3.11/3.12](https://www.python.org/downloads/)、（可选旧实验路径才需 [Ollama](https://ollama.com/download/windows)）和 [FFmpeg 官网列出的 Windows 构建](https://ffmpeg.org/download.html)。FFmpeg 解压后将含 `ffmpeg.exe` 和 `ffprobe.exe` 的目录加入 PATH，重新打开 PowerShell。

```powershell
node --version
py -3.12 --version
ffmpeg -version
ffprobe -version
git clone https://github.com/zzy170031-cmd/crawl.git
Set-Location crawl
npm.cmd ci
py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements-media.txt
node scripts/setup.mjs
```

只有 Python 3.11 时将 `py -3.12` 改为 `py -3.11`。不需要激活虚拟环境，也不需要放宽 PowerShell 执行策略。`setup` 将新 `.env` 的 Python 路径指向本仓库 `.venv/Scripts/python.exe`；已有 `.env` 保持不变，换目录后手动修正路径。不会自动下载依赖、模型或覆盖密钥。

## 本人账号与模型

在 [红狐官网](https://redfox.hk/) 注册登录，打开 [密钥管理](https://redfox.hk/dashboard/keys) 生成自己的 API Key，确认余额与接口价格，然后填入本机 `.env` 的 `REDFOX_API_KEY` 或创作台设置。费用以本人后台实际价格和扣费记录为准。`CRAWL_GAME_SOURCE`、`CRAWL_HOTSPOT_SOURCE` 保持 `redfox`。

分析需要以下显式下载；已有相同模型可复用：

```powershell
# 当前新入口不要求下载该视觉权重；仅旧实验可选
# ollama pull qwen3-vl:8b-instruct
& .\.venv\Scripts\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='Systran/faster-whisper-small', local_dir='models/faster-whisper-small')"
```

视觉 [Qwen3-VL 8B Instruct](https://ollama.com/library/qwen3-vl:8b-instruct) 为 Q4_K_M、约 6.1 GB；语音 [多语言 Faster Whisper Small](https://huggingface.co/Systran/faster-whisper-small) 权重约 484 MB，CPU/INT8，不使用 `small.en`。旧 `qwen3-vl:8b` 可保留但不必下载。当前新候选由兼容宿主承担图文归纳，不要求该视觉权重；仍需多语言 Small 处理语音。Windows 下兼容宿主执行与整条业务链尚未实测，不承诺仅安装任意助手即可自动运行。

在 [腾讯文档授权入口](https://docs.qq.com/scenario/open-claw.html) 获取本人 MCP Token，在本机配置 `TENCENT_DOCS_TOKEN` 或使用创作台设置；随后填写自己的在线表格链接并确认。目标表格必须允许本人编辑，链接不是授权。原开发者或另一个助手的授权不会自动传入此服务。

## 启动与检查

只有选择旧 Ollama 实验路径时才启动它；当前新入口使用 `CRAWL_STUDY_HOST_CLI` 指定的兼容宿主。

```powershell
npm.cmd run doctor -- --layer=collection
npm.cmd run doctor -- --layer=analysis
npm.cmd run doctor -- --layer=delivery
npm.cmd start
```

打开 `http://127.0.0.1:4318/`。`.env` 改 `PORT` 后以新端口为准。保持服务终端运行；不要双击 HTML。`doctor` 只做分层就绪检查，不调用红狐、不写腾讯；可选 `--layer=analysis --probe` 会实际运行本机双色图推理，但不证明视频理解质量。

安装助手 Skill 见 [跨助手安装](assistant-installation.md)。任务状态命令：`npm.cmd run task -- list`、`npm.cmd run task -- status TASK_ID`。命令自动加载 `.env`；必须在仓库目录中执行。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 网页无法打开 | 确认 `npm.cmd start` 仍在运行、端口一致且未被占用；不是 `file://` 页面 |
| 显示未配置红狐 | 填入本人 API Key；界面保存凭据优先于 `.env`，修改环境配置后重启 |
| “已配置”但查询失败 | 该状态未验证余额/接口权限；检查明确请求的错误，再决定是否手动重试收费查询 |
| 换游戏或筛选后不自动查询 | 设计如此；确认新范围后点击“开始查询”，避免切换导致隐性费用 |
| 模型无法加载 | 核对 `ollama list`、模型名称、Python 依赖和 Whisper 目录；不会隐式下载 |
| 找不到 ffmpeg / ffprobe | 配置正确 PATH，重开终端后运行两个 `-version` 检查 |
| Tencent 配置检查通过仍无法交付 | 检查本人 Token、目标在线表格和编辑权限；本地检查不证明远程授权有效 |
| `npm.ps1` 被限制 | 用 `npm.cmd`，不用改变全局执行策略 |

不要提交或共享 `.env`、`data/`、模型、浏览器资料、私人媒体或用户目标表格。配置修改后重启；已经成功的原片可复用，旧失败状态不应冒充新成功。
