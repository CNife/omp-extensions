# verification：验证一个 provider/model 配置

验证回答四个问题：**通不通**（端点可达、认证可用）、**参数对不对**（wire 请求长什么样）、**工具**（tool call 闭环）、**缓存**（prompt cache 真命中）。这四问**按能力门控**：配置里没声明的能力对应项标 N/A，不是失败——不支持工具或缓存的模型不该因此判坏。反过来，HTTP 200 也不是能力与 usage 语义的证据：200 只说明端点应答了，不说明 reasoning 参数被理解、usage 被正确上报、缓存真省了钱。

基线：omp 18.8.3。所有通道都只在下述沙箱里跑。

## 隔离与零残留契约

**判断**：验证会发真实请求、产生含鉴权的日志，所以必须与真实 agent 环境完全隔离，且验证产物用完即清。

- 在**临时 cwd** 里运行；agent 目录用 `PI_CODING_AGENT_DIR=<临时目录>` 重定位，**沙箱 provider 与模型写进该目录的 `models.yml`**（`--config` overlay 是 config.yml 设置层的，不承载 providers）。
- 启动参数带 `--no-extensions --no-skills --no-rules`，排除扩展/skills/规则的干扰（显式 `-e <path>` 仍可按需加载单个扩展）。
- `--config <overlay>` 可以带设置层覆盖，但**它不是全隔离**：配置层级序是 command line > `--config` > project config > global config，overlay 之前生效的全局与项目设置仍然生效——不要宣称「避免全局配置」。
- `PI_CODING_AGENT_DIR` 搬走的是整个 agent 目录，登录态/凭据一并隔离 ⇒ **沙箱 provider 必须自带凭据**（`apiKey`/env 或本地 `auth: none`），不能指望真实目录里存好的 OAuth。
- **零残留**：session JSONL、`rr-session-*` dump、bench 产物、回显探针日志全部落在临时 cwd / 沙箱 agent 目录内，验证结束整体删除；真实 agent 目录零痕迹。

## 五通道

| 通道 | 回答什么 | 看什么 | 边界与注意 |
|---|---|---|---|
| `omp models --json` | 静态面：配置是否通过 schema、模型是否出现在预期 provider 下、limits/reasoning/`input`/`cost` 是否如预期 | 表格的 **`images` 列才是实际发送**（被 `stripImageInput` 剥图的模型显示 `no`）；`--json` 保留声明 `input` | 可见性 ≠ 请求成功；输出不含传输 `api`；discovery 401/403 会在此暴露，别误读成「没有模型」 |
| `PI_REQ_DEBUG=1` | **主干**：wire 请求/响应原文 | 每次实际 fetch 在**当前 cwd** 写 `rr-session-N.json`（请求）+ `rr-session-N.res.log`（响应）；含 Authorization 与完整 body | auth 重试每次尝试各得一份 dump（stamp 机制防重复叠加）。**敏感性：含鉴权与完整上下文——禁止提交、禁止贴出，用完即删** |
| 回显探针 `scripts/echo-endpoint.py` | 请求形状 + 终止语义闭环 | 探针 JSONL 日志逐行核对 path/headers/body，与 `PI_REQ_DEBUG` 交叉验证 | 只对 `openai-completions` 能应答跑完；其他方言请求照发、body 照抓，但 omp 等不到自己方言的响应事件会挂到超时——**只能回答「请求长什么样」，不能回答「响应解析对不对」** |
| `omp bench --cache` | 缓存是否真命中 | 命中判据：暖请求的缓存 usage 值 > 0（输出里的 `cache-read` 列）；TTFT 与 tok/s 只是性能观测，不是命中判据 | `--cache-prefix-bytes`（默认 8192）控制稳定前缀体量；`openai-codex-responses` 不支持；只对声明/期望缓存的模型跑 |
| session JSONL | 端到端 usage 语义 | **看值不看键**：assistant 消息里缓存命中值 > 0（omp 记 `cacheRead`；wire 层面是 `cached_tokens`）、`stopReason != "error"` | `/dump` 只在 TUI/ACP/RPC 交互面可用，`omp -p "/dump"` 不执行 slash command |

回显探针的终止语义（详见脚本头注释与 issue #85）：请求里出现 `role="tool"` 即一律回纯文本；`ECHO_TOOL_CALL=1` 只在首个请求回一次 tool call；`ECHO_MAX_REQUESTS`（默认 8）与 `ECHO_MAX_LOG_BYTES`（默认 32 MiB）兜底防跑飞。

## 标准验证流程（5 步）

在沙箱（见上）内按序执行，每步产出写进模型条目的来源注释（见 model-layer.md）：

1. **启动 schema**：沙箱 agent 目录放入 `models.yml` 后 `omp models --json`，确认配置通过 schema 校验、未知 compat key 无警告、模型挂在预期 provider 下。
2. **静态面**：`omp models --json` 核对声明的 limits / `input` / `cost`；`omp models` 表格核对 `images` 列与预期传输行为（被 `stripImageInput` 剥图的模型显示 `no`——预期剥图就合格）。
3. **真实调用**：`PI_REQ_DEBUG=1` 对**真实目标端点**至少发一次请求，核对成功响应（认证可用、模型应答）与适用的工具闭环——这一步的回答对象是目标端点本身。回显探针只作请求形状的补充取证：对 `openai-completions` 端点可与探针日志逐字节交叉验证，探针自己的应答不构成目标端点的证据。
4. **缓存实测**：`omp bench --cache` 跑冷/暖对（仅当声明/期望缓存），暖请求 `cache-read` > 0 即命中。
5. **JSONL 断言**：检查沙箱 session JSONL——缓存命中值 > 0、`stopReason` 非 `error`、usage/cost 数值与费率对得上。

每一步都按能力门控：没声明的项 N/A 跳过，声明了就必须过。

## wire model ID 改写警示

**判断**：`payload.model == <id>` **只能用于确认保留 ID 的端点**，不是通用断言。网关与托管端点会映射/改写 wire 上的 model 字段：Azure 用 deployment 名作 request model（`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`），OpenRouter 加 `:nitro`/`:floor` 等路由后缀，ClinePass/Firepass/Fireworks 会按推理 effort 或计划改写 wire id。核对请求时以 `PI_REQ_DEBUG` dump 里的实际值为准，判断「端点是否理解了请求」，而不是断言「id 原样往返」。
