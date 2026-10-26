# Changelog

## 0.1.0

First release. / 首个版本。

**English summary**

- Reviews **staged changes only** (`git diff --cached`); unstaged and committed work is excluded
- File snippets are read from the staged blob (`git show :file`), so line numbers match the diff exactly
- Five-level tone slider (encouraging → merciless) that changes wording only, never severity or score
- Findings are graded P0–P3; out-of-range scores are clamped to the range implied by the top severity
- Tunable `roastBuddy.temperature` (0–1) and `roastBuddy.maxFindings` (1–10), also exposed as sliders in the panel
- Model channels: Language Model API first, CodeBuddy built-in background model second; when neither is reachable the panel tells you to sign in instead of writing files
- Off-schema output is copied to the clipboard so you can fix the JSON and re-import it
- Live progress: elapsed time, current stage (git / probe / real request) and request count
- Simple changes return no findings instead of padded ones; the layout shrinks accordingly

**中文详情**

- **只评审 git 暂存区**（`git diff --cached`）：add 了什么就审什么，未 add 与已提交的内容都不参与
- 文件片段读取暂存版本（`git show :file`），与 diff 行号完全对齐
- 新增命令「预览将要发送给模型的全文」，可核对实际发出的内容
- 用固定 prompt 让模型先还原需求，再对照实现挑问题，输出固定 JSON
- 面板按固定版式渲染：需求还原 → 总评 → 问题（P0–P3）→ 做得对的 → 先做哪一件
- 支持点击文件行号跳转
- 模型通道：Language Model API 优先，CodeBuddy 内置后台模型次之
- 两条通道都不可用时：面板直接提示去登录 Copilot / CodeBuddy，不落文件、不绕外部模型
- 模型输出不合规时把原始内容放进剪贴板，修好后可用命令 `锐评：从剪贴板导入评审结果` 重新排版
- 等待时显示吃豆人吃豆动画（张嘴 + 呼吸缩放），并循环滚动「还原需求 / 对照实现 / 查分支遗漏 / 算分」等进度文案
- 上次探针成功的 agent 存入 globalState，扩展重载后不必重跑整轮探针
- 去掉视图标题栏里与面板「AI 锐评」重复的按钮（命令与 Ctrl+Alt+R 快捷键保留）
- 已有缓存时跳过探针直接发正式请求：稳态下每次评审只发 1 次模型请求（原来固定 2 次）
- 修复文件片段窗口截断导致的误报：片段现在必须覆盖到最后一个改动行之后，避免把紧跟 subscribe 的 unsubscribe / onDestroy 切在窗口外
- 评审期间实时显示已等时长、当前真实阶段（git 命令 / 探针 / 正式请求）与累计模型请求次数，结束后汇总总耗时
- 语气五档（夸夸型 / 温和顾问 / 耿直同事 / 毒舌但有用 / 赛博阎王），面板用滑杆选择，只影响措辞，不影响分级与分数
- 语气档位旁显示对应表情（😊 🙂 😐 😠 🤬），切换时轻微弹跳
- 新增「六 · 顺嘴一提」：模型用一句口语化的题外话收尾，五档的差异在这里最明显；每档都配了「改动没问题时」的语气示范
- 简单改动不再硬凑问题：findings 允许为空，risk / nextStep 允许留空，力气转到「顺嘴一提」上
- 无问题时版式精简为「理解 / 总评 / 顺嘴一提」三节，不再渲染空的问题栏与「先做这一件」
- 「推断可能出错的地方」改为可选：置信度为高或无问题时不再显示，不再当免责声明硬写
- 新增可调参数：`roastBuddy.temperature`（0–1，默认 0.3）与 `roastBuddy.maxFindings`（1–10，默认 6），非法值自动夹回区间
- 面板右上角新增齿轮按钮，展开后可用滑杆直接调温度和问题条数上限，不必去设置页
- 分数按最高问题级别校验，越界会被拉回对应区间
