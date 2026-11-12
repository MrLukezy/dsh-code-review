# dsh-code-diff-review

在 DeepSeek Harness 的 Web 界面里打开一个「代码修改审查」窗口：左边是改动清单和 git 记录，
中间是版本对比 diff，鼠标悬浮任意变更段会弹出这一段的简短审查（范围 / 改了什么 / 风险 / 依据），
右栏还能生成这次改动的逻辑关系图和整份自然语言审查。

> 包名是 `dsh-code-diff-review`。npm 上的 `dsh-code-review` 是别人的另一个插件，本仓库与它无关；
> GitHub 仓库名仍叫 `dsh-code-review`。

## 安装

需要 DeepSeek Harness（`dsh`）和一个可用的模型配置（AI 审查用）。插件不依赖任何第三方包。

**方式一：从插件市场装**（推荐）

在 Harness 的「发现」页签里搜索 `代码修改审查` 或 `code review`。市场索引地址：

```
https://raw.githubusercontent.com/MrLukezy/dsh-code-review/main/market/index.json
```

把这个地址加到插件市场的索引源里即可（见下方「插件市场索引」）。

**方式二：直接从 GitHub 装**

```
plugin_manager install_bundle  github:MrLukezy/dsh-code-review#v0.7.1
```

**方式三：本地目录**

```bash
git clone https://github.com/MrLukezy/dsh-code-review.git
```

```
plugin_manager install_bundle  <克隆目录的绝对路径>
```

装好后侧边栏底部会出现「版本审查」按钮。装完如果没出现，检查：

- `plugin_manager list_plugins` 里是否有 `code-review`，状态是否 enabled；
- 插件要求宿主提供 `webServer` 服务（Web 版 Harness 默认有）；
- 浏览器端改动需要刷新页面才生效，宿主端改动需要把插件 disable/enable 一次。

## 插件市场索引

仓库根目录的 `market/index.json` 就是一份格式 1 的市场索引。要让它出现在 Harness 的「发现」页签：

1. 启用实验性组合包 `@deepseek-ai/dsh-experimental-plugin-market-bundle`；
2. 在该插件市场的配置里加上索引地址：

```yaml
- id: plugin-market
  name: "@deepseek-ai/dsh-plugin-market"
  config:
    indexes:
      - https://raw.githubusercontent.com/MrLukezy/dsh-code-review/main/market/index.json
```

索引里的每个版本用 `source: { type: git, url, commit }` 钉在一个提交上，所以升级要改 `commit` 和 `version`。

## 依赖

| 依赖 | 用途 | 必需 |
|---|---|---|
| `git`（命令行） | 所有 diff / blame / log 数据 | 是 |
| Harness `llm` 服务 | 悬浮简评、AI 审查 | AI 功能需要 |
| Harness `agentDefaultModel` 服务 | 默认用哪个模型审查 | AI 功能需要 |
| Harness `workspaceRegistry` 服务 | 发现你注册过的工作区 | 可选，缺了只少几个候选根 |

`git` 会按顺序尝试 `git`、`GIT_EXE` 环境变量、以及 Windows 上的默认安装路径。

## 用法

1. 侧边栏底部（设置按钮旁）点「版本审查」，或再次点击关闭。
2. 顶部下拉框选仓库。插件会把**会话工作目录 + 进程目录 + 你注册过的工作区**都当成候选根，
   逐个扫「它自己 + 下面一层带 `.git` 的子目录」，去重后按 `.git/index` 的最近活跃时间排序，
   最近跑过 git 的仓库排在前面。一个都没扫到时，窗口里会出现手动输入路径的输入框。
   **每次打开窗口都会默认切到当前会话所在的仓库**，判定顺序：
   会话目录本身是仓库 → 会话目录在某个仓库里（取最近的祖先）→ 会话目录是多仓根时，
   取当前会话最近在工具调用里碰得最多的那个仓库 → 其它会话的目录 → 目录下最近活跃的仓库。
   手动切过之后按你选的来，下次打开再重新对齐。
3. 左栏文件按「代码 → 其它 → 二进制」排序，二进制文件带 `二进制` 标记，默认不会先点到它们。
4. 每条改动右侧有个小圆圈，点一下标记为**已审阅**（勾上后变绿、文件名划掉）。
   顶部「未审 N」是个开关，打开后左栏只留没审过的文件。
   **它只是过滤显示，不删任何东西**——关掉开关，已审的文件原样回来，随时能点开看。
   标记按仓库分别记在 localStorage 里，刷新、重开窗口都还在。
5. 「改动」页签列出工作区 / 暂存区的改动，点一条看 diff；「提交」页签看最近 40 条提交，
   点提交看详情和它改过的文件。
6. 把鼠标停在任意一段变更上 → 弹出**这一处**的简评（见下）。
7. 右栏「关系图」→ 点「生成关系图」，画出「定义文件 → 本次改动 → 引用方」的关系。
8. 右栏「AI 审查」→ 选「本文件」或「全部改动」→ 点「开始审查」。

中间是**左右对照**的差异视图：左边「基础版本」，右边「本地修改」，各自带行号，
删改行左侧标红、新增行右侧标绿，只有一侧有内容时另一侧画斜纹占位。

## 调整布局

三处都可以拖，**双击恢复默认**，宽度记在 localStorage，下次打开还是你调的样子：

| 位置 | 拖什么 |
|---|---|
| 左栏与中间之间 | 文件列表宽度（200–640px，默认 280） |
| 中间与右栏之间 | 说明 / 关系图 / AI 面板宽度（240–1000px；没拖过时按页签自动，关系图给到 620） |
| 差异视图中间那条线 | 「基础版本 / 本地修改」的宽度比（15%–85%，默认对半） |

窗口默认铺到 `98vw × 96vh`，屏幕越大给得越多。

代码按 JetBrains（Rider / IntelliJ）的默认调色板着色，明暗两套自动切换：

| 类别 | Rider 亮色 | Rider 暗色 |
|---|---|---|
| 关键字 | `#0033B3` 蓝 | `#CC7832` 橙 |
| 类型名 | `#1A1A1A` | `#A9B7C6` |
| 方法 | `#00627A` 青 | `#FFC66D` 黄 |
| 字符串 | `#067D17` 绿 | `#6A8759` 橄榄 |
| 数字 | `#1750EB` 蓝 | `#6897BB` 钢蓝 |
| 注释 | `#8C8C8C` 灰 | `#808080` 灰 |
| 注解 | `#9E880D` 橄榄 | `#BBB529` 黄绿 |
| 字段 | `#871094` 紫 | `#9876AA` 紫 |
| 常量 | `#871094` 紫斜体 | `#9876AA` 紫斜体 |

明暗由 `--dsw-alias-bg-base` 的实际亮度判断，切换主题后两秒内跟上。
逐行切分结果有缓存，悬浮等重渲染不会重复计算。

## 悬浮简评

悬浮卡只讲**鼠标所在的这一段改动**，五块内容：

| 块 | 内容 |
|---|---|
| 审查范围 | `第 355–372 行（+13 / -8），是 4 处改动里的第 1 处，只评价这一段` —— 明确这次评价覆盖哪些行 |
| 这段改了什么 | 模型给的一句话；模型还没回来时先用规则兜底（新增/移除的调用、条件判断、变量、注释） |
| 风险 | 模型给的风险；兜底规则会挑出「删掉了条件判断」「涉及协议发送」「新增硬编码数值」这类 |
| 依据 | 这几行的 blame 提交；工作区未提交时给该文件上一次提交 |
| 相关定义 / 绑定 | 最多 2 条真实定义 + 另外几个引用到它的文件，不再把 grep 结果整片倒出来 |

模型简评按文件一次性生成（所有 hunk 一次调用，约 4 秒），按 diff 指纹缓存，重复打开不花 token；
在「AI 审查」页签里可以关掉这个自动生成。

## AI 审查（自然语言）

「AI 审查」页签调用 Harness 的 `llm` 服务，把下面这些材料一起喂给模型，流式生成一份结构化审查：

| 材料 | 作用 |
|---|---|
| 仓库 / 工作区 `AGENTS.md`、`代码自检文档.md`（受 `agent扩充功能开关.json` 控制） | 判断“是否符合项目规约”，逐条给 pass / warn / fail |
| 本次 diff | 判断改了什么、逻辑是什么 |
| 改动处上下文源码（大文件只取改动段前后 25 行） | 让结论能落到具体行 |
| 同目录同类模块的路径 + 声明行摘要 | 判断“有没有采用相似写法”，避免凭空说“无同类可参照” |
| 改动符号的跨文件引用 | 判断影响面与绑定关系 |
| 最近 5 条改动该文件的提交 | 判断这次改动的前因 |

输出固定六段：**做了什么 / 逻辑 / 历史脉络 / 风险（高·中·低 + 文件:行号）/ 同类模块对比 / 规约符合度 / 建议**。

页签顶部还有一份不用等模型的硬材料：**历史** —— 这个文件最近 12 次提交（hash / 作者 / 时间 / 增删行数），点一条直接打开那次提交。

- 模型默认跟随 `agentDefaultModel`，面板里可以单独指定（审查用强模型、日常用快模型）。
- 流式输出：边生成边显示；推理模型的思考过程只显示字数，不刷屏。
- 输出被 token 上限截断时会自动补齐 JSON 结构，保留已生成的部分并标注「已截断」。
- 结果按「范围 + 文件」缓存，来回切文件不会丢；可随时「停止」，已收到的内容保留。

## 悬浮简评的内容从哪来

| 段落 | 来源 | 人工覆盖 |
|---|---|---|
| 审查范围 | 这一处改动块的行号区间、增删行数、它是第几处 | — |
| 这段改了什么 | 模型一句话（`hunkReview`）；没回来时用规则提炼新增/移除的调用、条件、变量、注释 | `logic` |
| 风险 | 模型给的风险；兜底规则挑「删掉条件判断 / 新增 public / 涉及协议发送 / 新增硬编码数值」 | — |
| 依据 | `git blame` 命中的提交；未提交的行退回「该文件上一次提交」 | `basis` |
| 相关定义 / 绑定 | 最多 2 条真实定义 + 另外几个引用到它的文件 | `references` / `bindings` |

符号扫描只扫目标文件同扩展名的文件，并排除 `node_modules` / `Library` / `Temp` / `obj`
等构建产物目录，单次通常 1 秒左右；结果按文件 + 改动块缓存。

## 人工标注（可选）

在仓库根目录放 `.dsh/code-review.json`（也支持根目录 `code-review.json` / `.dsh-review.json`），
说明卡和右栏会优先用这里的内容：

```json
{
  "version": 1,
  "entries": [
    {
      "file": "Assets/Scripts/HotFix/Runtime/Logic/Activity/Module/AllianceBossModule.cs",
      "lines": [355, 432],
      "title": "联盟 Boss 陷阱放置改走二次确认",
      "basis": "策划需求：首次放置与移动使用不同确认文案，避免误触。",
      "logic": "先退出放置态恢复主 UI，再弹确认框；确认回调里统一发请求。",
      "references": [
        { "path": "Assets/Scripts/HotFix/Runtime/UI/UI_Common/ConfirmModule.cs", "lines": [74, 90], "note": "确认框统一入口" }
      ],
      "bindings": [
        { "path": "Assets/Scripts/HotFix/Runtime/Logic/Activity/Module/AllianceBossModule.cs", "symbol": "SendTrapRequest", "note": "确认后真正发协议" }
      ],
      "diagram": {
        "nodes": [
          { "id": "ui", "label": "陷阱放置 UI", "column": "left" },
          { "id": "target", "label": "AllianceBossModule", "column": "center", "kind": "target" },
          { "id": "confirm", "label": "ConfirmModule", "column": "right", "kind": "ref" }
        ],
        "edges": [
          { "from": "ui", "to": "target", "label": "RequestConfirmTrap" },
          { "from": "target", "to": "confirm", "label": "ShowPopupConfirm" }
        ]
      }
    }
  ]
}
```

- `file` + `lines`（新文件行号区间）用来把标注对到具体变更段；不写 `lines` 就是整文件生效。
- `diagram.nodes[].column` 取 `left` / `center` / `right`；`kind` 取 `def` / `target` / `ref` / `commit`。
- 有 `diagram` 时关系图直接用它，没有时按符号扫描结果自动排布。

## 实现

- Host 半区 `index.js`：两个路由
  - `POST /api/code-review`：仓库发现 / 概览 / diff / blame / 符号扫描 / 提交详情 / 标注 / 模型目录，只调 `git`（`execFile`，不经过 shell）。
  - `POST /api/code-review/review`：自然语言审查，SSE 流式返回（`start` / `thinking` / `delta` / `error` / `done`）。
  - 路径先解析成仓库内相对路径，越界直接拒绝；同源校验 + 4MB 请求体上限。
- 浏览器半区 `client.js`：注册两个 slot —— `sidebar.footer.action`（入口按钮）和
  `shell.overlay`（窗口本体）。样式只用 `--dsw-alias-*` 主题 token，不引宿主 Client 包，
  窗口外套了一层错误边界。

## License

[MIT](LICENSE)
