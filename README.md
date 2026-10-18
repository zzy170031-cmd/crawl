# crawl · 抖音热点游戏创作

选择目标游戏，研究抖音热门作品；选定热点后实际读取代表视频，生成完整游戏创作方案，写入用户指定腾讯在线表格。网页负责浏览与进度，腾讯文档承载详细正文。只做爆款拆解/改编和热点联动。

**状态：可运行首版，待 Apple M5 与真实腾讯全链验收。** 已有共享任务执行器、持久化恢复、游戏资料版本、媒体分析检查点和受控交付。自动阅读当前为抽样画面＋自动语音，不等同全片音画理解。关键声音信息不足时任务停在待补读，不输出伪造脚本。验收范围见 [docs/acceptance.md](docs/acceptance.md)。

支持 macOS 与 Windows 本机部署。Windows 完整命令见 [Windows 安装与排错](docs/install-windows.md)；两种系统使用同一任务流程，分别记录真实验收结果。

## Mac M5 安装与启动

要求：macOS 14+、Node.js 24+、Python 3.11/3.12、Google Chrome；已安装并启动 Ollama，已有 `qwen3-vl:8b`；已有可供 faster-whisper 读取的 Whisper small 模型。安装其他格式的同名模型不自动兼容，诊断会明确失败，不隐式下载。

```sh
git clone https://github.com/zzy170031-cmd/crawl.git
cd crawl
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-media.txt
cp .env.example .env
```

在 `.env` 中设置 `CRAWL_PYTHON=.venv/bin/python`。如 Whisper 已在其他目录，设置 `CRAWL_WHISPER_MODEL` 为模型目录，或 `CRAWL_WHISPER_CACHE` 为现有缓存根目录。无需下载 Windows Ollama 安装包。

```sh
npm run browser
# 在打开的独立 Chrome 中登录热点宝和抖音。
npm run doctor -- --probe
npm start
```

打开 http://127.0.0.1:4318 。若已有服务使用该端口，在 `.env` 设置 `PORT=4319`。`doctor` 不写腾讯、不下载模型；双色图探针只验证图像调用，不能替代真实视频验收。

腾讯令牌仅写入本机 `.env` 的 `TENCENT_DOCS_TOKEN`，不要发送到聊天或提交仓库。在网页“腾讯文档交付设置”填写用户指定表格的 `file_id` 与链接；两者须对应同一表格，可由已连接的腾讯MCP获取ID。未配置或无权限时任务不能交付。

## 日常流程

1. 输入游戏并启动学习。后台读取代表作品和互联网资料，资料不足会停下说明原因。
2. 选择一级行业、榜单、时间窗口；关键词可空。行业选择主动获取热点。
3. 可点击“每小时刷新此范围”；订阅持久化，不会因首次失败而丢失。电脑休眠或服务关闭期间不采集。
4. 确认热点、A/B模式、视频/图文及已配置交付位置。任务执行到完整策划与腾讯同步，网页提供取消/重试。
5. 打开腾讯子表查看完整方案和原片链接。正文、超链接、样式分别报告验证状态；警告不是全项成功。

游戏学习默认5条候选，至少3条实读相关作品；资料默认7天更新，过期需更新后选题。热点最多3条代表作品。来源当前为热点宝榜单首屏查询，每榜最多20条，不是抖音全站抓取。没有可读材料时不能靠标题生成正式策划。

## 安装技能与助手入口

将 `skills/douyin-hotspot-game-creation` 文件夹复制到所用助手支持的 skills 目录，设置 `CRAWL_HOME` 为本仓库绝对路径。服务运行后，助手通过同一执行器操作：

```sh
npm run task -- learn "率土之滨"
npm run task -- list
npm run task -- status TASK_ID
npm run task -- retry TASK_ID
npm run task -- cancel TASK_ID
```

调用 skill：`$douyin-hotspot-game-creation 为率土之滨学习近期热门作品，再处理我确认的热点，写入我指定的腾讯表格。`

查询/选题JSON及接口见 [运行合同](skills/douyin-hotspot-game-creation/references/runtime.md)。直接使用 `node scripts/task.mjs` 时需自行加载环境变量；`npm run task -- ...` 自动读取 `.env`。

## 数据与维护

运行数据默认只在本机 `data/`：任务库、快照、游戏资料、媒体和浏览器登录资料，全部忽略提交。不要把它们打包给其他设备；新设备重新登录与配置。模型权重不在仓库内。

```sh
npm test
npm run check
```

Windows 仍可运行；本设备执行 npm 安装时按设备规则激活 `E:\coderely\env\coderely-dev.cmd`。跨设备配置见 [模型与运行说明](docs/runtime.md)。来源见 [来源与许可边界](docs/provenance.md)。
