# 共享执行接口

当前开发版因真实初学质量未通过而保留服务端实验门禁。下述 learn/select 接口暂不能启动新学习或创作；它们返回明确阻断原因。list/status 与采集入口仍可使用，retry/刷新不能解除门禁。不得改用其他工具直接写腾讯来绕过门禁。

本文件用于本机共享执行器。红狐配置下只有用户明确确认的游戏/热点查询可收费；原片获取另有报价与预算确认。learn绑定当前成功查询快照，直接读取已入库原片，生成机器初学资料，不调用付费搜索、不等待聊天回填、不写腾讯。select不追加红狐相关作品搜索；深入音画核对与腾讯交付依然是独立门禁，不能把初学ready当作最终交付通过。参见[game-research.md](game-research.md)。

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
