# 选题后的创作与审阅交付

新入口与旧模型 worker 分开。实际开放状态以 `/api/quality-policy` 的 `creative_candidate` 和 `reviewed_candidate_delivery` 为准；安装文件、设置环境变量或旧档案标为 ready 都不能解除门禁。

## 工作顺序

1. 游戏广场选择来源，完成显式联网查询或本地上传后的轻量学习，保存固定 study task/profile version。它是后续创作的背景，不自动变成游戏规则真值。
2. 从游戏广场或热点广场确认一个真实视频。A 为游戏作品表达改编，B 为热点与游戏的原创联动；联网来源保留原查询ID和原片SHA256；本地A仅按已保存的本地身份读取，不伪造查询ID或公网链接。B使用已保存热点，可结合本地来源的固定游戏档案。不使用浏览器提交的素材行或文件路径。
3. 点击生成后，准备选中原片的九张离散画面和已有本地 Small 全轨机器转写，并附少量实际游戏参考画面。游戏初学仍使用轻量代表材料；不会对学习池逐帧拆解。
4. 既有兼容宿主助手进行一次归纳，输出原片拆解、游戏对照、两至三个方向、完整文案、分镜、声音设计、素材及制作档位。资料不足只阻断真正依赖缺失信息的方案；不可用无关未知永久阻断表达借鉴，也不可凭免责声明填补关键剧情。
5. 草稿保留 `needs_review / accepted=false / ready=false`。审阅完整内容和腾讯目标后，单独确认交付。腾讯写出固定草稿，不重新推理。先只读核对子表与字段，展示分表计划，再精确确认；按标准四表分配，不再把任务全部塞入一个新候选子表。

九张离散帧不是连续观看；自动转写不是逐句字幕核验或音乐理解。字幕与转写不同须并列说明。作者攻略的数值、收益及版本效果不能自动晋升为已证实规则；虚构玩家情节、片外任务卡和独立界面示例需明确标识。

不同方案应有不同玩家目标、冲突、行动与结尾回收。不得把内部 ASR 纠错、证据审计或资料核验流程充作主要创作主题；素材可以待拍，正文核心剧情不能留白。

## 依赖

使用与联网认知相同的兼容宿主 CLI、账号及网络，以及本机既有 multilingual Faster Whisper Small（CPU/INT8）、ffmpeg/ffprobe；本入口不下载新模型。宿主执行不是离线模式，可能使用现有账号额度。一次 exec 不等于一次底层 API 请求，实际模型身份、底层请求和重试未必由宿主报告。

当前适配的是已测试的 `codex exec` 协议；不能把 Qwen、WorkBuddy 等工具能阅读 Skill 等同于已兼容无人值守执行。它们的安装与能力边界见 Skill 安装说明。红狐只负责来源；设置红狐 API 不会替代分析执行器。腾讯授权和表格链接在交付前分别验证。

## 接口

- `POST /api/creative-candidates`：`{game,study_task_id,profile_version,source:{provider:"redfox",request_id,source_id},mode:"A"|"B",format:"video"|"image"}`。
- 本地A的相同POST将 `source` 改为 `{provider:"local_upload",source_id:"local_内容哈希"}`；ID须来自该游戏的真实上传记录，不传request_id。B不接受本地视频冒充热点。
- `GET /api/creative-candidates`、`GET /api/creative-candidates/:id`：只读固定任务，`task_store:"creative-candidate"`。
- `POST /api/creative-candidates/:id/cancel`：空对象，停止本任务，不自动重试。
- `GET /api/template-deliveries`、`GET /api/template-deliveries/:id`：只读布局计划与交付记录。
- `POST /api/template-deliveries/prepare`：`{task_id,result_version,draft_sha256,target:{file_id,url}}`。只读核对候选、目标、真实子表和表头，冻结完整布局与写前基线，不写入。
- `POST /api/template-deliveries/:id/approve`：`{plan_sha256,target:{file_id,url}}`。只接受本机保存的精确计划，重新核对当前目标与所有写前条件后执行。不能提交 rows、sheet ID、路径或客户端审核回执。
- `POST /api/template-deliveries/:id/cancel`：停止后续请求；已发出的远端操作可能已生效，不能把取消当回滚。
- `POST /api/template-deliveries/:id/reconcile`：只读腾讯现有内容和必要的有界导出，不能修补、覆盖或重复写入。部分成功保留逐表状态，不自动续写。

旧 `/api/candidate-deliveries` 及其专用子表记录保留历史，写门禁关闭，不用于新的正式布局。旧版部分续写证明不能移植到四表交付。
所有变更检查本机 Host、Origin 和会话令牌。不提供任意 MCP 代理、原始命令、客户端审核回执或文件路径入口。刷新、GET、服务重启都不触发推理、收费搜索或腾讯写入；相同固定输入复用原任务，不重跑失败结果。

## 腾讯完成证明

审批绑定精确候选版本、完整 draft hash、来源及目标；交付状态独立保存，不修改上游认知或原始模型结果。按 [四子表布局](creative-template-layout.md) 写入：A/B 正文分开，总览做索引，来源表使用可读文件名、公开链接和简短读取说明；本地视频的链接留空，不生成伪链接。task/result/draft编号、哈希与原始读取JSON仅留本机，不进入用户表格。新展示规则不改写历史已冻结交付计划。已有兼容子表只在预先核对的空白区域追加；缺表列入审批计划。正文按 STRING 写，读回全部字段和换行，再分别验证实际链接目标及导出属性。样式状态独立记录，不能用样式成功代替正文或链接核验。

网络错误、丢响应、租约丢失或正文不一致会保留 `unknown`，不自动重发。历史成功回执表示首次核验结果，不保证用户之后没有编辑。只读对账失败时应展示最新检查结果，并保留历史交付记录。

腾讯明确标为 STRING 或 RICH_STRING 的单元格可附默认数字、布尔和空公式字段，按明确类型读取文本；真实公式、数值或布尔格不能冒充字符串。写后只遇空/缺失旧值时最多追加三次只读核查，不再写一遍；明确非空错值立即停止。本机租约无法锁住远端同时编辑者，读回证明只覆盖实际读取的快照。

运行数据分存在 `data/creative-candidate-tasks/`、`data/creative-media/` 、`data/template-deliveries/` 和历史 `data/candidate-deliveries/`；不提交媒体、凭据、宿主审计、数据库或个人腾讯目标。源码回归不替代真实内容检查、实际腾讯全文及链接回读。

恢复出现问题时，可关闭新创作候选与模板交付两个服务端能力再重启，保留原任务、固定稿与交付回执；不要删除数据库或把远端子表清空当作回滚。已发出的腾讯变更不能由本机取消自动撤销。
