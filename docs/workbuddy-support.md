# WorkBuddy 适配与验收记录

状态：2026-10-21 文件协作适配已完成受控测试，WorkBuddy 客户端整链尚未验收。

## 目标与边界

让用户在 WorkBuddy 导入本仓库 Skill 后，使用本机完整仓库、自己的红狐 Key、腾讯 MCP Token 和表格，通过既有三页创作台完成采集、学习、创作候选及审阅后交付。不要求安装 Codex，也不追加视觉/文本模型。语音仍需要本地多语言 Small。

选用显式的 WorkBuddy 会话协作模式：创作台预处理媒体并发布有期限的本机分析请求；WorkBuddy 读取限定请求和实际帧，回交符合 schema 的 JSON。后台核对输入、文件哈希及输出结构后继续原任务。请求和回应留在被 Git 忽略的 data 目录，不发送到额外服务；WorkBuddy 自身模型使用用户账号、网络与额度。

不把 WorkBuddy 桌面版当作 CodeBuddy CLI，不偷偷安装另一款助手，不绕过助手权限，不以合成回执假称工具零调用或语义验收。用户需要让 WorkBuddy 会话继续执行领取/回交；关闭会话后不是无人值守模式。

## 完成判据

- 提供只含 Skill 及配套资源的可复现上传包，不带 .env/data/媒体/模型/凭据。
- WorkBuddy 模式不要求 Codex 可执行文件；既有 Codex 配置不改变。
- 原学习、创作的来源哈希、版本绑定、取消、超时、质量审阅与交付确认继续有效。
- 受控测试覆盖领取、回交、错误 JSON/schema、重复/过期/取消、来源变化及旧模式回归。
- 实际 WorkBuddy 客户端导入、真实画面能力和腾讯交付另行实测；没有实测前明确列为未验收。

## 官方依据

- https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market （2026-10-20核对）：自定义 Skill 从“添加技能→上传技能”导入，对话安装仅限市场技能。

## 回退

代码可回退到 f470f20；不删除 data 或覆盖已有 .env。默认 codex 模式保持不变，WorkBuddy 仅通过显式配置启用。

## 本轮观测结果（2026-10-21）

- 全量Node受控回归：1012项，989通过、0失败、23既有旧路径显式跳过；未把跳过算作通过。静态JS与Skill引用检查、Skill校验及2项合成XLSX检查通过。
- WorkBuddy专用受控桥接8项、跨任务集成6项；真实执行了本地请求/回交文件、学习TaskRunner保存与证据回读、A/B TaskRunner保存五列候选、取消/过期/重复、来源变化和provider配置检查。响应内容为受控合成数据，不是WorkBuddy模型输出。
- 两项来源安全复现（换附件后自重算哈希、额外路径覆盖）先复现再修复，并有回归负例；独立A2/A3检查收口。WorkBuddy回执明确工具调用未观测，不伪造Codex工具零调用、模型身份或语义验收。
- 新 `--layer=host` 只查宿主配置、FFmpeg和Small，不要求Ollama或下载Qwen；旧analysis诊断仅供旧实验。新setup选择WorkBuddy，已存在.env保持原字节。
- 临时干净目录复制待同步源码，不带.env/data/models/.venv/node_modules；`npm ci --ignore-scripts`、WorkBuddy初始化、重复初始化保留配置、任务列表均成功。缺Key诊断正确失败，不借用原开发者凭据。独立端口启动页面HTTP200，学习及创作WorkBuddy配置可识别，没有配置或调用Codex，没有模型推理、红狐调用或腾讯写入。临时目录及进程已清理。
- Skill ZIP只含11个技能资源，解压后与源码逐字节一致，可复现打包两项测试通过；完整应用代码、模型、凭据不包含在技能包中。

判定：源码与安装包可作**开发预览**同步；干净安装/后端启动、协议集成条件通过。尚未在WorkBuddy桌面客户端真正上传导入、登录后看图或完成真实学习/创作/腾讯交付，不可宣传“任意用户安装Skill后整链已保证可用”。本轮未改变运行中的用户UI、当前模型配置、已有任务或腾讯数据。后续应在真实WorkBuddy设备按安装说明完成首次实测，再更新此判定。
