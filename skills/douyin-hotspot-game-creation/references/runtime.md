# 共享执行接口

旧 learn/select 接口仍受实验质量门禁控制，不能据此启动旧模型学习或创作。新的独立联网候选入口见末节；list/status与采集可用，刷新不会解除其他门禁。不得改用其他工具直接写腾讯来绕过门禁。

本文件用于本机共享执行器。红狐配置下只有用户明确确认的游戏/热点查询可收费；原片获取另有报价与预算确认。learn绑定当前成功查询快照，直接读取已入库原片，生成机器初学资料，不调用付费搜索、不等待聊天回填、不写腾讯。select不追加红狐相关作品搜索；深入音画核对与腾讯交付依然是独立门禁，不能把初学ready当作最终交付通过。参见[game-research.md](game-research.md)。

游戏广场另有本地视频入口，与联网查询并存：浏览器按用户选择向本机 `POST /api/local-videos?game=...&filename=...` 发送原始二进制文件，带本机会话头；`GET /api/local-videos?game=...` 回读该游戏保存的上传记录。不要向接口提交任意服务器文件路径，也不要伪造 `local_` 内容哈希ID。预览由同源授权播放器读取，接口不返回磁盘路径。单个文件上限1GB，支持现代MP4/MOV/M4V和WebM容器，允许无音轨。保存不启动学习、付费查询或腾讯交付；本地来源尚未接入正式学习执行器，不能声称上传后自动可学。用户原片和索引保存在忽略的 `data/local-videos/`，不上传到仓库。

以下旧浏览器 search/subscribe JSON 不适用于红狐付费查询；红狐使用网页预算确认入口，不伪造paid授权字段。旧浏览器模式接口如下：右侧浏览器助手模式使用 [side-browser.md](side-browser.md)，不调用依赖独立 Chrome 的 search/learn/select 后台任务冒充右侧执行；两种模式的任务状态与登录状态分别记录。

仓库根目录运行 `npm start`，网页默认 http://127.0.0.1:4318。先运行 `npm run doctor -- --layer=collection`，需要分析时再检查 `--layer=analysis`；诊断只证明其检查范围。

助手调用 `npm run task -- learn "率土之滨"` 创建游戏学习；`list` 查看任务；`status ID` 查看结果；`retry ID` 在条件已补齐后恢复；`cancel ID` 取消。

JSON文件仅存本机数据目录，用于以下命令：

- `search FILE`：`{"keyword":"","board":1001,"hours":24,"category":"all"}`。
- `subscribe FILE`：同上，增加 `enabled:true`。订阅按榜单/行业/窗口，不按关键词。
- `settings FILE`：`{"destination":{"file_id":"用户指定ID","url":"用户指定腾讯表格URL"}}`。
- `select FILE`：`{"game":"率土之滨","kind":"video","source_id":"搜索返回的具体ID","mode":"B","format":"video"}`；新版本可加 `new_version:true`。

搜索结果先保存入本机快照，选题只接受服务端已知来源。不能提交客户端伪造的策划正文绕过媒体阅读。任务绑定游戏资料版本和目标，重试不得偷偷改目标；新版本显式新建。

执行器依次处理学习/创作任务；浏览器与模型串行。状态 queued/running/needs_input/failed/cancelled/completed/completed_with_warnings 均有明确含义。needs_input不是完成；有样式警告不冒称全项验证成功。进度与错误保留在本机SQLite。

## 选择学习来源与输入核验（开发版）

游戏广场的“学习来源”按目标游戏分别记住 `network`（联网视频）或 `local`（本地视频）。切换选项只读对应已保存档案，不触发收费查询、原片解析、模型或删除另一类素材；核对时捕获当时的游戏与选择，不因随后切换而换用输入。

`POST /api/game-study-input` 使用本机会话 `x-crawl-token`，正文仅允许 `{"game":"目标游戏","learning_source":"network或local"}`。服务端只用可信存储读取对应分支：network绑定已保存当前查询和原片；local只读取当前游戏上传库，不要求红狐配置。客户端不能提供records或磁盘path。公开结果含来源、records/binding/coverage及 `action=input_check_only`、`task_created=false`、`learning_started=false`，不含内部媒体路径。

本地来源或未配置联网执行器时，按钮为“核对学习素材”，不调用模型、收费搜索、原片解析或腾讯，不创建学习任务。联网没有有效批次不能自动用本地补齐。本地少量原片可核对为partial，未知发布时间和互动保持null。旧 `/api/game-research` 不支持本地来源，不能绕过质量门禁或忽略来源后退回网络。本地学习启动仍待用户素材验收；联网入口见下一节。

## 独立联网认知候选入口

能力接口 `GET /api/quality-policy` 中的 `capabilities.study.enabled/configured` 均为true时，网络来源按钮启动 `POST /api/game-study-tasks`，只提交 `{game,learning_source:"network"}`。仅使用当前成功查询和已有原片，不自动补采；按元数据差异选最多8条代表，准备少量实际画面和完整自动ASR，一次归纳后保存候选。`GET /api/game-study-profile?game=...&learning_source=network` 按来源读取，`GET /api/game-study-tasks/:id` 读取进度，`POST /api/game-study-tasks/:id/cancel` 显式停止。未启动遗留任务须显式继续，GET、轮询和重启不自动推理或收费。

配置 `CRAWL_STUDY_HOST_CLI` 为已安装且兼容Codex exec协议的绝对可执行路径；使用宿主现有账号和网络，不是离线，不自动安装任何助手或模型。其他助手不能假定兼容此执行协议。本地语音仍用已有Small CPU/INT8。详细合同见仓库 `docs/network-study-runtime.md`。候选档案保留待复核、缺项与实际阅读范围，不能将其提升为正式ready或据此放行创作/腾讯。率土联网与待用户提供的星际猎人本地素材分开验收。
