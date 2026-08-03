# Fusion MVP 能力规格（汇编）

> **状态**：MVP 能力规格（汇编稿）· map：[#17 OMP 原生 Fusion MVP：计划/探索多模型审议能力规格](https://github.com/CNife/omp-extensions/issues/17) · 汇编票：[#22 定稿 Fusion MVP 能力规格（汇编）](https://github.com/CNife/omp-extensions/issues/22)
>
> 本文件只汇编 map 内**已关闭票**（#18 / #19 / #20 / #21 / #24）的决议，不开创尚未决议的产品选择；发现缺口以「附录 A 未决/非阻塞」标注，不静默拍板。
> 每个关键决议旁注来源 issue；细节出入以 issue 关闭决议评论为准，原型草稿为辅。
> 分支：`spec/fusion-mvp`（based on `origin/main`）。实现会话以本文为准，无需再猜。

---

## 1. 目标与非目标

### 1.1 目标（map destination，来自 #17）

Fusion 是一次性「多模型同题审议」能力：用户**显式触发** → 取**当前会话上下文 + 可选一句指令** → 按**配置文件**对 N 个模型并行同题作答 → **一轮综合** → 输出**并列一等**的「合成计划/探索结论 + 分歧信号」→ 结束，**不接管后续工具循环**。

### 1.2 非目标（map Out of scope，规格必须复述）

| 非目标 | 说明 |
| --- | --- |
| 重写 `task` / 子代理 / `herdr` | Fusion 是独立并行补全，不改造既有代理机制 |
| 自适应路由、自动触发 | 路由按任务动态挑 panel、模型主动发起/后台触发均不做 |
| Hermes 式整段会话换 MoA acting model | 不做「会话整体切到融合模型」的 acting 模式 |
| 以 OpenRouter Fusion 为唯一/主实现 | 平台无关；走 OMP 扩展 API（#18） |
| 三层 council 与多档 preset | 只有一层 panel + 一轮合成；无 preset 档位（#21） |
| 完整成本优化/评测基准 | 成本预告仅以 meta 可选字段留位（见附录 A） |
| marketplace 脚手架细节 | 交付载体类型钉死（#24），不铺市场脚手架 |

### 1.3 #18 锁定非目标（实现路径层面）

- 串行 `sendMessage` 重放当并行
- 子代理扇出当主路径
- 事件内扇出（30s 上限）
- 跨族 wire payload 直发
- 实时流式中继（MVP）
- shell / `omp --print` 主路径

## 2. 交付载体（#24）

**决议：A（纯扩展插件）为主载体，C（纯 skill）不入选。**

| 项 | 决议 | 来源 |
| --- | --- | --- |
| 载体 | 扩展插件（`package.json` 声明 `omp.extensions`），MVP 全部运行时能力在扩展侧 | #24 决议评论 |
| 入口 | `/fusion [指令?]` 斜杠命令（`pi.registerCommand`）；工具入口仅作对照备选，**MVP 不双开** | #24 / `DECISION-DRAFT.md` |
| skill | **非 MVP 必选资产** | #24 决议评论 |
| 升级路径 | 若产品后续要「TUI 内可呼出的规范」，按 B 追加一个 `disable-model-invocation: true` 的 SKILL.md（仅规范/用法，无执行内容；扩展代码零改动，package.json 加一行 skills 声明） | #24 决议评论 / `RECOMMENDATION.md` |
| 负例 | C（纯 skill）不入选——skill 无法承担并行扇出 / context 存档 / 配置读取 / `getApiKey` / 命令注册 | #24 决议评论 / `COMPARISON.md` |

## 3. 触发与入口（#20）

| # | 契约 | 来源 |
| --- | --- | --- |
| 3.1 | `/fusion` 与 `/fusion <一句指令>` 均可触发；指令为可选参数，空参数 = 空串，**不弹参数错误** | #20 决议 1 |
| 3.2 | 无指令时默认意图 =「**综合完善当前讨论**」——以「将发送」快照中的最近讨论为议题走完整流程；`meta` 必须如实标注「（无）· 默认意图 = 综合完善当前讨论」 | #20 决议 2 / `CONTRACT.md` 2 |
| 3.3 | 触发瞬间必有可见回声（notify 多行 toast）：panel 名单与数量、指令（或无指令声明）、合成模型；此后用户无需任何操作 | #20 决议 4 / `CONTRACT.md` 4 |
| 3.4 | 结果返回前只有等待槽位（常驻 toast）；单路失败在**同一 toast 追加一行**（模型 + 阶段 + 原因 + 不自动重试），不另起错误 UI、不打断等待 | #20 决议 5 / `CONTRACT.md` 5 |
| 3.5 | 结束后会话只多一条结果气泡，用户可立即继续普通对话（无需清场/重启）；**不接管 tool loop**——不注册自动触发、模型不可主动发起、后续回合行为与触发前一致 | #20 决议 9 / `CONTRACT.md` 9 |

## 4. 输入契约

| 输入 | 决议 | 来源 |
| --- | --- | --- |
| 会话上下文 | = `context` 事件「**将发送**」快照：当时已裁剪、与真实 provider 请求一致的那份消息列表，深拷贝后广播给各 panel；**不读全量 session** | #21 决议 / #18 决议 |
| 裁剪策略 | **配置里没有第二套裁剪 DSL**——不给裁剪比例、不给 include/exclude；与 prune 等扩展的一致性由此天然成立（冻的就是真实请求那份） | #21 决议 / #18 决议 |
| 可选指令 | `/fusion <一句指令>` 的一句话指令作为任务说明发给 panel 与合成阶段 | #20 / #19 |
| 模型名单 | 配置 `panel: string[]`（必填非空），panel 模型 id 列表；无默认值（缺字段/空数组 = 配置错误） | #21 决议 |
| 合成模型 | 配置 `synthesis?: string`，缺省 = 当前会话模型 | #21 决议 |

## 5. 输出契约（#19）

**决议：出口形状 = A 骨架 + B 冲突表。** 规范样例锚：[`prototype/fusion-output-shape` @ `cd35d02`](https://github.com/CNife/omp-extensions/tree/prototype/fusion-output-shape) · [`prototypes/fusion-output-shape/CHOSEN.md`](https://github.com/CNife/omp-extensions/blob/prototype/fusion-output-shape/prototypes/fusion-output-shape/CHOSEN.md)。

### 5.1 可读结构

1. 头信息 `meta`（指令、panel 名单与成功数、合成模型；耗时/用量可选）
2. `## 合成计划` — 可接着执行的终稿（在上）
3. `## 分歧信号` — 与终稿**并列一等**（不是附录），固定三子节：
   - `### 共识` — 可当默认的点
   - `### 冲突` — **对照表**（议题 × 各模型立场 × 合成采纳，点名模型）
   - `### 盲区` — panel 未谈、题目需要的洞（合成可补占位，但必须标成盲区）

### 5.2 MVP 必有字段

| 字段 | 必有？ | 说明 |
| --- | --- | --- |
| `meta` | **是** | 指令、panel 名单与成功数、合成模型；耗时/用量可选 |
| `synthesis` | **是** | 合成计划/探索结论正文 |
| `consensus` | **是** | 共识（否则用户不知道哪些能当默认） |
| `conflicts` | **是** | 点名模型的对照表，含合成采纳 |
| `blind_spots` | **是** | 盲区 |
| `partial_coverage` / `unique_insights` 独立槽 | 否 | 可并入共识叙述或计划正文一句 |
| `open_questions` 独立清单 | 否 | 冲突「合成采纳」+ 盲区已承担 |
| `raw_panel` | 否 | **默认不展示**（出口仅一行槽位说明）；是否另附由产品开关另定，非 `fusion.json` 字段 |

来源：#19 决议评论 / `CHOSEN.md` / `MVP-FIELDS.md`。

## 6. 流程

```
/fusion [指令?]
  → 触发回声（notify toast：panel / 指令 / 合成模型）
  → 读取配置（每次命令执行时读取，不热加载）
  → 取 context「将发送」快照（深拷贝）
  → 并行：panel 模型各一题（streamSimple，进程内）
  → 收齐（allSettled）→ 一轮综合（completeSimple，synthesis 模型）
  → 呈现 CHOSEN 出口（meta + 合成计划 + 分歧信号）
  → 结束：不接管 tool loop，可继续普通对话
```

| 环节 | 决议 | 来源 |
| --- | --- | --- |
| 并行 | 进程内 `streamSimple`/`completeSimple` 对 N 个配置模型并行调用，同题作答 | #18 决议 |
| 一轮综合 | panel 收齐后由合成模型做**一轮**综合，无多轮追问 | #19 / map destination |
| 呈现 | CHOSEN 形状出口（见 §5） | #19 决议 |
| 结束 | 不接管后续工具循环；不注册自动触发 | #20 决议 9 / map destination |
| 扇出位置 | 命令/工具执行路径；**绝不放事件 handler**（30s 上限） | #18 决议 / #18 决议评论 |

## 7. 配置与默认行为（#21）

### 7.1 配置文件

| 项 | 决议 | 来源 |
| --- | --- | --- |
| 路径 | `~/.omp/fusion.json`（用户级；项目级合并 **MVP 不做**） | #21 决议 |
| 格式 | **严格 JSON**；JSONC 仅文档/样例旁注，实现不承诺剥注释 | #21 决议 |
| 未知字段 | **报错，不静默忽略**（fail fast：加载时逐条列出全部错误后停止，不部分生效） | #21 决议 |
| 读取时机 | 每次 `/fusion` 读取配置；**不热加载** | #21 决议 |

### 7.2 字段表

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `panel` | `string[]` | **是** | 无 | 非空，至少 1 个 panel 模型 id；缺字段或空数组 = 配置错误 |
| `synthesis` | `string` | 否 | **当前会话模型** | 合成阶段模型 id |
| 其他 | — | 否 | — | **未知字段 = 配置错误**（不静默忽略） |

错误消息形状（样例，对齐 `config-samples/03-invalid-or-empty.jsonc`）：

```
配置错误（~/.omp/fusion.json）：
  未知字段 "preset"（非目标旋钮，未支持）
  字段 "synthesis" 类型错误：期望 string，得到 number
```

### 7.3 非目标旋钮（MVP 没有）

多档 preset · 自动重试产品化（退避/次数/失败重路由）· 自适应路由 · 逐路超时/并发自定义旋钮 · 输出形状开关（`raw_panel` 展示与否由产品开关另定，配置不背）· 项目级配置合并/云同步。

来源：#21 决议 / `DEFAULTS-DRAFT.md` §6。

## 8. 失败与降级（#21）

| 项 | 决议 | 来源 |
| --- | --- | --- |
| 结算 | 并行 `allSettled`：单路失败不拖垮其余；**不自动重试** | #21 决议 / #18 决议 |
| 最少成功数 | **≥1 路成功 → 仍综合**（partial 出口）；**0 路成功 → 不综合**（all-failed 出口） | #21 决议 |
| 超时默认 | 单路 60s / 整次 90s（固定默认，实现可调、规格写默认；不是配置旋钮）；整次到点不再等，已返回结果照常结算 | #21 决议 / `timeout.md` |
| partial 出口 | 同 CHOSEN 形状：`meta` 写成功数（如 `1/3 成功`）；冲突表**仅成功模型列**；失败模型立场**记入盲区**；失败原因附 meta（一行表格：模型/阶段/原因/影响或建议） | #21 决议 / `partial-1-of-n.md` |
| all-failed 出口 | 复用 meta 头信息气质的错误报告（指令/panel 名单/合成模型/失败明细表），**没有合成计划与分歧信号**；建议（非自动）查公共原因后重新发起 | #21 决议 / `all-failed.md` |
| 呈现 | 失败嵌进 meta/冲突表/盲区，**不另起错误 UI**；进行中单路失败在等待 toast 追加一行 | #21 决议 / #20 决议 5 |
| 超时归并 | 部分超时 → partial；全部超时 → all-failed；原因列写清「单路超时」还是「整次超时」 | `timeout.md` |

样例锚：`prototype/fusion-config-defaults` @ `2563480` · [`prototypes/fusion-config-defaults/failure-reports/`](https://github.com/CNife/omp-extensions/tree/prototype/fusion-config-defaults/prototypes/fusion-config-defaults/failure-reports)（`partial-1-of-n.md` / `all-failed.md` / `timeout.md`）。

## 9. 实现约束（#18，符号级主路径）

**主路径**（按序）：

1. **命令/工具入口**：`/fusion [指令?]` 命令 handler 承担全部编排（读配置 → 取存档 → 扇出 → 综合 → 渲染）。
2. **context 存档**：`pi.on("context")` 事件 handler **只做深拷贝存档**「将发送」消息快照。
3. **并行扇出**：进程内 `streamSimple({ model, apiKey, ... })` 对 N 个 panel 模型并行调用（`Promise.all` 或等价 allSettled 思路），同题作答。
4. **凭证**：`ctx.modelRegistry.getApiKey(model)` 取各模型 API key——OAuth / `omp login` 模型必须显式 `getApiKey`，不能只靠 env。
5. **收齐汇总**：全部 settle 后，合成模型用 `completeSimple` 做**一轮**综合（输入 = 成功路模型 × 文本 × usage），输出 CHOSEN 形状。

**硬约束**：

| 约束 | 来源 |
| --- | --- |
| 事件 handler 有 **30s 上限** → 扇出等待**必须**放在命令/工具执行路径，绝不放事件内 | #18 决议评论 |
| 不需要改 OMP 内核；扩展与 agent loop 同一套 `@oh-my-pi/pi-ai` | #18 决议 |
| MVP 可「收齐再报」；实时多路流式中继非目标 | #18 决议评论 |
| 部分失败逐路记录，用 `allSettled` 思路，不拖死整次 | #18 决议评论 |
| 回声用 `ctx.ui.notify` 多行 toast（仓内既有模式，见 `plugins/skills-injection`）；插入 transcript 为后续选项 | `DECISION-DRAFT.md` |

## 10. 人机契约验收 bullet（#20）

对齐 [`prototypes/fusion-human-contract/CONTRACT.md`](https://github.com/CNife/omp-extensions/blob/prototype/fusion-human-contract/prototypes/fusion-human-contract/CONTRACT.md) 十条：

1. `/fusion` 与 `/fusion <一句指令>` 均可触发；指令可选，空参数合法不报错。
2. 无指令默认意图 =「综合完善当前讨论」；meta 如实标注。
3. 输入 = context「将发送」快照（已裁剪那份）；不读全量 session、无第二套裁剪。
4. 触发瞬间必有 notify 回声（panel 名单/数量、指令、合成模型）。
5. 进行中仅等待槽位；单路失败同一 toast 追加一行，不另起错误 UI。
6. allSettled；≥1 成功仍综合；partial 出口同形状，冲突表仅成功列，失败记盲区 + meta。
7. 出口 = `meta` + `## 合成计划` + `## 分歧信号`（`### 共识` / `### 冲突` 点名模型对照表含合成采纳 / `### 盲区`）。
8. `raw_panel` 默认**不展示**（仅槽位说明行）；开关打开则出口末尾附折叠 panel 原文（每 panel 一段，标注模型与轮次），meta 加 `raw_panel` 行；开关为**产品级**，不是 `fusion.json` 字段。
9. 结束后会话只多一条结果气泡；可立即续聊；不接管 tool loop、模型不可主动发起。
10. 配置锚 `~/.omp/fusion.json`；`panel` 必填非空；`synthesis` 缺省 = 当前会话模型；配置错误 fail fast。

## 11. 验收标准（什么叫 MVP 做完）

实现完成后逐项可勾：

- [ ] **载体**：纯扩展插件（`omp.extensions`），无 skill 文件也能完整交付；`/fusion [指令?]` 命令注册成功（#24）。
- [ ] **入口与回声**：`/fusion` 与 `/fusion <指令>` 均触发；触发瞬间出现含 panel 名单/指令/合成模型的 notify 回声（#20 1、4）。
- [ ] **输入**：panel 收到的是 context「将发送」快照（深拷贝），与真实请求一致；无第二套裁剪（#21）。
- [ ] **并行**：N 个 panel 并行同题作答，走进程内 `streamSimple` + `getApiKey`，扇出在命令路径（#18）。
- [ ] **综合**：≥1 路成功时合成模型（默认当前会话模型）一轮综合；0 路不综合（#21）。
- [ ] **出口形状**：CHOSEN 形状——`meta` + `## 合成计划` + `## 分歧信号`（共识/冲突对照表/盲区）五个必有字段齐全；`raw_panel` 默认不展示（#19）。
- [ ] **失败降级**：单路失败不拖垮整次；partial 出口 meta 写成功数、冲突表仅成功列、失败进盲区；all-failed 出口不产出合成计划；不另起错误 UI（#21 / #20 5、6）。
- [ ] **配置**：`~/.omp/fusion.json` 严格 JSON；`panel` 必填非空；`synthesis` 缺省会话模型；未知字段 fail fast 报错；每次 `/fusion` 重读配置（#21）。
- [ ] **超时默认**：单路 60s / 整次 90s 生效，超时按失败结算（#21）。
- [ ] **结束状态**：结果气泡后用户可立即继续普通对话；无自动触发、无 tool loop 接管（#20 9）。
- [ ] **非目标守住**：无串行重放、无子代理扇出主路径、无事件内扇出、无自适应路由/自动触发/多档 preset/自动重试产品化（#18 / map Out of scope）。

## 12. 参考资产

| 来源 | 链接 / 锚 | 内容 |
| --- | --- | --- |
| issue #17 | [map](https://github.com/CNife/omp-extensions/issues/17) | 地图：计划/探索多模型审议能力规格 |
| issue #22 | [汇编票](https://github.com/CNife/omp-extensions/issues/22) | 本票：定稿 MVP 能力规格 |
| issue #18 | [决议评论](https://github.com/CNife/omp-extensions/issues/18) | 并行调用主路径 + 非目标（无独立原型分支，研究笔记在 issue 内） |
| issue #19 | [决议评论](https://github.com/CNife/omp-extensions/issues/19) · [`prototype/fusion-output-shape` @ `cd35d02`](https://github.com/CNife/omp-extensions/tree/prototype/fusion-output-shape) | 出口形状：A 骨架 + B 冲突表；`CHOSEN.md` / `MVP-FIELDS.md` / 变体 A/B/C |
| issue #20 | [决议评论](https://github.com/CNife/omp-extensions/issues/20) · [`prototype/fusion-human-contract` @ `1f5fb8a`](https://github.com/CNife/omp-extensions/tree/prototype/fusion-human-contract) | 人机契约：`CONTRACT.md` 十条 + `transcripts/01–04` |
| issue #21 | [决议评论](https://github.com/CNife/omp-extensions/issues/21) · [`prototype/fusion-config-defaults` @ `2563480`](https://github.com/CNife/omp-extensions/tree/prototype/fusion-config-defaults) | 配置与失败默认：`DEFAULTS-DRAFT.md` / `config-samples/` / `failure-reports/` |
| issue #24 | [决议评论](https://github.com/CNife/omp-extensions/issues/24) · [`prototype/fusion-delivery-vehicle` @ `fef1fa3`](https://github.com/CNife/omp-extensions/tree/prototype/fusion-delivery-vehicle) | 交付载体：`DECISION-DRAFT.md` / `RECOMMENDATION.md` / `COMPARISON.md` / variant A/B/C |

> 原型目录仅存在于各自 prototype 分支，不复制进 main 生产 `plugins/`；规格只链到分支/路径。

## 附录 A：未决 / 非阻塞（不静默拍板）

以下项**尚未决议**，不影响本规格落地（非阻塞）；实现会话遇到时按默认或另行开票，不要在规格里假装已定：

| 项 | 状态 | 说明 |
| --- | --- | --- |
| `raw_panel` 产品级开关的**露出位置** | 未决（非阻塞） | #20 样例 03 旁注遗留；MVP 默认关闭即可 |
| 无指令时「讨论无明确议题」的**提示语** | 未决（非阻塞） | #20 样例 02 旁注遗留；MVP 按默认意图执行即可 |
| **成本预告** | 非阻塞占位 | meta 的耗时/用量为可选字段，为后续成本优化/评测留位；完整成本优化/评测基准是 map Out of scope |
| **plan / wayfinder 衔接** | 非阻塞 | 本 map 止于规格定稿；后续实现走扩展插件开发（#24 载体），marketplace 脚手架细节不在本 map 范围 |
| panel 默认名单 | 已决（无默认） | `panel` 必填非空、无默认值；样例中的模型名单（如 `claude-opus · gpt-5 · gemini-pro`）仅为假数据 |

---

_汇编依据：各 issue 关闭决议评论 + prototype 分支资产；正文中文；若有出入以 issue 决议评论为准。_
