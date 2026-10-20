# 本人账号、模型与安装

完整代码：[crawl 仓库](https://github.com/zzy170031-cmd/crawl)。首次安装阅读仓库 README 和 docs/assistant-installation.md。仅安装 Skill 不会安装本机服务、依赖或模型。

## 每位使用者自己的账号

1. 到[红狐官网](https://redfox.hk/)注册登录，在[API密钥管理](https://redfox.hk/dashboard/keys)取得自己的 Key、检查后台积分和接口权限。填本机创作台设置或 `.env` 的 `REDFOX_API_KEY`。不复制开发者的密钥，不将密钥提交GitHub。价格与扣费以本人后台为准。
2. 在[腾讯文档 MCP 授权入口](https://docs.qq.com/scenario/open-claw.html)取得本人的 Token，填本机授权设置或 `TENCENT_DOCS_TOKEN`；再填本人有编辑权限的腾讯在线表格链接。链接不是写入授权，已有助手连接器不会自动授权本机服务。
3. 手动点击“开始查询”才执行红狐计费查询，切换条件和刷新本地状态不收费；解析原片另行确认预算，学习不自动补搜。

## 当前入口与可选模型

| 模型 | 下载来源 | 运行要求 |
| --- | --- | --- |
| `qwen3-vl:8b-instruct`（旧实验可选） | [Ollama 官方模型页](https://ollama.com/library/qwen3-vl:8b-instruct) | Q4_K_M，约6.1GB；旧本机视觉实验路径。当前新候选使用既有兼容宿主，不调用该权重，新用户不必下载。 |
| `Systran/faster-whisper-small` | [Hugging Face 模型仓库](https://huggingface.co/Systran/faster-whisper-small) | 多语言 CTranslate2 权重约484MB；CPU/INT8。不要用 `small.en` 或 `.pt` 替代。 |

新候选需要已有兼容 `codex exec` 的宿主 CLI、本人账号与网络，设置 `CRAWL_STUDY_HOST_CLI`；没有兼容执行器时只使用采集，不应反复下载模型试图解除门禁。仅用户选择旧实验路径并明确同意后才执行 `ollama pull qwen3-vl:8b-instruct`。Whisper 使用仓库虚拟环境执行 `snapshot_download(repo_id='Systran/faster-whisper-small', local_dir='models/faster-whisper-small')`；完整可复制命令见 README。旧 `qwen3-vl:8b` 可选保留，不要求新用户下载两份。权重大小不等于运行内存，还需视频/帧/音轨磁盘空间。运行时不隐式下载模型。

本机需要 Node.js 24+、Python 3.11/3.12、FFmpeg/ffprobe、requirements-media.txt 中的依赖。先 `npm ci`、创建Python虚拟环境并安装依赖，再 `npm run setup`、填写本人配置、`npm start`。setup不覆盖已有.env。红狐列表查询不需要模型或Chrome登录；新入口的语音素材需要多语言 Small，视觉与文本归纳走既有兼容宿主。Ollama 只属可选旧实验配置。

## 不同助手

- Codex：按[官方技能说明](https://learn.chatgpt.com/docs/build-skills)安装完整Skill文件夹；可使用内置skill-installer指定本仓库及skills/douyin-hotspot-game-creation路径。
- Qwen Code：按[官方说明](https://qwenlm.github.io/qwen-code-docs/zh/users/features/skills/)放入项目 `.qwen/skills/`，用 `/skills` 检查。
- WorkBuddy：按[官方技能界面说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)使用“添加技能→上传技能”，只打包Skill目录，不包含.env/data/models。
- 通用后备：让具备本机文件与终端权限的助手读取此Skill并在crawl仓库运行CLI。设置 `CRAWL_HOME` 为该机器仓库绝对路径；不要依赖开发者路径。云端助手的localhost无法直接访问用户电脑。

这些是 Skill 安装入口，不代表它们具有相同后台执行协议；当前自动候选路径只验证了兼容的 Codex CLI，本轮未完成 Qwen Code、WorkBuddy 或 Windows 的整链实测。`doctor`仅证明其实际检查范围；完整交付仍需原片学习、选题拆解与腾讯回读验收。
