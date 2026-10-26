# Roast Buddy · 锐评

[English](#english) · [中文](#中文)

---

## English

**AI code review that reconstructs your intent first, then checks whether the code actually delivers it.**

Not a lint summary, not a "consider refactoring" generator. Every finding has to point at a concrete location and give a concrete fix.

### Why it is different

Most AI reviews produce statements that are always true and never actionable. This extension pins the flow down to four steps:

1. **Intent recovery** — infer what the change was trying to do from commit messages, the diff and file names, and show you the evidence.
2. **Compare with the implementation** — find the branches, parameters and data flow that matter, and confirm they actually take effect.
3. **Hunt for gaps** — missing branches, inconsistent definitions, unhandled edges, timing dependencies.
4. **Judge the code itself** — only what this change introduced.

The output is forced into a fixed JSON schema and rendered in a fixed layout, so every review looks the same instead of drifting with the model's mood.

### Requirements

- VS Code **1.90+**
- A model source that actually works (any one of):
  - **GitHub Copilot** — VS Code ships Copilot Chat, but shipped does not mean usable: you still need to sign in inside the Chat panel with an account that has Copilot access (the Free plan includes a monthly quota). The extension picks the model up through the [Language Model API](https://code.visualstudio.com/api/extension-guides/language-model) — no extra configuration.
  - **CodeBuddy IDE** — when signed in, its built-in background model channel is used automatically.
  - Any extension that registers a `LanguageModelChatProvider`.

> How to tell: after clicking **AI Roast**, the panel shows the live stage. `Request #1 → <model>` means the model is working; "no model available" means you are not signed in or out of quota.

### Usage

1. `git add` the files you want reviewed — **only the staging area is reviewed**.
2. Click the Roast icon in the activity bar.
3. Click **AI Roast** (or press `Ctrl+Alt+R`).
4. Results come in fixed sections: intent / verdict / findings / what went right / next step.
5. Click any `file:line` to jump there.

> UI strings and command titles are currently **Chinese only**; the tables below quote the literal titles you will see.

### Commands

| Command | What it does |
|---|---|
| `锐评：AI 评审当前改动` | Main entry point (same as the panel button) |
| `锐评：从剪贴板导入评审结果` | If the model drifted off-schema, fix the JSON and import it from the clipboard |
| `锐评：预览将要发送给模型的全文` | Opens the exact prompt (diff + snippets + commit subjects) for privacy checks |

### Tone

A five-level slider, from encouraging to merciless. Tone changes wording only — never severity or score.

| Level | Face | Value | Style |
|---|---|---|---|
| 1 | 😊 | `praise` | Encouraging: compliment something specific first, then raise the issue gently |
| 2 | 🙂 | `advisor` | Trusted advisor: like a calm colleague over coffee, issue-focused, never personal |
| 3 | 😐 | `blunt` | Straight talker (default): no sugar coating, no sarcasm, clear consequences and fixes |
| 4 | 😠 | `roast` | Sharp but useful: roasts the code, always ships the antidote |
| 5 | 🤬 | `reaper` | Maximum heat: code-world stand-up, every rant ends with a revival plan |

### Scoring

| Level | Meaning | Score range |
|---|---|---|
| P0 | Data loss, crash, or opposite of the requirement | 0–39 |
| P1 | Wrong behaviour, or a timing / consistency bug that is very hard to trace | 40–64 |
| P2 | Structural problem: works now, hurts on the next change | 65–84 |
| P3 | Naming, wording, duplication, no behavioural impact | 85–98 |
| — | Nothing found | 85–100 |

Scores reflect **this change only**, not the project's historical debt. Out-of-range scores are clamped to the range implied by the highest severity before rendering.

### Scope

Only `git diff --cached` is reviewed — what you have staged and are about to commit.

| Where the change lives | Reviewed? |
|---|---|
| Staged (`git add`) | ✅ only these |
| Modified but not staged | ❌ |
| Already committed | ❌ |

### Configurable

| Setting | Default | Range | Description |
|---|---|---|---|
| `roastBuddy.tone` | `blunt` | 5 levels | Wording only, never severity or score |
| `roastBuddy.temperature` | `0.3` | 0–1 | Lower is more reproducible, higher is more expressive |
| `roastBuddy.maxFindings` | `6` | 1–10 | Max findings per review; simple changes still return 0 |

All three are also available from the gear button in the panel.

### What is actually sent

- Staged diff (added lines only, up to 6 files / 8000 chars)
- Snippets around the change from the staged version, with line numbers (up to 3 files / 5000 chars)
- The last 3 commit subjects, used only to infer intent — never as review targets
- `.codebuddy/conventions/*.md` digest (up to 2000 chars)

Run **Roast: Preview the full prompt** from the command palette to see exactly what would be sent.

### Privacy

- Only **staged content** is sent to your model provider.
- Not sent: unstaged changes, committed history, the whole repository, credentials, usage statistics.
- No telemetry. The extension makes no network calls itself — the model provider does.

### Optional: file mailbox (CodeBuddy IDE)

If the workspace contains `.codebuddy/skills/roast-review` and no model channel is reachable, the extension falls back to files: it writes `.codebuddy/roast/request.json`, the skill executes it and writes back `result.json`, and the panel renders it. Model calls then go through the host's quota — the extension never holds a key.

### Known limitations

- Staged-only: unstaged edits are never reviewed, and an empty staging area is reported instead of silently reviewing nothing.
- One review covers at most 6 files; oversized changes are truncated.
- P0–P3 are the model's judgement, not static analysis results.
- Requests time out after 180 seconds; retry after a timeout.

### Development

```bash
# Load locally: copy this folder to ~/.vscode/extensions/roast-buddy-0.1.0, then reload the window
# Package:     npm i -g @vscode/vsce && vsce package
```

Before publishing, replace `publisher` in `package.json` with your own Marketplace publisher ID.

---

## 中文

让模型先**还原你这次想做什么**，再对照实现挑刺。不是 lint 汇总，也不是「建议优化」生成器——每条问题都要能指出具体位置和改法。

### 它和普通代码评审有什么不同

大多数 AI 评审会输出一堆永远正确、但没法执行的废话。这个插件把流程钉死成四步：

1. **需求还原**：从提交信息、diff、文件名推断「这次改动想达成什么」，并把推断依据摆给你看
2. **对照实现**：找出与需求直接相关的分支、参数、数据流，确认它真的生效
3. **查漏洞**：遗漏分支、口径不一致、边界未处理、时序依赖
4. **评代码本身**：只评这次改动引入的部分

输出被强制成固定 JSON，再由面板按固定版式渲染，所以每次结果长得一样，不随模型心情变化。

### 使用前提

- VS Code **1.90** 或更高
- 需要**能真正调到模型**的来源，满足其一即可：
  - **GitHub Copilot**：新版 VS Code 已内置 Copilot Chat，但内置不等于可用——需要在 Chat 面板里登录 GitHub 账号，且账号有 Copilot 权限（Free 计划每月有额度）。登录后插件通过 [Language Model API](https://code.visualstudio.com/api/extension-guides/language-model) 自动拿到模型，不需要额外配置。
  - **CodeBuddy IDE**：已登录的情况下，会自动使用它内置的后台模型通道（`tencentcloud.codingcopilot.backgroundLLM.chat`）。
  - 或任何注册了 `LanguageModelChatProvider` 的扩展。

> 判断有没有模型：点「AI 锐评」后看面板里的阶段文字。出现 `请求 #1 → 模型名` 说明通了；出现「内置 LM 没有可用模型」说明还没登录或没有额度。

没有可用模型时，插件不会静默失败，会直接提示去登录 Copilot 或 CodeBuddy——**不做“把提示词粘到网页模型”这类降级**：脱离代码库的模型只能做读后感式评审，价值远低于误导成本。

### 用法

1. 改完代码，`git add` 要提交的文件（**只审这部分**）
2. 左侧活动栏点「锐评」图标
3. 点「AI 锐评」（或 `Ctrl+Alt+R`）
4. 结果按段呈现：我理解的需求 / 总评 / 问题 / 做得对的 / 先做这一件
5. 点问题里的 `文件:行号` 直接跳过去

#### 命令

| 命令 | 说明 |
|---|---|
| `锐评：AI 评审当前改动` | 主入口，面板按钮同此 |
| `锐评：从剪贴板导入评审结果` | 模型输出格式跑偏时，手动修好 JSON 后从命令面板导入渲染（面板不放按钮） |
| `锐评：预览将要发送给模型的全文` | 把整份 prompt（含 diff、代码片段、提交标题）原样打开，用于核对采集范围与隐私 |

#### 语气

面板上的「语气」滑杆可以从左到右在五档间切换，也可以改设置 `roastBuddy.tone`：

| 档位 | 表情 | 值 | 效果 |
|---|---|---|---|
| 1 | 😊 | `praise` | 夸夸型：把作者当少爷哄着说，先真诚夸一句，再温柔提醒 |
| 2 | 🙂 | `advisor` | 温和顾问：像靠谱的技术伙伴在咖啡馆聊代码，对事不对人 |
| 3 | 😐 | `blunt` | 耿直同事（默认）：不绕弯也不阴阳，说清后果并给具体改法 |
| 4 | 😠 | `roast` | 毒舌但有用：嘴毒心善，吐槽完一定给解药 |
| 5 | 🤬 | `reaper` | 赛博阎王：终极毒舌，骂的是代码救的是人，每段都附复活方案 |

旧值 `gentle` / `balanced` / `savage` 仍可用，分别映射到第 2 / 3 / 4 档。

语气**只影响措辞**，不影响问题分级和分数——把档位调低不会让问题消失，调高也不会让分数变低。

#### 其他可调参数

| 设置 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `roastBuddy.temperature` | `0.3` | 0–1 | 采样温度。调到 `0` 同一份改动的结论更稳定，调高措辞更多变 |
| `roastBuddy.maxFindings` | `6` | 1–10 | 最多列几条问题。调小更聚焦，调大更啰嗦；简单改动会自动输出 0 条 |

两项都会在读取时夹回合法区间，填错也不会影响评审流程。

面板右上角的齿轮按钮可以直接用滑杆改这两项，不必进设置页；两边的值是同一份配置，改哪边都会同步。

#### 分级与分数

| 级别 | 含义 | 分数区间 |
|---|---|---|
| P0 | 数据损坏、崩溃、与需求相反 | 0–39 |
| P1 | 行为错误，或极难排查的时序/口径问题 | 40–64 |
| P2 | 结构问题，当前能跑但下次改必踩 | 65–84 |
| P3 | 命名、表述、重复，不影响行为 | 85–98 |
| — | 没有发现问题 | 85–100 |

分数只反映**这次改动**，不累计项目历史债：改动小且正确就该高分。渲染前会按上表校验，模型给出的越界分数会被拉回对应区间。

### 评审范围：只审 git 暂存区

插件只评审 `git diff --cached`，也就是你**已经 `git add`、接下来要提交**的那部分改动。

| 改动在哪 | 会被评审吗 |
|---|---|
| 已 `git add`（暂存区） | ✅ 只有这部分被评审 |
| 改了但没 `git add`（工作区） | ❌ 不参与 |
| 已经 commit | ❌ 不参与 |

一次提交的边界，就是一次评审的边界。先 add，再评，然后 commit：

```
git add <你要提交的文件>   →   点「AI 锐评」   →   看结果   →   git commit
```

#### 每次实际读取的内容

- **暂存区 diff**：只取新增行，最多 6 个文件、8000 字符
- **改动文件片段**：取暂存版本（`git show :file`）改动位置附近，带行号，最多 3 个文件 / 5000 字符
- **最近 3 条提交标题**：只用于推断「这次想做什么」，明确禁止作为评审对象
- **`.codebuddy/conventions/*.md`**：项目规范摘要，最多 2000 字符

`.d.ts`、`.bin`、`meta`、`node_modules`、`@types/` 这类生成物会被过滤掉。

想核对实际发出去的全部内容：命令面板执行 **`锐评：预览将要发送给模型的全文`**。

### 隐私

- 只有**暂存区（`git add` 过）的内容**会发送给所选的模型提供方（Copilot 或宿主内置模型），用于生成评审结果
- 插件**不发送**：未暂存的改动、已提交的历史代码、完整仓库、任何凭据、任何使用统计
- 插件**不联网**，所有网络请求都由模型提供方完成
- 插件只在用户主动操作时写文件：装了 `roast-review` skill 的工作区会写 `.codebuddy/roast/request.json`；诊断日志写在扩展自己的 globalStorage 目录
- 不使用 telemetry

### 可选：文件信箱（CodeBuddy IDE）

如果工作区里存在 `.codebuddy/skills/roast-review`，模型通道不可用时插件会改写文件：把请求写进 `.codebuddy/roast/request.json`，由该 skill 执行后写回 `result.json`，面板监听并渲染。这条路径让模型调用走宿主的额度，插件本身不持有任何密钥。

### 已知限制

- 只评暂存区：工作区里没 `git add` 的改动不会被评；暂存区为空时会提示先 add
- 单次分析最多 6 个文件、上下文有长度上限，超大改动会被截断
- P0–P3 是模型判断，不是静态分析结论
- 请求超时 180 秒；超时后需要重试

### 开发

```bash
# 本地加载：把整个目录放到 ~/.vscode/extensions/roast-buddy-0.1.0 后重载窗口
# 打包：npm i -g @vscode/vsce && vsce package
```

发布前需要把 `package.json` 的 `publisher` 换成你自己的 Marketplace publisher ID。

## License

MIT
