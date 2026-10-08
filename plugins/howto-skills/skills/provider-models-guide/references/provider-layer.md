# Provider 层：models.yml 里的 providers 条目

> 权威出处：`omp://models.md`（§Provider-level fields、§Allowed auth/discovery values、§Validation rules、§Command-resolved secrets、§Runtime discovery integration）。本文只给判断与最小配置，不复述文档细节。

## 改动归位：先判断你面对的是哪一类

| 你要做的 | 归位 | 落点 |
| --- | --- | --- |
| 接一个 catalog 里没有的端点（自托管 vLLM、公司网关、兼容代理） | **新 provider** | `providers.<provider>` + `models` 列表，或 + `discovery` |
| 内建 provider 的端点/认证要改（指向自建代理、换网关、加 header） | **覆盖内置** | 只写 `providers.<provider>` 的连接面字段（override-only），不写 `models` |
| 某个模型的名称/成本/窗口/能力/思考元数据不对 | **元数据覆盖** | `modelOverrides.<model-id>`（模型层，见 model-layer.md） |
| provider 端点没问题，只是缺/错某个模型条目 | **加条目** | `models` 列表追加一条，或改用 discovery 自动列出 |

**什么时候动 provider 条目而不是 model 条目**：provider 条目只管「连接面」——baseUrl、api（协议族）、auth、headers、transport、discovery。这些问题出现在「所有模型共用」的层面时才动它：

- 端点地址或路径不对 → `baseUrl`（provider 级或 model 级均可，模型级优先）
- 协议族选错（Chat Completions vs Responses vs Anthropic）→ `api`
- 认证方式/header 缺失 → `apiKey` / `auth` / `headers` / `authHeader`
- 走 omp auth-gateway → `transport: pi-native`
- 模型列表要从端点拉取 → `discovery`

模型独有的事实（成本、上下文窗口、thinking、input 能力）属于 model 层；把它们写进 provider 条目既不生效也不该生效。

**动 provider 之前的边界提醒**：先确认该 provider 是否已被 omp 内建（`omp models` 列一下，或查 catalog）。内建 provider 大多数情况只需 override-only 微调，不需要整条重写。如果目标是「给 omp 内建 catalog 新增一个 provider」（源码级工作，含 KDL 规则与登录流），那是另一条路，见 `omp://adding-a-provider.md`——不要用 `models.yml` 模拟它。

## provider 条目字段

```yaml
providers:
  <provider>:
    baseUrl: https://api.example.com/v1
    api: openai-completions
    apiKey: <provider>_API_KEY      # env 名，见下文 auth 一节
    authHeader: true
    headers:
      X-Team: platform
    transport: pi-native            # 仅在走 omp auth-gateway 时
```

- `baseUrl`：推理端点根。是否以 `/v1` 结尾取决于协议族与 discovery 类型，见下文 discovery 一节。
- `api`：协议族，决定 wire 形状。chat 传输清单（`openai-completions`、`openai-responses`、`openai-codex-responses`、`azure-openai-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-gemini-cli`、`google-vertex` 等）以 `omp://models.md §Allowed provider/model api values` 为准。判断要点：`typesafe` 和 `openrouter-decisions` 是 judge 专用 API，不是 chat 传输，别配成对话模型。
- **runner API 与 `kind`（18.7.0 起）**：model/modelOverrides 条目的 `api` 还可以命名 runner API（`openai-images`、`openai-embeddings`、`openai-speech` 等），对应 `kind`（image/embedding/tts/…）。显式 `kind` 必须是该 api 能服务的 kind；`web-search` 内建不可命名。这是 model 层字段，但选型判断在 provider 层做：先把 provider 的 chat 传输配对，再用 runner API 把网关发现的图像/嵌入模型归位。
- `headers`：provider 级是基线，模型级 `headers` 覆盖同名键。
- `authHeader: true`：把解析出的 key 注入 `Authorization: Bearer <key>`。坑见 auth 一节。
- `transport: pi-native`：该 provider 下**所有**模型都发给 `omp auth-gateway` 兼容地址的 `POST /v1/pi/stream`，`apiKey` 即 gateway bearer。它无视各模型自己的 `baseUrl`，永远 provider-wide（18.2.9 起也覆盖自定义模型）。判断：只在端点确实是一个 auth-gateway 时用；普通兼容端点加它只会把请求发去错误的地方。

## auth 家族

判断顺序：端点要 key 吗 → 要；key 从哪来 → env / `!cmd` / 字面量；端点是完全免key 还是 OAuth 形状 → `none` / `oauth`。

```yaml
providers:
  <provider>:            # env 名（推荐）：未设置或为空时回退为字面量
    apiKey: <PROVIDER>_API_KEY
    authHeader: true

  <provider-shell>:      # 从密码管理器取密钥
    apiKey: "!op read op://vault/<provider>/api-key"

  <provider-keyless>:    # 本地免认证端点
    auth: none
```

- `apiKey`（默认 `auth: apiKey`）：值先当环境变量名解释；env 未设或为空时，**字面量字符串本身被当作 token 使用**。
- `!cmd` 形式：取命令 stdout（去首尾空白）为密钥。异步执行、10 秒超时、结果进程内缓存、失败后退避 30 秒。注意它**没有**字面量 fallback：命令失败或输出为空时解析为「无值」，而不是把 `!op read …` 这串字符发出去。
- `authHeader: true` 的坑：`apiKey: <PROVIDER>_API_KEY` 且 env 未设置时，请求会带 `Authorization: Bearer <PROVIDER>_API_KEY`（字面量被当成 token 发出去）。用 env-backed key 的启动方式，必须先校验变量已设且非空。`!cmd` 秘密不走这条 fallback，所以无此坑。
- `auth: none` / `auth: oauth`：两者都免除自定义 provider 的 `apiKey` 必填要求（18.8.3 文档已明确收敛此语义，直接以 `omp://models.md §Allowed auth/discovery values` 为准）。但 `oauth` **不创建凭据、不注册登录流**，只是强制 OAuth 形状的请求；可用凭据必须来自已存 auth、env 或配置的 key。
- 自定义 `anthropic-messages` 模型在省略 `auth` 时默认按 OAuth 形状发请求；纯 API key 端点要显式写 `auth: apiKey`。
- 覆盖优先级（`--api-key` > models.yml > 存储凭据 > env 等）不复述，见 `omp://models.md §Auth and API key resolution order`。

## 凭据是异步解析的

判断：`omp models` 能列出模型、缓存里能看到条目，**不代表凭据已被探测过**。`!cmd` 秘密在 catalog 加载/检查时不执行，只在真实请求或在线凭据探测需要时才解析；`getAvailable()` 的可用性判断也不执行秘密命令。所以：

- 列表里有模型 ≠ 认证可用；认证失败只会在真实请求时暴露。
- 轮转 secret 后，普通 catalog refresh **不会**失效缓存的命令凭据；要走显式刷新（model hub 的 refresh，即 `refreshCommandCredentials` 路径）或等 401 凭据恢复，然后**再跑一次真实请求**确认。

## discovery：发现端点和推理端点是两个端点

判断：discovery 只决定「模型列表从哪来」，推理走的是 `api` + `baseUrl`。两者可能同 host 不同路径、甚至不同 host；**必须分别验证**——discovery 成功不证明推理可达，反之亦然。

类型选择判据：

| 端点是什么 | discovery.type | 要点 |
| --- | --- | --- |
| Ollama（原生 API） | `ollama` | 走 `/api/tags` + `/api/show`，不是 OpenAI `/v1/models`。不配置时 omp 已隐式注册默认端点，只有非默认地址才需要显式写 |
| llama.cpp（原生 API） | `llama.cpp` | 同上，隐式注册默认 `http://127.0.0.1:8080` |
| LM Studio / 任何 OpenAI 兼容 `/v1/models` 服务器 | `lm-studio` 或 `openai-models-list` | 非 LM Studio 的 OpenAI 兼容服务也走这条路（如 oMLX 绑到其他端口）；**别**把这类服务配成 `ollama` |
| 版本化根路径的网关（`/v3/compat` 之类） | `openai-models-list` + `injectV1: false` | 默认会向 `{baseUrl}/models` 注入 `/v1`；`injectV1: false` 把你的 URL 当完整 API 根 |
| new-api / one-api 类双协议代理 | `proxy` | 见下 |
| LiteLLM 代理 | `litellm` | 富元数据发现；管理路由被限权时需要 `allowed_routes` 放行或 master key |

最小配置（每种一个）：

```yaml
providers:
  <ollama-host>:
    baseUrl: http://<host>:11434
    api: openai-responses
    auth: none
    discovery:
      type: ollama

  <llamacpp-host>:
    baseUrl: http://<host>:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp

  <lmstudio-host>:
    baseUrl: http://<host>:1234/v1
    api: openai-completions
    auth: none
    discovery:
      type: lm-studio

  <openai-compatible>:
    baseUrl: https://<gateway>.example.com/v3/compat
    api: openai-completions
    apiKey: <PROVIDER>_API_KEY
    discovery:
      type: openai-models-list
      injectV1: false        # URL 已含版本段，别再注 /v1

  <newapi-proxy>:
    baseUrl: https://<proxy>.example.com/v1
    apiKey: <PROVIDER>_API_KEY
    authHeader: true
    disableStrictTools: true # 多数 anthropic 前置代理拒绝 strict 字段
    discovery:
      type: proxy

  <litellm-gateway>:
    baseUrl: http://<gateway>:4000/v1
    apiKey: LITELLM_API_KEY
    api: openai-completions
    discovery:
      type: litellm
```

- **`proxy` 的 per-model api 自动探测**：discovery 打 `GET /v1/models`，按每个条目的 `supported_endpoint_types` 逐模型选 `anthropic-messages`（`/v1/messages`）或 `openai-completions`（`/v1/chat/completions`），都没有时回退 provider 级 `api`（缺省 `openai-completions`）。所以 `proxy` 是唯一**不要求** provider 级 `api` 的 discovery 类型；其他类型都必须写 provider 级 `api`。
- **`apple-foundation-models`** 也在 discovery 枚举里，但它是受支持 Mac 上的内建隐式传输，不走 HTTP，也不是合法的 `api` 值——自定义远程 provider 不能用。
- **401/403 不是「没模型」**：18.2.9 起 discovery 的认证失败会以错误形式暴露在 `/models`（模型列表界面）。看到 provider 下列表为空时，先分辨是「discovery 认证被拒」还是「端点真没模型」，别把前者读成后者。
- 超时、`timeoutMs`、各类型的元数据回退细节见 `omp://models.md §Runtime discovery integration`。

## baseUrl 覆盖按 API scope 生效

判断：对内建 provider 改 `baseUrl` 时，作用域不是「整个 provider」这么简单。

- 内建模型的 provider `baseUrl` 覆盖，按「继承它的自定义模型的有效 API」来 scope；override-only 配置则按 provider 的 `api` scope；两者都没有时才 provider-wide。
- `transport: pi-native` 是唯一永远 provider-wide 的例外。
- 自定义 `models` 条目可自带 `baseUrl`（如 Bedrock 的 chat 路由与 `/anthropic` 路由分属两个 URL），模型级优先。

细节与 Bedrock 的 host 改写规则（`bedrock-runtime.{region}.amazonaws.com` 字面量会被替换 region）见 `omp://models.md`（§Provider-level fields、§Bedrock compatibility）。

## 上下文与压缩归位（本章裁量结论）

`maxContextWindow` / `compactionModel` / `remoteCompaction` 各写在哪一层：

- **`contextWindow` / `maxContextWindow` → 模型层**（`models` 条目或 `modelOverrides`）。它们描述单个模型的窗口事实，没有 provider 级形态。`maxContextWindow` 只改 OMP 本地预算，不抬高服务端限制；端点是否接受大请求要单独验证。
- **`compactionModel` → 模型层**（含 `modelOverrides`）。它指向一个具体模型，天然 per-model。它只指定压缩时优先尝试的模型，不切换会话主模型。
- **`remoteCompaction` → 双层，这是唯一的 provider 级入口**。provider 级写基线（`enabled`、`api`、`endpoint` 等），模型级键覆盖 provider 级。理由：provider 原生压缩是「端点能力」，同一端点上的模型往往同开同关，所以 provider 级基线合理；个别模型差异再用模型级覆盖。它还独立满足 override-only provider 的有效性条件之一。
- **`promptCache`（18.3.5 起）→ 模型层**（`models` 条目或 `modelOverrides`，秒为单位的 `short`/`long` 生存期）。它描述单个模型的缓存生存期，且显式写会**整体替换** catalog 生存期（`promptCache: {}` 即关闭该模型的 cache warming；只写 `short` 不会继承 catalog 的 `long`）。对应的 warming 开关 `providers.cacheWarming`（off/streaming/idle）不在 `models.yml`，在 settings——别找错文件。原文见 `omp://models.md §Prompt cache lifetimes`。

## compat 该不该用：三条规则

1. **默认不写**。compat 的 auto 默认已被 catalog/KDL 规则覆盖（解析层序：API 默认 → 端点检测 → KDL 级联 → 稀疏覆盖）；未经证实的开关只会覆盖掉正确的内建策略。
2. **只有验证取证发现端点怪癖才加**，且一次只加一个最小键。证据链必须完整：症状 → `PI_REQ_DEBUG=1` 看 wire → 定位键名。例如第三方 Responses 端点对 `configuration_update` item 回 400 → `compat.supportsConfigurationUpdate: false`；自建 Responses 端点想收 `detail: "original"` → `compat.supportsImageDetailOriginal: true`（18.6.3 起非 OpenAI/Azure/Codex host 默认 `false`）；官方 OpenAI 之外的端点不想要 `previous_response_id` 链式 → `compat.statefulResponses: false`（18.6.3 起，优先级 call option > `PI_OPENAI_STATEFUL` > `compat.statefulResponses` > `compat.officialEndpoint`）。
3. **别用 compat 干其他层的事**。模型窗口、成本、thinking 元数据、路由归属各有自己的字段；compat 只是「端点行为修正」。

配套事实：18.8.1 起，provider/model/modelOverrides 的 `compat` 块里 schema 与运行时词表都不认识的键会产生非致命警告（配置照常加载）；运行时词表不按 provider 的 `api` 过滤，所以在别的 API 家族才生效的键也不会警告——警告不是「写错了」的唯一信号，键无声无效是常态。Anthropic 侧（`bedrockMessagesApi` 等）与 Bedrock Converse 专用 compat 键的清单见 `omp://models.md`（§Anthropic compatibility、§Bedrock compatibility）。
