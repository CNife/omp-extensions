# Thinking：从 ThinkingLevel 到 wire 的主链

> 权威出处：`omp://models.md`（§Compatibility and routing fields → Reasoning/thinking）、`omp://provider-compat-reference.md §2 Reasoning levels`、`omp://provider-endpoint-constraints.md §3/§4`。明细不复述，给出处。

## 主链：一条请求里 thinking 是怎么定型的

```
会话侧 ThinkingLevel（用户/角色选择，:off|minimal|low|medium|high|xhigh|max|auto|inherit）
  → model.thinking.mode（models.yml 必填，五选一，决定 wire 机制）
  → efforts（该模型支持的档位，必须最低档在前）
  → effortMap（档位 → 上游字符串的两层映射，见下）
  → thinkingFormat（compat 方言，五选一，决定字段形状）
  → wire（OMP 实际发出的字段）
```

每一层的判断：

- **ThinkingLevel 是会话侧选择**，不是配置字段。`--model <provider>/<model>:high`、`/model` 选择器、`modelRoles` 的 `:high` 后缀都是它。`auto` 由 OMP 逐轮决定——**18.3.4 起 auto 按问题的开放程度（solutionSpace）选档**，effort 不是模型的静态属性，同一模型不同请求档位可以不同；验证时别把某一次请求的档位当成模型的固定档位。
- **`thinking.mode` 必填**，五个取值：`effort`（OpenAI 式档位）、`budget`（token 预算）、`google-level`（Google 枚举档位）、`anthropic-adaptive`（Anthropic 自适应）、`anthropic-budget-effort`（预算 + effort 组合）。判断依据只有一个：端点的 wire 机制是什么 shape，mode 就选什么。明细见 `omp://provider-compat-reference.md §2` 的 per-provider 表。
- **`efforts` 是有序档位列表，最低档在前**。原因见 OFF 一节：默认方言下 `:off` 会发列表第一个档。legacy 的 `levels` / `minLevel`+`maxLevel` 写法仍被接受并规范化成 `efforts`，但显式 `efforts` 优先——新配置直接写 `efforts`。

```yaml
providers:
  <provider>:
    models:
      - id: <model>
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, high]   # 最低档在前
          defaultLevel: medium
```

## 两层 effort 映射，别混

两处都能把内部档位（`minimal|low|medium|high|xhigh|max`）映射成上游字符串，但归属和作用不同：

| 层 | 位置 | 语义 | 什么时候动它 |
| --- | --- | --- | --- |
| `model.thinking.effortMap` | 模型元数据 | 模型自身的档位裁剪/改名（如该模型没有 `xhigh`，`xhigh → high`） | 自定义模型的上游档位名与 OMP 内部档位不一致 |
| `compat.reasoningEffortMap` | compat 覆盖 | 端点方言的字符串替换（如 Fireworks GLM 的 `minimal → "none"`） | 验证取证发现 wire 上的 effort 字符串不被端点接受 |

应用顺序：**`compat.reasoningEffortMap` 先映射，`model.thinking.effortMap` 后映射**。归属：模型能力裁剪（档位集裁剪/改名）写 `model.thinking.effortMap`；端点方言修正（wire 字符串替换）写 `compat.reasoningEffortMap`。默认两者都不写——catalog/KDL 已覆盖内建模型；自定义模型只有实测 wire 值不对才加，证据链与其他 compat 键相同（症状 → `PI_REQ_DEBUG` → 键名）。

## thinkingFormat：五方言的判据

`thinkingFormat` 是 compat 键（放在 `compat` 块，模型级或 provider 级），决定 thinking 开关与档位发成什么字段。默认 `openai`。判据一句话版：

| 取值 | OMP 会发什么 | 端点判据 |
| --- | --- | --- |
| `openai`（默认） | `reasoning_effort` | 标准 OpenAI 兼容 Chat Completions |
| `openrouter` | `reasoning: { effort }` | OpenRouter 及其嵌套 reasoning 方言 |
| `zai` | `thinking: { type: "enabled" }` | Z.AI / GLM / Kimi 原生系 |
| `qwen` | 顶层 `enable_thinking` | DashScope/Qwen 兼容 dialect |
| `qwen-chat-template` | `chat_template_kwargs.enable_thinking` | 本地 Qwen chat template（NIM/vLLM 之外的模板型端点） |

**明确不复述**五方言的默认检测矩阵、与 `supportsReasoningEffort` 等相邻键的交互——明细以 `omp://provider-compat-reference.md`（Reasoning wire format 表）与 `omp://provider-endpoint-constraints.md §4`（Map reasoning and thinking explicitly）为准。判断原则同 compat 三规则：默认不写，auto 已被 catalog 端点/模型规则选好；只有验证发现 wire 形状不对才显式指定。

## OFF 行为不泛化

**判断：`:off` 发什么，由具体端点的 compat/规则决定，没有统一答案。** 不要写成「thinkingFormat 会自动处理 off」。

- 默认 `openai` 方言下，`--thinking off` **没有显式 off 载荷**：当 `reasoning_effort` 还在发送时，`:off` 被转成 `efforts` 列表的**第一个档**（`efforts: [low, medium, high]` 时发最低档）。这就是 `efforts` 必须最低档在前的原因。
- **`qwen-chat-template` 是唯一能真发「关」的方言**：它发 `chat_template_kwargs: { enable_thinking: false }`。端点确实支持显式关闭且你需要 `:off` 真关闭时，选它。
- 其他方言的显式 off（OpenRouter 的 `reasoning: { enabled: false }`、Z.AI 的 disabled thinking 等）由运行时的 disable-encoding 规则决定，不属于 `models.yml` 可配置面。
- **`requiresEffort`**：默认自动检测（`true` 语义 = 该模型 thinking 不能关，`:off` 会被钳到最低档）。只有**实测确认**后端接受显式 reasoning-off 请求时才设 `requiresEffort: false`——它让 `:off` 选择器不被钳到最低 effort。没实测就设 `false`，等于让 OMP 对一个不接受 off 的端点发 off。

```yaml
providers:
  <qwen-local>:
    api: openai-completions
    models:
      - id: <model>
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, high]
          requiresEffort: false   # 仅在实测端点接受显式 off 后设置
    compat:
      thinkingFormat: qwen-chat-template
```

`requiresEffort` / `supportsDisplay` / `defaultLevel` 等字段清单见 `omp://models.md §Compatibility and routing fields → Reasoning/thinking`。
