# model 层：model 条目字段与取参

本章只管 model 条目本身：`providers.<id>.models[]`（自定义模型）与 `providers.<id>.modelOverrides`（覆盖内建模型）里怎么描述一个模型。provider 层字段（baseUrl/api/auth/apiKey/discovery…）见 provider-layer.md；thinking 参数如何映射到 wire 见 thinking.md。基线：omp 18.8.3。

## 字段一览

**判断**：model 条目的职责是把「一个端点上的模型」翻译成 omp 的本地元数据——身份、能力声明、预算、价格。声明不等于端点行为，凡声明过的能力都要能被验证章的通道证实。

| 字段 | 作用 | 要点 |
|---|---|---|
| `id` | 模型标识，必填非空 | 端点上的真实模型名；选择器写作 `<provider>/<model>` 消除歧义 |
| `name` | 显示名，可选 | |
| `api` | 传输协议 | 缺省继承 provider 的 `api`；也可指向 runner API（`openai-images`、`openai-embeddings`、`openai-speech` 等） |
| `kind` | runner 种类（18.7.0+） | `chat`/`image`/`embedding`/`tts`…；显式声明时必须是该 `api` 能服务的 kind，否则校验失败 |
| `reasoning` | 推理能力声明 | 布尔。是否/如何真的发 reasoning 参数由 thinking 块与 compat 决定（thinking.md） |
| `input` | 输入模态 | 只有两个合法值：`[text]`、`[text, image]`。声明 ≠ 送达，见下文 |
| `contextWindow` | 本地上下文预算 | 自定义模型中提供时必须为正数 |
| `maxContextWindow` | 放宽后的本地预算 | **只改 omp 本地预算（`/extended-context` 依据），不抬服务端限制**；两端都设时必须 ≥ `contextWindow`；设大前先确认端点真的接受更大的请求 |
| `maxTokens` | 最大输出 | 自定义模型中提供时必须为正数 |
| `cost` | 价格，见下节 | |
| `promptCache` | 缓存生存期（18.3.5+） | `{ short: 秒, long: 秒 }`；覆盖语义（显式写整体替换 catalog、`{}` 关 warming、只写 `short` 不继承 `long`）见 [provider-layer.md「上下文与压缩归位」](provider-layer.md) |
| `thinking` | thinking 声明，见下节 | |

最小配置（自定义模型）：

```yaml
providers:
  <provider>:
    # provider 层字段见 provider-layer.md
    models:
      - id: <model>
        api: openai-completions   # 缺省继承 provider 的 api
        name: <显示名>
        reasoning: true
        input: [text, image]
        contextWindow: 128000
        maxTokens: 16384
        cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.25 }
```

runner 类模型（18.7.0+）：

```yaml
providers:
  <provider>:
    models:
      - id: <embedding-model>
        api: openai-embeddings
        kind: embedding
```

非 chat 类模型不在默认 `omp models` 列表里，用 `omp models --kind all`（或 `--kind embedding` 等）观察。

`modelOverrides` 只覆盖元数据、不重新声明模型：`cost` 四项全部可选（只写想改的项）；`contextWindow`/`maxTokens` 的正值校验只作用于 `models[]` 定义。`/extended-context` 是本地预算开关：把 `maxContextWindow` 设大于服务端真实窗口不会让端点接受更大请求，只会让 omp 更晚压缩——上下文溢出仍会在服务端发生。

两个行为注记：

- `input: [text, image]` 不保证图片真送达：catalog class 规则可独立设置 `compat.stripImageInput` 剥除图片（per-model compat 可置 false 反转；`pi-native` 传输不跑客户端剥除）。18.6.3 起非官方 Responses host 默认 `supportsImageDetailOriginal: false`，图片 detail 语义进一步收紧。**`omp models` 表格的 `images` 列报告传输实际发送的内容**，比声明 `input` 可信。
- 改名/删除 model id 后，保存过该模型的旧会话 resume 会显式报错 `Could not restore model <provider>/<id>`（18.6.3 起；有 UI 且 `retry.modelFallback` 开启时降级为警告）。重命名 id 前想到这一点。

## cost：平面费率覆盖（models[] 四项必填）

**判断**：`models[]` 自定义模型显式写 `cost` 就是一次平面费率覆盖——四项缺一不可，漏掉 `cacheWrite` 会让整份自定义 provider 配置失效（schema 校验直接拒绝，实测确认）；`modelOverrides` 的 `cost` 四项全部可选，只写想改的项，属部分覆盖。不想负责定价就整个不写，让价格继承 catalog。

- 单位：USD / 百万 token，四项 `input` / `output` / `cacheRead` / `cacheWrite`。
- 显式 `cost` 是平面费率覆盖，同时禁用继承的时间计价（分时折扣不再生效）。
- **不写 `cost`** 时：全新模型继承 bundled catalog 同名参考行的价格（含时间表）；同 provider 同 id 的覆盖保留原价格；通用 proxy / openai-models-list discovery 的模型保持本地未知零价，不会借上游价格；LiteLLM 等富 discovery 可自带价格。
- `timeBased`（分时费率表）**不能写进 models.yml**，那是 catalog KDL 的专属元数据。
- 18.4.4 起模型元数据带 `serviceTiers`（服务层级与优先级定价倍率，如 Codex Fast 2.5×）——它不是 models.yml 字段；对账 usage/cost 时注意 tier 标签，细则见 `omp://provider-endpoint-constraints.md` 的 Service tier 节。

## thinking 块：model 条目里怎么声明

**判断**：model 条目里 thinking 只做一件事——声明该模型的推理档位。`mode` 必填，恰好五个取值：`effort` / `budget` / `google-level` / `anthropic-adaptive` / `anthropic-budget-effort`；同时必须给出档位集合：`efforts`（推荐，legacy `levels` / `minLevel`+`maxLevel` 仍被接受并规范化）。**`efforts` 必须升序排列，最低档在前**——omp 按顺序取档。

```yaml
providers:
  <provider>:
    models:
      - id: <model>
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, high]   # 升序，最低档在前
```

`effortMap` 可挂在 `model.thinking` 上做逐档微调；`compat.reasoningEffortMap` 是另一层，两者不要混为一谈。mode 怎么映射到请求参数、`:off` 与 `requiresEffort` 语义、按方言的序列化细节，全部见 thinking.md。

## 取参：models.dev 读取协议

**判断**：models.dev 是社区维护的模型元数据货架，适合当取参起点；但它只有**已知 provider** 的行才会被合并进 omp catalog，且完全不是端点可用性的权威——你的 `<provider>` 在不在 omp 的支持名单里、参数新不新，都要另行确认。参数填错的最坏结果不是报错而是静默错误的预算/价格，所以取参要有来源标注。

### 镜像获取与刷新

镜像 = models.dev 仓库（`anomalyco/models.dev`，`dev` 分支）的 tarball，gzip 后仅约 1MB，一次解压到 `~/.cache/models-dev`（可用 `MODELS_DEV` 环境变量改位置）；需要最新数据时设 `MODELS_DEV_REFRESH=1` 重下。解压到临时目录、成功才整体替换，失败不污染旧镜像：

```bash
MODELS_DEV=${MODELS_DEV:-$HOME/.cache/models-dev}
if [ ! -f "$MODELS_DEV/.complete" ] || [ "$MODELS_DEV_REFRESH" = 1 ]; then
  mkdir -p "${MODELS_DEV%/*}"
  tmp=$(mktemp -d)
  if curl -sfL https://github.com/anomalyco/models.dev/archive/refs/heads/dev.tar.gz \
      | tar -xz --strip-components=1 -C "$tmp"; then
    rm -rf "$MODELS_DEV" && mv "$tmp" "$MODELS_DEV" && touch "$MODELS_DEV/.complete"
  else
    rm -rf "$tmp"; exit 1   # 显式失败，改走 gh api 备选
  fi
fi
```

无 curl/tar 环境的备选：`gh api "repos/anomalyco/models.dev/contents/<path>?ref=dev" -H "Accept: application/vnd.github.raw+json"`（文件取原文，目录取 JSON 数组看 `type`/`name`）。镜像刷新是接受人工同步的：上游更新不自动到达，需要新参数就手动 `MODELS_DEV_REFRESH=1` 重下。

### 双货架

所有数据是按 provider 分目录的 TOML。查询 = 先选货架，再读本地文件，全程离线：

| 货架 | 内容 | 用途 |
|---|---|---|
| `providers/` | 目录列表，子目录名 = provider id | 列出所有提供商 |
| `providers/<id>/provider.toml` | `name` / `api`（base URL）/ `env[]` / `npm` / `doc` | 提供商 API 配置 |
| `providers/<id>/models/<model>.toml` | `cost`（USD/百万 token）、`status`、`reasoning_options`、`interleaved`、能力字段 | **该提供商视角**的模型 |
| `models/<provider>/<model>.toml` | 能力、`limit`、`modalities`、`benchmarks`、`weights` | 模型规格（canonical） |

注意：`providers/<id>/models/` 下常有一层按模型厂商分组的子目录（如 `models/zai-org/GLM-5.toml`），确切路径以目录列表为准。

### base_model 继承

provider 层 TOML 含 `base_model = "<provider>/<model>"` 时，能力字段（attachment / reasoning / limit / modalities 等）不重写，继承自 canonical 文件 `models/<provider>/<model>.toml`；无 `base_model` 的 provider 层 TOML 字段自足。读到 `base_model` 或能力字段缺失时，必须补读 canonical 再合并呈现。

### 断链与缺字段处理

上游个别模型读不到（断链 symlink 全仓约 32 个，或 `base_model` 指向的 canonical 不存在）：**该字段标 `N/A`，不要猜、不要拿邻近模型外推**。字段缺失同理。

### 字段映射表

| models.dev 字段 | 所在货架 | 写入 models.yml |
|---|---|---|
| `[cost]` 的 `input` / `output` / `cache_read` / `cache_write` | provider 层 | `cost.input` / `output` / `cacheRead` / `cacheWrite`（注意下划线→驼峰；四项必填） |
| `[limit]` 的 `context` / `output` | canonical | `contextWindow` / `maxTokens` |
| `attachment` + `[modalities]` | canonical | `input: [text, image]`（有 image 模态才加 image） |
| `reasoning` | canonical | `reasoning: true` |
| `[[reasoning_options]]` 中 `type = "effort"` 的 `values` | provider 层 | `thinking.efforts`（升序、最低档在前） |
| `[[reasoning_options]]` 的 `toggle` / `budget_tokens` 档、`[interleaved].field`（如 `reasoning_content`） | provider 层 | 不直接照抄：toggle/budget 档位与独立推理字段属 compat/thinking 层，见 thinking.md 与 compat 三规则（默认不写） |

映射后的 compat 取舍按 [provider-layer.md「compat 该不该用：三条规则」](provider-layer.md) 执行。

### 来源标注

每个模型条目用 YAML 注释标注参数来源与日期，人工同步时更新：

```yaml
- id: <model>
  # 参数来源: models.dev 快照 2026-10-08（cost/limit）；官方文档 <url>（contextWindow）
  # 实测: 2026-10-08 PI_REQ_DEBUG + bench --cache 通过（见 verification.md）
  cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.25 }
```

## 取参可信度序

**判断**：同一个参数（上下文窗口、价格、能力）可能有多个来源，冲突时按可信度序取用，且高可信来源优先：

1. **`omp models --json`**——omp 已经合并出的本地元数据（catalog + 配置 + discovery 的结果），最接近实际发送的面；
2. **models.dev 镜像**——社区货架，可能滞后于端点；
3. **端点官方文档**——provider 自己的定价/规格页；
4. 仍拿不准 → 在条目注释里标「待确认」，交给验证章的实测通道兜底。

`omp models --json` 输出 `provider`/`kind`/`id`/`selector`/`name`/limits/reasoning/`input`/`cost`（不暴露传输 `api`）；表格的 `images` 列是实际发送面。可见性不等价于请求成功，能力声明不等价于 wire 行为——静态面之后必须有真实调用验证。

## 别混写的两个配置面

**判断**：`local/<model>` 的角色分配（memory/small/speech/dictation/judge 等内置工作负载选型）写在 **config.yml 的 `modelRoles`**，不是 models.yml；models.yml 定义 provider 与模型元数据。两件事碰巧都叫「model 配置」，但文件、键名、生效机制都不同。18.7.0 起本地侧还有 `omp models --kind tiny/tts/stt` 观察面。给本地端点加自定义模型 → models.yml；把某个模型指派给某个角色 → config.yml。见 `omp://local-models.md`。
