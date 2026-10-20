# CRAWL · 热点游戏创作台

本机运行的游戏内容工作台：在**游戏广场**选择游戏、采集热门视频并准备学习材料；在**热点广场**选择行业与日期、查询红狐每日热门作品；在**创作任务**集中处理已确认选题，审阅方案后交付到自己的腾讯文档。

默认来源为 **RedFoxHub API**。用户手动点击“开始查询”才会发起计费搜索；切换游戏、行业、日期、刷新本地状态和打开页面不会自动收费。原片解析下载另有费用预览和确认，查询授权不等于原片批量下载授权。

**当前验收范围：采集阶段已取得真实证据；完整模型学习、内容质量与两条创作链路到腾讯文档的交付尚未全部验收。** 六个真实查询范围和 20 条率土之滨原片的验收见 [采集记录](docs/redfox-collection-acceptance-20261019.md)。安装成功、配置成功、文件哈希通过不能替代视频理解或文档交付验收。

学习阶段仍在开发测试：本机8B模型实测出现过摘要方向写反、版本限定丢失，简单机器复核也曾漏检，详见[游戏初学实测](docs/game-learning-acceptance-20261019.md)。不要将当前源码安装成功理解为自动策划质量已经通过；只使用采集功能可先不下载分析模型。

当前服务端保留实验质量门禁，暂停新批次学习、创作和腾讯文档产出；采集与旧证据查看仍可用。门禁不能通过刷新或补足20条解除。受控本机质量测试由维护者继续验收，通过后另行发布解除门禁的版本。

### 两种游戏素材入口

联网查询与本地上传同时保留。在正常创作台的游戏广场输入目标游戏后，可点击“开始查询”获取联网结果，也可在“本地视频素材”区域点击“选择视频上传”，选择自己的 MP4、MOV、M4V 或 WebM 文件（支持的现代 MP4/MOV 容器；单个不超过 1GB，每批最多20个）。该区域显示所属游戏、当前列表的本地原片数量和上传进度；保存的视频在下方素材列表预览。上传仅保存到本机 `data/local-videos/`，不调用红狐、不自动开始学习或写腾讯；未配置 API 时可在连接提示选择“先使用本地素材”。需要 FFmpeg 的 `ffprobe` 检验实际视频流，不要求为上传下载模型；无音轨视频可保存，后续不能据此生成语音转写。

上传按目标游戏保存，刷新与重启后保留。相同文件按内容哈希去重；若能与已保存联网原片逐字节对应，列表合并显示两种来源。文件名只作显示名称，不能作为内容理解的依据。本地文件没有可验证的抖音发布时间及互动数据时保持未知，不以上传时间补齐或将其评为热门；上传原片的保存与预览可用，正式学习及创作仍受上述质量门禁控制。不要将 `data/`、个人视频、凭据或用户文档目标提交到仓库。

“学习来源”可以选择**联网视频**或**本地视频**，每个游戏分别记住选择；两类素材仍保留在素材区，选择来源不触发查询或解析。当前开发版的按钮为“核对学习素材”，仅检查选定来源已有的可读原片、缺失数和游戏绑定，不创建学习任务。本地核验不需要红狐账号；联网核验要求已有符合当前日期范围的查询，缺少时提示手动查询，不回退到本地素材。正式学习仍待内容与任务接入验收，不能把核对成功当学习完成。

## 1. 准备运行环境

| 组件 | 用途与要求 |
| --- | --- |
| [Node.js](https://nodejs.org/en/download) 24+、[Git](https://git-scm.com/downloads) | 本机服务、SQLite、安装代码 |
| [Python](https://www.python.org/downloads/) 3.11 / 3.12 | 多语言语音转写；独立虚拟环境 |
| [FFmpeg / ffprobe](https://ffmpeg.org/download.html) | 下载后检验音视频、提帧与提取音轨；两个命令都要在 PATH |
| [Ollama](https://ollama.com/download) 0.12.7+ | 本机视觉模型服务；推荐当前稳定版 |
| 自己的红狐账号及 API Key | 付费查询和原片解析 |
| 自己的腾讯文档 MCP 授权及目标在线表格 | 交付时需要；链接本身不是写入授权 |

红狐模式无需预先登录抖音、热点宝，也不要求 Chrome/CDP。只采集列表时不需要先加载视觉和语音模型；原片预处理需要 FFmpeg，分析阶段才需要两个本机模型。Codex、Qwen Code、WorkBuddy 的对话底座不能代替它们。

## 2. 克隆与初始化（macOS）

```sh
git clone https://github.com/zzy170031-cmd/crawl.git
cd crawl
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-media.txt
node scripts/setup.mjs
```

`setup` 只在缺失时创建 `.env`，填入当前仓库的 Python/模型路径并创建本机数据目录；不覆盖已有配置、不安装依赖、不下载模型、不读取旧密钥。迁移目录后自行核对路径。使用 Homebrew 的 macOS 用户可显式执行 `brew install ffmpeg`，或按 FFmpeg 官网选择适配本机架构的发行包。

Windows 用户按 [Windows 安装说明](docs/install-windows.md) 使用 PowerShell 命令。

## 3. 获取并配置自己的红狐 API

1. 在 [红狐官网](https://redfox.hk/) 注册并登录自己的账号。
2. 前往 [密钥管理](https://redfox.hk/dashboard/keys) 创建个人 API Key；先在自己的后台确认可用积分及所需接口权限。价格、充值方式与最终扣费以红狐当前后台为准。
3. 用本机编辑器将密钥填入 `.env` 的 `REDFOX_API_KEY=`，或启动后在创作台连接设置中保存；不要粘贴到公开聊天、GitHub 或示例文件。

新安装默认 `CRAWL_GAME_SOURCE=redfox`、`CRAWL_HOTSPOT_SOURCE=redfox`。网页保存的红狐凭据位于本机 `data/`，优先于 `.env`；已有安装若更换账号，使用原来的配置入口更新，避免混用两处配置。状态“已配置”仅表示本机有凭据；真实可用性须由用户确认的一次查询检验，诊断不会为了验证而收费。

## 4. 显式下载两个模型

| 必需模型（分析阶段） | 标识、下载量与用途 |
| --- | --- |
| [Qwen3-VL 8B Instruct](https://ollama.com/library/qwen3-vl:8b-instruct) | `qwen3-vl:8b-instruct`，Q4_K_M，约 6.1 GB；阅读实际视频抽帧、字幕和场景 |
| [Faster Whisper Small 多语言版](https://huggingface.co/Systran/faster-whisper-small) | `Systran/faster-whisper-small`，权重约 484 MB；CPU / INT8 转写中文与时间戳，不能用 `small.en` 替代 |

以下命令会真实下载模型，仅在尚未安装时执行。Ollama 权重默认保存在其自己的模型目录；Whisper 下载到本仓库 `models/`。运行数据和视频还需要额外磁盘空间，权重大小不是推理内存需求。

```sh
ollama pull qwen3-vl:8b-instruct
.venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='Systran/faster-whisper-small', local_dir='models/faster-whisper-small')"
```

已有兼容 Whisper 目录可直接设置 `CRAWL_WHISPER_MODEL` 为该目录。旧 `qwen3-vl:8b` 可保留作为可选实验模型，新安装不必下载两份；默认分析使用非思考版 Instruct。不要把 OpenAI Whisper `.pt` 文件当作 CTranslate2 模型目录。运行时只读已下载的语音模型，不隐式补下载。

### 模型实验与简化执行路径

不要为运行创作台追加下载此前实验中的 `qwen3.5:9b-q8_0`、`qwen3.5:27b-q4_K_M` 或思考版 `qwen3-vl:8b`。这些实验没有通过对应的内容质量或本机资源验收；本设备已按用户要求移除这三套权重，保留当前配置使用的 Instruct 与多语言 Whisper。历史实验身份和失败记录保留，不能据此声称这些实验模型仍已安装。

候选 `app/host-assistant.mjs` 正在验证复用已有助手图文能力的执行路径，使用宿主现有账号与额度，不是离线推理，也不自动安装助手或模型。该候选尚未接入正式 worker，不应把它当成已经替代本地分析的安装选项；当前也不能承诺所有助手都支持同一执行协议。学习、创作与腾讯交付分别验收，不能通过改模型配置解除门禁。真实测试范围见[10月20日实测记录](docs/game-learning-acceptance-20261020.md)。

## 5. 启动、诊断与腾讯授权

```sh
npm run doctor -- --layer=collection
npm start
```

打开 [本机创作台](http://127.0.0.1:4318/)。端口冲突时在 `.env` 改 `PORT` 后重启；不要双击 `app/public/index.html`，该文件需要本机后端。

启动 Ollama 后可分别检查分析和交付配置：

```sh
npm run doctor -- --layer=analysis
npm run doctor -- --layer=delivery
# 可选：真实调用本机模型读取双色图，不是视频理解验收
npm run doctor -- --layer=analysis --probe
```

在 [腾讯文档授权入口](https://docs.qq.com/scenario/open-claw.html) 使用自己的账号取得 MCP Token，保存到本机 `.env` 的 `TENCENT_DOCS_TOKEN` 或创作台授权设置中。在创作台填写本人有编辑权限的腾讯在线表格链接并确认；链接、授权凭据、文档写权限是三个不同条件。此客户端通过 HTTPS 调用腾讯 MCP，不依赖原开发者的 Codex 连接器，因此其他助手也能使用；**不会自动继承当前助手里已有的腾讯授权**。凭据与具体交付目标不能打包给其他人。

## 6. 日常操作与数据边界

1. 游戏广场选游戏 → 手动开始查询。保留本次查询范围、采集时间和实际发布日期。一般选择 20–30 个候选，不用其他游戏或旧范围填数。
2. 选择实际要读取的原片 → 查看预算 → 明确确认下载。有效已入库资产及可复用解析回执优先复用；失败原因可见，未知或受限资源不会用假视频替换。
3. 学习以当前成功查询批次和已验证媒体为输入；标题和互动数据不能代替真实画面、字幕与转写。语音专名须核对字幕，模型失败要保留，不能硬生成正式结论。
4. 热点广场按行业及 1 / 3 / 7 天手动查询**红狐每日热门作品榜**，与游戏视频均可进入已选题。第三页处理确认后的创作方案；文档写入须在目标与内容确认后进行。

时间是北京时间截至昨天的最近 1 / 3 / 7 个完整自然日（T+1），不是“此刻往前滚动 24 小时”。游戏查询每次最多 3 页、取得 30 个视频可提前停止；结果是 API 返回样本，不是抖音全库或完整官方热榜。热点接口单次响应也不保证覆盖全平台。空结果、部分结果、请求失败分别报告，不将失败包装为“没有内容”。不启用自动付费订阅。

## 7. 安装 Skill、维护与验收

[Codex / Qwen Code / WorkBuddy 安装说明](docs/assistant-installation.md) 包含官方入口和不依赖自动发现的通用后备方式。安装 Skill 不会安装应用依赖、模型或授权。

```sh
npm run task -- list
npm run task -- status TASK_ID
npm test
npm run check
```

`data/`、`.env`、模型、媒体、登录资料、解析回执和用户表格目的地均保留本机并被 Git 忽略。分享仓库代码，不分享自己的运行目录。配置与失败恢复见 [运行说明](docs/runtime.md)，本轮干净安装与发布边界见[开发版本核验](docs/portable-development-20261019.md)。跨系统命令已提供；本轮未完成 Windows、Qwen Code、WorkBuddy 的真实整链验收，不能视为已经通过。
