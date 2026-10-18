# Windows 安装与排错

Windows 与 macOS 使用同一套 Skill、网页、任务库和交付流程。当前有 Windows 本机服务及受控测试证据，尚不能据此声称真实视频分析至腾讯交付已全链验收。详见 [验收记录](acceptance.md)。

## 1. 准备环境

准备 64 位 Windows、Git、Node.js 24 或以上、Python 3.11/3.12、Google Chrome，以及能在本机提供 HTTP 接口的 Ollama。安装依赖后重新打开 PowerShell，检查：

```powershell
git --version
node --version
npm.cmd --version
py -3.12 --version
ollama --version
ollama list
```

Python 只有 3.11 时，把下文 `py -3.12` 换为 `py -3.11`；没有 Python Launcher 时使用 Python 可执行文件绝对路径。视觉模型名称为 `qwen3-vl:8b`，语音使用 faster-whisper 可读的 small 模型目录或现有缓存。已有模型直接复用，不重复下载。OpenAI Whisper 的 `.pt` 文件不能直接当作 faster-whisper 模型目录。

本项目不会自动安装或下载模型。未备好模型时先完成环境准备；不要把仅完成依赖安装当作可以生成方案。显存、内存、实际速度以本机诊断及真实样本测试为准；当前语音实现使用 CPU int8。

## 2. 克隆与安装项目依赖

在准备存放项目的目录运行：

```powershell
git clone https://github.com/zzy170031-cmd/crawl.git
Set-Location crawl
npm.cmd ci
py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements-media.txt
Copy-Item .env.example .env
```

以上是首次安装命令。已有仓库直接进入仓库，保留已有 `.env`，不要用样例覆盖令牌与配置。无需激活虚拟环境，也不需要修改 PowerShell 执行策略。

**本项目原开发设备的特殊规则**：如设备配置了 `E:\coderely\env\coderely-dev.cmd`，安装 npm 依赖时将上面的 `npm.cmd ci` 替换为以下命令，先加载该设备工具链；普通 Windows 设备无需创建这一目录。

```powershell
cmd /c "call E:\coderely\env\coderely-dev.cmd && npm ci"
```

## 3. 配置本机路径

用编辑器打开仓库根目录 `.env`。例如仓库放在 `D:\projects\crawl`，配置如下（替换成你的真实目录）：

```dotenv
PORT=4318
CRAWL_PYTHON=D:/projects/crawl/.venv/Scripts/python.exe
CRAWL_MODEL_URL=http://127.0.0.1:11434
HOTSPOT_VISION_MODEL=qwen3-vl:8b
CRAWL_CDP_URL=http://127.0.0.1:19327
CRAWL_WHISPER_MODEL=D:/models/faster-whisper-small
```

最后一行必须指向已存在且格式兼容的模型目录。使用现有 Hugging Face 缓存时，改为 `CRAWL_WHISPER_MODEL=small` 并设置 `CRAWL_WHISPER_CACHE` 为对应缓存根目录。路径可用正斜杠，避免转义问题；不要照搬其他电脑的目录。

Chrome 非默认安装位置时增加 `CRAWL_CHROME_PATH`，指向真实 `chrome.exe`。端口被占用时修改 `PORT=4319`。模型接口和 CDP 当前只接受本机地址，不支持把 `.env` 直接改成另一台 M5 的局域网地址。应在模型所在的电脑上运行这份仓库。

## 4. 启动与验证

先打开本机 Ollama 应用。如果没有后台服务，可在独立终端运行 `ollama serve`；已运行时无需再启动一份。然后在仓库目录运行：

```powershell
npm.cmd run browser
# 在弹出的专用 Chrome 中登录热点宝和抖音。
npm.cmd run doctor -- --probe
npm.cmd start
```

打开 `http://127.0.0.1:4318/`（以 `.env` 的 PORT 为准），保留服务终端与专用 Chrome。内置浏览器里登录过，不代表采集用的独立 Chrome 已登录。电脑休眠或服务关闭时不会按小时采集。

诊断不下载模型，不写腾讯；成功的双色图探针只证明图像接口工作，不能证明真实视频理解质量。

腾讯令牌只填本机 `.env` 的 `TENCENT_DOCS_TOKEN`。在网页设置目标表格 ID 和对应链接，确认后再交付；不把令牌或私人运行数据提交到仓库。

## 5. 安装 Skill 与助手调用

将仓库 `skills/douyin-hotspot-game-creation` 整个目录复制到所用助手的 skills 目录。若目录已存在，先核对是否有自定义修改再更新。设置环境变量 `CRAWL_HOME` 为仓库绝对路径；当前 PowerShell 会话可使用：

```powershell
$env:CRAWL_HOME = (Get-Location).Path
npm.cmd run task -- learn "率土之滨"
npm.cmd run task -- list
npm.cmd run task -- status TASK_ID
```

当前终端设置不会自动传播到已经运行的助手应用；需要在应用使用的环境中配置 `CRAWL_HOME` 并重新加载技能。CLI 与网页都要求本机服务运行，`npm.cmd run task` 会读取仓库 `.env`。

## 6. 常见失败

| 现象                           | 核查与恢复                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch failed`                 | 这是连接失败的通用信息，不能单凭文字判断来源。先检查任务阶段和服务日志；模型检查阶段执行 `Invoke-RestMethod http://127.0.0.1:11434/api/tags`。连接不上则启动本机 Ollama；另一台 Mac 有模型不会使当前 Windows 的此地址可用。 |
| 未发现指定模型                 | 执行 `ollama list`，核对模型完整名称与 `.env`；不要重复下载已存在的模型。                                                                                                                                                   |
| `ECONNREFUSED 127.0.0.1:19327` | 执行 `npm.cmd run browser`，保留专用 Chrome 并完成登录。                                                                                                                                                                    |
| Whisper 模型无法加载           | 核对 `CRAWL_PYTHON`、模型目录/缓存、faster-whisper 格式；本程序离线读取，不会偷偷联网补下载。                                                                                                                               |
| `npm.ps1` 无法执行             | 使用本文的 `npm.cmd`，不需要放宽整台电脑执行策略。                                                                                                                                                                          |
| 模型超时或内存不足             | 保存诊断和任务 ID，处理资源问题后重试原任务；已成功批次可复用，不回退到标题模板。                                                                                                                                           |
| 端口已占用                     | 修改 `.env` 的 PORT，重新启动服务并打开相应端口。                                                                                                                                                                           |

修改 `.env` 后重启项目服务。失败任务在条件补齐后点击重试，不重复创建大量相同任务。`data/`、`.env`、浏览器登录资料、模型和用户媒体都留在本机；迁移设备时重新配置与登录。
