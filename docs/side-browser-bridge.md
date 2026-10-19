# 右侧浏览器与本地创作台协作

`CRAWL_BROWSER_MODE=side-browser` 选择右侧助手协作模式。创作台保存任务并展示状态；当前 Codex 助手通过其受支持的浏览器工具读取已登录页面，再用本地 CLI 回填已观察事实。后台不连接右侧浏览器的 CDP、不导出 Cookie、不运行助手提交的代码。助手不在线时，请求会等待或超时，不能称为无人值守实时采集。

## 页面接口

- `GET /api/bridge/status`：模式、`assistant_required`、pending/recent 请求及真实状态。
- `POST /api/game-search {game,hours?,sort?}`：默认近7天/点赞意图；返回202和request_id。意图不证明抖音实际支持或应用了筛选，助手须在scope、sort_basis说明实际页面。
- `POST /api/course-search {keyword?}`：独立课程来源集合，默认“抖音创作公开课”。
- `GET /api/hotspots?game=率土之滨`：精确游戏范围。`collection=courses`查询独立课程。来源顺序按实际页面观察顺序，不能当全站排名。
- `POST /api/game-research {game,force?}`：排队学习，一次独立学习搜索建立目标30条候选池，至少20条独立相关作品须完成实际音画读取和术语复核才可ready。学习范围可近半年，与近期热点展示分开，不因放宽时间把旧视频称为当前热点。
- `POST /api/creative-jobs {game,source_id,kind,mode,format}`：生成草稿；源作品必须属于当前游戏。A/B语义不变，相关热点证据另按所选标题查询。
- `POST /api/bridge/ID/approve {destination:{file_id,url}}`：仅将已展示草稿批准给具体腾讯表格目标。浏览器没有 fulfill 接口或凭证。

搜索结果和空结果都保存为独立范围快照。新空快照使该范围显示为空；旧证据仍保留。游戏切换不得展示其他游戏素材。返回字段中的 `like_display` 保留可见缩写、`metric_precision=rounded`标明近似，缺失数据保持null。

## 本地助手 CLI

从仓库目录执行，沿用 `.env` 的相同数据目录：

```
node --env-file-if-exists=.env scripts/bridge.mjs pending
node --env-file-if-exists=.env scripts/bridge.mjs get REQUEST_ID
node --env-file-if-exists=.env scripts/bridge.mjs fulfill REQUEST_ID result.json
```

每次回填必须是 `{request_id,task_id,result}`；无关联任务时task_id为null。请求ID、任务ID、状态、到期时间不符会拒绝。来源登录或读取失败用 `{request_id,task_id,error:{code,message}}`，code仅允许LOGIN_REQUIRED、SOURCE_UNAVAILABLE、MEDIA_UNAVAILABLE、SOURCE_FAILED。不得把失败包装成空成功。

### 各类 result

- **search**：`{records,failures,scope,searched_at,sort_basis?}`。具体视频记录含kind=video、source_id、title、author、source_url、observed_url、collected_at及实际可见指标；未知指标为null。视频URL必须匹配ID，游戏/课程/相关作品的observed_url必须是对应关键词的真实抖音搜索URL。日期不能来自未来。游戏搜索自动去除榜单rank/score。
- **web**：`{sources:[{url,title,text,read_at}]}`。text为实际读取正文；URL标签并不使其中游戏事实自动成为已验证事实。
- **media**：`{source_id,url,title,source_path,observed_at}`。仅接受真实文件`data/media/ID/source.mp4`，拒绝路径逃逸/符号链接。文件应通过助手受支持的下载能力保存，后台只在本地用ffprobe/ffmpeg抽帧与完整抽取音轨，无音轨则停止。
  明确无法取得原片时可回填`{status:"unavailable",source_id,url,reason,observed_at}`，只允许这五个字段，须记录实际观察原因，不能附加已读证据。学习跳过该候选并在`unavailable_sources`及`progress.unavailable_count`保留缺口；不算已读或有效样本，仍需至少20个独立内容通过音画与术语核验。创作遇此结果停止，不能交付。已下载原片经ffprobe确认超过900秒也记录实际时长并使用同一缺口；其它提取/模型异常维持失败。重试可新建媒体请求重新观察，原不可读回执保留。
- **transcript-review**：`{source_id,media_hash,status,corrections,uncertainties}`。先独立OCR（不给模型ASR/标题），再由助手查看对应画面和原始转写。status为reviewed_no_changes、reviewed_with_corrections或needs_review。corrections每项`{segment_index,original_text,corrected_text,frame_time,subtitle_text,reason}`；original_text是整段原始文本；画面时间须在语音段±3秒，字幕为同时间OCR中的字面片段，修正文本必须包含它。原始ASR始终保留。uncertainties非空必须needs_review，阻止资料库变为ready。没有修改也必须经过实际复核才能回填reviewed_no_changes。

音画证据保存在`data/media/ID/`。`ocr.json`、`transcript.json`、`term-review.json`分开保存；返回证据也含原始/复核转写和OCR时间点。画面仍是抽样，不代表全片连续动作、音乐或音效已核验。原有媒体blocking_gaps继续生效。

### 外部交付

草稿状态先为awaiting_approval。用户批准目标后为approved。助手必须在任何腾讯写入之前执行：

```
node --env-file-if-exists=.env scripts/bridge.mjs begin-delivery REQUEST_ID
```

它将状态变为writing，并拒绝第二次开始。通过原生腾讯MCP写入独立子表并回读核验；完成result为`{status:'completed',file_id,sheet_id,document_url,readback_verified:true,verified_at,warnings:[]}`。文档必须匹配批准目标。写入结果不明确时回填`{status:'unknown',message}`，禁止自动重新发布。writing期间取消/超时也进入unknown。同任务重试不能绕开既有unknown写入记录。成功回读对账后的任务重试直接恢复原稿、证据和回执，不再次调用模型改写已交付正文。页面只能批准，无法生成成功回执。unknown只有在助手通过腾讯MCP实际回读确认成功后，才可用`bridge.mjs reconcile-delivery ID receipt.json`登记成功回执；该命令只保存回读证据，不发送任何写入请求。对账后可重试原任务复用回执。

## 验证边界

受控测试覆盖持久队列、幂等、错误ID、取消、超时、路径逃逸、跨游戏/空结果、日期、字幕时间与原文匹配、交付批准和未知结果。它们不证明本机登录、实际模型理解或腾讯写入成功；真实验收须另留来源URL、实际媒体、模型记录与回读证据。

## 补样与复核恢复

学习中断或needs_input后重试会重新请求候选池，优先采用本次新搜索作品；已有合格音画证据可复用，存在needs_review或blocking_gaps的证据必须重新读取并产生新的字幕复核修订。新的复核依据进入模型输入与缓存键，旧缺口不能被静默清空。空网页结果不能永久缓存。近期games、learning、courses、hotspots分别保存，不按相同关键词合并。选择当前游戏的素材或明确的通用热点均可创作；其他游戏素材与课程不可以冒充已选热点。

## 同内容多来源

同内容判断须有实际证据或用户明确确认，不能按标题相似自动合并。当前可用本地命令记录用户确认：

```
node --env-file-if-exists=.env scripts/content-groups.mjs set --reason "用户确认这些链接是同一内容" VIDEO_ID_1 VIDEO_ID_2
node --env-file-if-exists=.env scripts/content-groups.mjs list
```

规则及确认事件保存在本地SQLite独立表，basis为user_confirmed；业务代码无游戏名或具体视频ID规则，原快照和源链接不删除。API在完成游戏/集合过滤之后按内容组返回代表记录，新增content_group_id、content_group_basis、source_count和grouped_sources。grouped_sources只含本次查询范围中的原始记录，另一游戏的来源不会混入。

学习门槛按独立内容组计数。同内容两个链接不能充作两个有效样本，候选避免重复读取。旧资料保存不改写，但查询和创作门槛按当前分组重新核算；归组后不足20个有效内容时须补学。game-profile返回independent_content_count；任务progress另保留read_source_count与按独立内容计算的read_count/verified_count。

## 来源预览图

`GET /api/media/<视频数字ID>/thumbnail`只提供固定托管文件`thumbnail.jpg`，没有文件即404；ID、realpath和文件类型/体积检查阻止任意文件与symlink逸出。接口不提供source.mp4，也不要求先下载整段视频。真实来源封面可由助手使用受支持浏览器下载能力保存；`thumbnail.json`可记录`{kind:'source_cover',source_url,observed_at}`，它只是来源预览，不能当原片实读证据。

实际原片准备流程会在`min(2秒,时长/2)`抽取真实帧，保存`kind:'video_frame'`及frame_time等来源信息。抽图失败记录thumbnail.json缺口且不制造替代图，媒体分析可继续。API的代表记录与grouped_sources各自提供thumbnail_url和可选thumbnail_provenance，前端没有预览图时应自然省略图像区域。

## 页面候选与滚动学习

游戏搜索请求默认近7天，目标30、最低期望20（`limit:30,target:30,minimum_required:20`）。实际不足必须如实返回，不能补造“优秀视频”。可通过`POST /api/game-search {game,hours:4320}`明确扩大到近半年，并在真实回填的scope说明实际时间筛选；扩大范围不会自动把旧作品变成当下热点。相关性和可见来源表现仍需实际筛选，数量目标不是质量证明。

所有执行模式的正式学习门槛统一为20个独立相关内容，候选目标30。更新资料会优先处理新候选，重复内容组不重复计数。跨任务复用只接受已完成字幕术语复核且无blocking_gaps的证据，并验证当前原片/抽帧/音轨/转写/复核产物的内容指纹及模型身份。任何文件或模型身份变化都会重新处理；封面不参与该证据指纹。该验证覆盖本地保存文件，不证明远端作品自上次下载以来未发生变化；复用记录明确保留这一范围。复用保留原read_at、来源任务和当前来源观察，progress提供reused_count与newly_read_count，不把缓存复用说成重新观看。无完整文件指纹或仍待核验的证据不能跨任务复用。

滚动学习仍由用户更新资料或当前助手执行任务触发；来源采集和字幕复核需要助手在线，不代表后台可无人值守控制右侧浏览器。质量、机制准确性与腾讯交付仍需真实端到端验收。

## 热点范围核验

热点页更改榜单、时间或行业时清除原范围显示，读取对应本地快照并自动提交精确范围同步请求；切换本地排序只重排缓存。请求是否等待按榜单、时间、行业逐项匹配，不能使用另一个范围的等待状态。输入框只筛选本地记录，不暗中改变热点宝采集关键词。

所有新的 `purpose: hotspots` 搜索回填（含空结果）必须带 `observed_scope: {boards: [1001], hours: 72, category: "628"}`，描述**在热点宝页面实际确认的**榜单列表、时间及行业。与请求不匹配即拒绝，不能把24小时数据重新标记为72小时。全部榜单请求允许如实回填其中已观察的榜单，并在scope说明未读取范围；每条记录的sub_type须属于observed_scope.boards，多榜时不可省略。行业标签从已确认范围规范化，不把未分类数据冒充指定行业结果。原有历史快照不重写。
