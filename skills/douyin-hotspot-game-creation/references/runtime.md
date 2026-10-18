# 共享执行接口

仓库根目录运行 `npm start`，网页默认 http://127.0.0.1:4318。先运行 `npm run doctor -- --probe`；诊断只证明其检查范围。

助手调用 `node scripts/task.mjs learn "率土之滨"` 创建游戏学习；`list` 查看任务；`status ID` 查看结果；`retry ID` 在条件已补齐后恢复；`cancel ID` 取消。

JSON文件仅存本机数据目录，用于以下命令：

- `search FILE`：`{"keyword":"","board":1001,"hours":24,"category":"all"}`。
- `subscribe FILE`：同上，增加 `enabled:true`。订阅按榜单/行业/窗口，不按关键词。
- `settings FILE`：`{"destination":{"file_id":"用户指定ID","url":"用户指定腾讯表格URL"}}`。
- `select FILE`：`{"game":"率土之滨","kind":"video","source_id":"搜索返回的具体ID","mode":"B","format":"video"}`；新版本可加 `new_version:true`。

搜索结果先保存入本机快照，选题只接受服务端已知来源。不能提交客户端伪造的策划正文绕过媒体阅读。任务绑定游戏资料版本和目标，重试不得偷偷改目标；新版本显式新建。

执行器依次处理学习/创作任务；浏览器与模型串行。状态 queued/running/needs_input/failed/cancelled/completed/completed_with_warnings 均有明确含义。needs_input不是完成；有样式警告不冒称全项验证成功。进度与错误保留在本机SQLite。
