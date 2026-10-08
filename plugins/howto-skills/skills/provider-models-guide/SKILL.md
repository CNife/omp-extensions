---
name: provider-models-guide
description: 为 OMP 配置自定义 provider 与模型（models.yml）：判断改动归哪层、参数从哪取、配置如何验证生效。
disable-model-invocation: true
---

# Provider 与模型配置指南

让 omp 说上一个新端点或新模型，走三条路：判断改动归哪层 → 写条目 → 五通道验证。本文件是判断层；机械细节（字段表、最小配置、映射表、流程）在 references，按各节 pointer 的分支取用。

## 三个心智模型

1. **provider 条目 = 端点，model 条目 = 模型**。provider 条目（`providers.<provider>`）只管「所有模型共用」的连接面：baseUrl、api（协议族）、auth、headers、transport、discovery。模型独有的事实（成本、上下文窗口、thinking、输入能力）属于 model 条目。
2. **omp 只做翻译**。models.yml 里写的永远是 omp 的本地元数据字段；wire 字段（`reasoning_effort`、`thinking_budget`、`chat_template_kwargs` 这类）只出现在「omp 会发什么」的解释里。端点在协议族之内的方言差异，由 compat 键修正。
3. **参数只从端点取**。可信度序：`omp models --json`（omp 已合并出的实际面）→ models.dev 镜像（社区货架，可能滞后）→ 端点官方文档 → 仍拿不准就在条目注释标「待确认」，交给实测兜底。参数填错的最坏结果是静默错误的预算/价格，每个条目都标注来源与日期。

## 边界：先确认目标是否已内建

动手前先 `omp models` 列一下现有清单。内建 provider 大多只需微调：元数据走 `modelOverrides`，连接面（baseUrl/headers/auth）只写 provider 条目的对应字段。如果目标是给 omp 内建 catalog 新增一个 provider（源码级工作，含 KDL 规则与登录流），那是另一条路，见 `omp://adding-a-provider.md`。

**完成判据**：目标已确认内建或未内建，改动已归位为四类之一——新 provider / 覆盖内置 / 元数据覆盖 / 加条目。

## provider 层

- 改 provider 条目的时机：问题出现在「所有模型共用」的层面——端点地址、协议族、认证、headers、模型列表从哪拉取。
- discovery 只决定「模型列表从哪来」，推理走 `api` + `baseUrl`；两者可能同 host 不同路径甚至不同 host，分别验证。
- auth 判断顺序：端点要 key 吗 → key 从哪来（env / `!cmd` / 字面量）→ 免key 还是 OAuth 形状（`auth: none` / `oauth`）。env-backed key 搭配 `authHeader: true` 时，启动前先校验变量已设且非空。
- 凭据是异步解析的：`omp models` 能列出模型 ≠ 认证可用；轮转 secret 后要走显式刷新，再跑一次真实请求确认。
- `transport: pi-native` 只在端点确实是 omp auth-gateway 时使用；它永远 provider-wide。
- 网关 discovery 发现出来的图像/嵌入模型，归位用 model 条目的 runner API + `kind`（如 `api: openai-embeddings` + `kind: embedding`）；先把 provider 的 chat 传输配对，再把 runner 模型挂上去。
- 上下文与压缩各归其层：`contextWindow` / `maxContextWindow` / `compactionModel` / `promptCache` 是模型层字段；`remoteCompaction` 是唯一的 provider 级入口。
- compat 默认不写（auto 默认已被 catalog 覆盖）；只有验证取证发现端点怪癖才加一个最小键，证据链：症状 → `PI_REQ_DEBUG=1` 看 wire → 定位键名。

什么问题去哪篇 → [`references/provider-layer.md`](references/provider-layer.md)：

- 改动归位拿不准（新 provider / 覆盖内置 / 元数据覆盖 / 加条目）→ 开篇归位表。
- auth 怎么选、`!cmd` 秘密的异步解析与轮转语义 → auth 家族节。
- discovery 各类型怎么选（第七类 `apple-foundation-models` 是 Mac 内建隐式传输，不走 HTTP）、各类型最小配置、401/403 的语义 → discovery 节（`proxy` 是唯一可省 provider 级 `api` 的类型，per-model 自动探测）。
- 内建 provider 改 `baseUrl` 的生效 scope、Bedrock host 改写 → baseUrl 覆盖节。
- `remoteCompaction` / `promptCache` / `cacheWarming` 归哪层哪个文件 → 上下文与压缩归位节。
- 已知端点怪癖（Responses 的 `configuration_update`、image detail、`statefulResponses`）→ compat 三规则。

**完成判据**：条目通过 schema 校验、挂载在预期 provider 下、按归位写对了层。

## model 层（含取参与成本）

- model 条目有两种落点：`providers.<provider>.models[]`（自定义模型）与 `providers.<provider>.modelOverrides`（只覆盖内建模型的元数据，不重新声明）。
- 条目的职责是把「一个端点上的模型」翻译成本地元数据：id、能力、预算、价格、thinking 声明。声明 ≠ 端点行为——`omp models` 表格的 `images` 列才是实际发送面。
- `input` 只有两个合法值：`[text]`、`[text, image]`。
- `cost` 四项 `input` / `output` / `cacheRead` / `cacheWrite`（USD / 百万 token）缺一不可，漏项会让整份自定义 provider 配置失效；不想负责定价就整个不写，让价格继承 catalog。
- `maxContextWindow` 只放宽 omp 本地预算（更晚压缩），服务端限制原样；设大前先确认端点接受更大的请求。
- 工作负载角色分配（memory / small / judge 等 `modelRoles`）写在 config.yml；models.yml 只定义 provider 与模型元数据。

什么问题去哪篇 → [`references/model-layer.md`](references/model-layer.md)：

- 字段怎么填、最小配置长什么样、runner 类模型（image / embedding / tts，用 `omp models --kind all` 观察）→ 字段一览。
- cost 的继承与覆盖规则、`timeBased` 归属 → cost 节。
- 取参：models.dev 镜像获取与刷新、双货架查询、`base_model` 继承要补读 canonical、断链标 N/A、字段映射表、来源标注格式 → models.dev 读取协议。
- 同一参数多来源冲突怎么裁 → 可信度序完整展开。
- 模型改名/删除对旧会话 resume 的影响 → 行为注记。

**完成判据**：每个条目 schema 合法，参数有来源标注（镜像日期 / 实测日期），与 `omp models --json` 静态面一致。

## thinking

- 主链一层不跳：会话侧 ThinkingLevel（`:off|minimal|low|…|auto|inherit`）→ `thinking.mode`（必填，五选一，按端点 wire 机制选）→ `efforts`（有序档位，最低档在前）→ 两层 effort 映射 → `thinkingFormat`（compat 方言）→ wire。
- ThinkingLevel 是会话侧选择，`auto` 由 omp 逐轮按问题的开放程度选档；验证时把某一次请求的档位当模型的固定档位会得出错误结论。
- 两层 effort 映射分工：模型自身档位的裁剪/改名挂 `model.thinking.effortMap`；端点方言的字符串替换挂 `compat.reasoningEffortMap`；compat 先映射，model 后映射。默认两者都由 catalog 覆盖，自定义模型实测 wire 值不对才加。
- `:off` 发什么由端点方言决定，各端点答案不同；`requiresEffort: false` 只在实测确认端点接受显式 off 后设置。
- 档位列表写 `efforts`（legacy 的 `levels` / `minLevel`+`maxLevel` 仍被接受并规范化，`efforts` 优先）。

什么问题去哪篇 → [`references/thinking.md`](references/thinking.md)：

- `thinking.mode` 五取值（effort / budget / google-level / anthropic-adaptive / anthropic-budget-effort）各对应什么 wire 机制 → 主链与 per-provider 判据。
- `effortMap` 与 `compat.reasoningEffortMap` 各管什么、先后顺序 → 两层 effort 映射对照表。
- 端点的 thinking 字段形状不对（`reasoning_effort` / `reasoning: {effort}` / `thinking` / `enable_thinking` / chat template）→ thinkingFormat 五方言判据表。
- `:off` 到底发什么、`requiresEffort` 什么时候设 `false` → OFF 行为节。
- 旧 `add-provider-models` thinking 文档的结论是否可用 → 作废断言清单。

**完成判据**：`thinking.mode` 必填已给，`efforts` 最低档在前，映射层与方言层各归其位。

## 验证

验证四问：**通不通**（端点可达、认证可用）、**参数对不对**（wire 请求形状）、**工具**（tool call 闭环）、**缓存**（真命中）。按能力门控：配置里没声明的能力对应项标 N/A；HTTP 200 也只是端点应答了，不构成能力与 usage 语义的证据。

所有验证在沙箱里跑：临时 cwd + `PI_CODING_AGENT_DIR=<临时目录>` 重定位 + `--no-extensions --no-skills --no-rules`，产物用完即清，真实 agent 目录零痕迹。五通道：`omp models --json`（静态面）、`PI_REQ_DEBUG=1`（wire 原文，含鉴权，禁止提交、用完即删）、回显探针 `scripts/echo-endpoint.py`（请求形状 + 工具闭环，仅 `openai-completions` 方言可跑完）、`omp bench --cache`（缓存命中）、session JSONL（usage 语义，看值不看键）。

什么问题去哪篇 → [`references/verification.md`](references/verification.md)：

- 沙箱怎么搭、`--config` overlay 的隔离边界、零残留清单 → 隔离与零残留契约。
- 某个通道的产物怎么看、边界在哪（`images` 列、dump 敏感性、探针终止语义、`--cache-prefix-bytes`、`/dump` 的适用面）→ 五通道表。
- 一次完整验证的执行顺序 → 标准验证流程 5 步。
- 请求里的 `payload.model` 与配置 id 对不上 → wire model ID 改写警示。

**完成判据**：四问全部有证据或明确标 N/A，沙箱产物已清理。

## 症状表

| 症状 | 先看哪里 |
| --- | --- |
| 启动校验失败（schema 报错 / compat 未知键警告） | verification.md 通道 1 确认挂在哪；cost 漏 `cacheWrite` → model-layer.md cost 节；compat 键无声无效 → provider-layer.md compat 三规则 |
| 模型不出现 | provider-layer.md discovery 节：discovery 认证被拒（401/403）容易被误读成「端点没模型」；`injectV1` 与版本化根路径；非 chat kind 用 `omp models --kind all`（model-layer.md runner 类） |
| 4xx / 鉴权失败 | provider-layer.md auth 家族节（env 字面量 fallback、`!cmd` 异步解析）；`PI_REQ_DEBUG` dump 看实际发出的 header 与 body（verification.md 通道 2） |
| 思考缺失或报错 | thinking.md：`thinking.mode` / `efforts` 是否声明、thinkingFormat 方言选对没、OFF 行为；verification.md 通道 2 核对 wire 上的 reasoning 字段 |
| 工具被拒 | provider-layer.md compat 三规则（`disableStrictTools`、`supportsConfigurationUpdate` 等端点怪癖）；verification.md 回显探针的工具闭环 |
| 缓存为 0 | provider-layer.md promptCache 节（模型层字段、显式写整体替换 catalog 生存期）；verification.md `bench --cache` 冷/暖对 + session JSONL 看值不看键 |
| 上下文不足 / 过早压缩 | model-layer.md：`maxContextWindow` 只改本地预算，溢出发生在服务端，端点是否接受大请求要单独验证 |

## 配置位置

provider 与模型写在 agent 目录的 `models.yml`（默认 `~/.omp/agent/models.yml`；`PI_CODING_AGENT_DIR` 可重定位，以运行实例的 agent 目录为准）。工作负载角色分配在 config.yml 的 `modelRoles`。
