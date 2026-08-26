---
name: add-provider-models-to-omp
disable-model-invocation: true
description: 往 omp 的 models.yml 新增/适配 provider 模型，含取参、thinking 合成、capture.ts 实测验证与固定。
---

# Add Provider Models to Omp

把"往 omp 的 `models.yml` 加模型"这件带判断的操作固化成可复用的执行规程。

**对应 provider（leading word）**：模型实际被托管/调用的 provider，以其 `baseUrl`/`api` 为准--不是模型的厂商。例：火山方舟（`ark.cn-beijing.volces.com`）托管了 MiniMax/Kimi，但 models.dev 里只有 `minimax.io`/`kimi.com` 厂商端点。参数必须取自**对应 provider**，否则 API 格式/窗口会错。

## 执行协议

### 1. 确认 Input

- 目标 omp provider：`~/.omp/agent/models.yml` 中已存在的 provider key，或用户要新建并命名。
- 模型清单：一个或多个模型，按 id/名称（如 `glm-5.2`、`kimi-k3`）。
- **完成标准**：目标 provider 与模型清单已明确；provider 已存在或新建名已定。

### 2. 源定位 -- 按对应 provider（托管端点）匹配

1. 读目标 omp provider 的 `baseUrl` + `api`。
2. 用 models-dev-query 技能查 models.dev，找 `api`/`baseUrl` 与之相同的 provider：命中则取参；未命中（如方舟）则回退抓该**对应 provider**的官方 API 文档（web）。
3. 注意：models.dev 的厂商端点（minimax.io）与托管端点（方舟）是不同 provider，模型名相同也不能混用参数。

- **完成标准**：每个目标模型的参数源已确定（models.dev 命中 / 官方文档回退），并记下依据。

### 3. 适配 -- 翻译成 omp 的 model 条目

按目标 provider 的 `api` 适配 `models.yml`。**字段目录与端点例外查 omp 内置文档，本技能不复述**：

- 字段目录 -> `omp://models.md`「`models.yml` shape」+「Compatibility and routing fields」+「Anthropic compatibility」
- 端点例外 -> `omp://provider-endpoint-constraints.md`

本技能只记 omp 文档未作为"配置流程"写的三件事：

**① 该设什么**--`reasoning`（思考支持，来自取参）。思考模型需限定支持档位时设 `thinking.efforts`（ON 档列表，clamp 边界；缺省则 omp 按 `reasoning` 推断默认档）；非思考模型不设。effort 需重映射才设 `compat.reasoningEffortMap`（effort->字符串，压过 catalog 烘焙）。仅 `openai-completions` 设 `compat.thinkingFormat`（5 种，默认 `openai`）。其余 compat（`maxTokensField`/gateway routing/strict tools/cache…）仅当端点需要时按 `omp://models.md` 设。

**② thinking 合成**--`ThinkingLevel -> Effort|undefined（Off->undefined）-> clamp 到 thinking.efforts -> wire-map（compat.reasoningEffortMap ?? thinking.effortMap ?? identity）-> 按 thinkingFormat/api 发送`。`thinking.effortMap` 是 catalog 烘焙（自定义模型 identity），一般不手设。

**③ off 不用配**--omp 无用户可配 off 值（与 pi 的 `thinkingLevelMap.off` 不同）。选 off 时 omp 按 `thinkingFormat` 自动发关闭信号（`zai`/`qwen`/`openrouter`）或省略（`openai`/anthropic）。只列 `thinking.efforts` 的 ON 档即可，off 交给 omp。

条目字段（详见 `omp://models.md`）：

- `id`：用用户给的 id；与源确认是端点实际接受的模型名。
- `name`：显示名。
- `reasoning`：来自源（bool）。
- `thinking.efforts`：见第 4 步。
- `input`：omp schema 接受 `text`/`image`；源的 `video` 等不支持项丢弃。
- `contextWindow` / `maxTokens`：以**对应 provider**官方文档为准；与 models.dev 冲突时取官方文档。
- `cost`：源有按 token 计价填（`input`/`output`/`cacheRead`/`cacheWrite`）；订阅/套餐制（如 Coding Plan）省略（omp 默认 0）。
- **完成标准**：每个模型已生成符合 omp models.yml schema 的条目，input 已去不支持项，context/maxTokens 取自对应 provider 官方文档。

### 4. thinking 合成（核心难点）

1. **Layer1 Provider 机制**：端点怎么收思考参数--按 `api`/`thinkingFormat` 查 `omp://models.md`「Compatibility and routing fields」的 thinking 节（`openai-completions` 5 种 `thinkingFormat` / `openai-responses` / `anthropic-messages` 各自的发送形态）。
2. **Layer2 模型能力**：模型自身支持什么--来自源（`reasoning` 否？分级？哪些档？）。
3. **Layer3 omp 处理**：omp 把 `ThinkingLevel` 翻译成实际请求参数的管线：`ThinkingLevel -> Effort|undefined（Off->undefined）-> clamp 到 thinking.efforts -> wire-map（compat.reasoningEffortMap ?? thinking.effortMap ?? identity）-> 按 thinkingFormat/api 发送`。

- 合成：列模型实际支持的 ON 档进 `thinking.efforts`（如 `["low","medium","high"]`）；omp 按 `reasoning` 推断默认档，需限定才列。effort 值需重映射成端点接受字符串才设 `compat.reasoningEffortMap`（如 Fireworks GLM `minimal -> "none"`）。**off 不用配**--omp 无用户可配 off 值，选 off 时自动按 `thinkingFormat` 发关闭信号（`zai`/`qwen`/`openrouter`）或省略（`openai`/anthropic），与 pi 的 per-api `thinkingLevelMap.off` 语义根本不同。
- **完成标准**：每个推理模型的 `thinking.efforts`（ON 档列表）已列出；`compat.reasoningEffortMap` 仅在需重映射时设；off 交给 omp（不配）；Layer1 已查 `omp://models.md`（不可凭记忆跳过）。

### 5. Checkpoint

跑完取参+适配，产出 **brief** 再让用户确认一次，确认后才写入：

- 将要插入的模型条目（diff/表格）。
- 关键判断：参数源（models.dev 命中 / 官方文档回退）、thinking 结论（机制/能力/最终 `efforts`+`reasoningEffortMap`+`thinkingFormat`）、context/maxTokens 取值（与 models.dev 不同会标明）、cost 省略或填了。
- 来源链接。
- **完成标准**：brief 已呈现并经用户确认；`models.yml` 写入且 `omp models` 校验无配置错误。

---

**验证阶段（步骤 6–9）：测试-抓取-循环-固定**--写入配置后立即验证，用 plugin 内置 `capture.ts` 扩展抓取 omp 实际发送的请求和响应，通过 ≤3 轮测试-改进循环收敛到正确配置，最终固定。

**前提**：步骤 5 已写入 `~/.omp/agent/models.yml` 且 `omp models` 无配置错误；`capture.ts` 位于 plugin `extensions/capture.ts`（pi `scripts/capture.ts` 移植版：删 `before_provider_headers` handler + 去类型，对齐 nmem `// @ts-nocheck` 范式）。

### 6. 运行 agentic 测试

最小化 omp 运行环境，屏蔽其他插件/skills 干扰，只显式加载 capture.ts，执行一个 agentic 任务（多轮工具调用），一次覆盖四个调试维度：

```bash
# 最小化：临时 cwd + 项目级 settings.json 禁干扰扩展 + --no-skills + 显式 capture
VERIFY_CWD=$(mktemp -d /tmp/omp-verify-XXXX)
mkdir -p "$VERIFY_CWD/.omp"
cat > "$VERIFY_CWD/.omp/settings.json" <<'EOF'
{ "disabledExtensions": ["extension-module:nmem"] }
EOF
cd "$VERIFY_CWD"
OMP_CAPTURE_LOG=/tmp/omp-verify-<provider>.jsonl \
  omp --no-skills --extension <plugin-dir>/extensions/capture.ts \
  --print --model <provider>/<model> \
  '用 bash 工具列出 /tmp 目录下的前 5 个文件名，然后告诉我一共多少个'
```

- **为什么最小化**：其他扩展（如 nmem）的 handler 在 `--print` 时仍执行并可能超时（实测 nmem handler 超时 2000ms 污染 stderr）；skills 注入 system prompt 改变模型行为。最小化让 capture 数据干净可复现。
- **为什么不用 `--no-extensions`**：实测（omp 17.2.1）`--no-extensions` 会清除 CLI 的 `-e` 路径（help 称 "explicit -e paths still work" 有误），capture.ts 不加载。改用项目级 `.omp/settings.json` 的 `disabledExtensions` 精确禁用干扰扩展、保留 `-e`。
- **为什么不用临时 agent dir（`PI_CODING_AGENT_DIR`）**：实测复制 `models.yml`+`config.yml` 到临时 dir 仍 401--apiKey 不随这两个文件复制（存于 agent dir 专属存储），隔离 agent dir 会丢 key。故保留主 agent dir，用项目级 `disabledExtensions` 精确禁干扰扩展。
- **干扰扩展名**：`extension-module:<basename>`，basename = 扩展入口文件去 `.ts`（`nmem.ts` -> `nmem`）。装了其他会干扰的扩展按此规则加入。
- `<plugin-dir>` 替换为 plugin 实际路径（`omp plugin link` 后用 `fd add-provider-models` 定位）。
- 用 `--print`（非交互），事件自动触发；临时 cwd 留 `/tmp` 自动清理。
- 日志写 `OMP_CAPTURE_LOG`（默认 `/tmp/omp-capture.jsonl`），JSONL（一行一个聚合 CALL 块）。
- **完成标准**：omp 正常完成请求、日志文件已生成非空。

### 7. 抓取调试

读 JSONL，jq 按 CALL 块分析四维度（每行一个聚合块：assistant 含 `request.payload`/`responses`/`message`，user/toolResult 为精简块 `callIndex=null`）：

| 维度 | jq 证据（JSONL 字段） |
|---|---|
| **基础链路** | `.responses[].status`=200；`.message.stopReason` 非 error |
| **思考参数** | `.request.payload` 含 `reasoning`/`thinking`/`reasoning_effort`/`enable_thinking`；`.message.content.thinkingBlocks>0` |
| **tool 格式** | `.request.payload.tools` 非空；`.message.stopReason`=toolUse + `.message.content.toolCalls` 非空 |
| **缓存** | assistant 块第 2+ 个 `.message.usage.cacheRead>0` |

```bash
L=/tmp/omp-verify-<provider>.jsonl
# 基础链路
jq -c 'select(.role=="assistant") | {callIndex, status: .responses[0].status, stopReason: .message.stopReason, errorMessage: .message.errorMessage}' "$L"
# 思考参数（请求侧字段 + 响应侧 thinkingBlocks）
jq -c 'select(.role=="assistant") | {callIndex, reasoning: .request.payload.reasoning, thinking: .request.payload.thinking, reasoningEffort: .request.payload.reasoning_effort, enableThinking: .request.payload.enable_thinking, thinkingBlocks: .message.content.thinkingBlocks}' "$L"
# tool 格式
jq -c 'select(.role=="assistant") | {callIndex, toolCount: (.request.payload.tools // [] | length), stopReason: .message.stopReason, toolCalls: .message.content.toolCalls}' "$L"
# 缓存
jq -c 'select(.role=="assistant") | {callIndex, cacheRead: .message.usage.cacheRead, cacheWrite: .message.usage.cacheWrite}' "$L"
```

**注意事项**：

- omp 无 `before_provider_headers` 事件（移植时已删该 handler）；payload 由 `before_provider_request` 直接捕获，四维度 jq 不依赖 headers。调试 API key 靠"跑通与否"判断。
- `responseModel` 在 omp 恒为 `null`（四维度 jq 不用它，无害）。
- user / toolResult 块 `callIndex=null`，分析时用 `select(.role=="assistant")` 过滤。
- 日志不脱敏（含 payload 全文），调试结束删除。
- **完成标准**：四维度均已检查，确认有无问题或明确问题所在。

### 8. 循环改进

若步骤 7 发现配置问题，进入改进循环：

1. **回退**：配置问题需恢复时，用步骤 5 的备份或 `git diff ~/.omp/agent/models.yml` 还原。
2. **调整**：根据步骤 7 的发现修正 `models.yml`：
   - `thinking.efforts` 档位错 -> 调整第 4 步得出的档位列表。
   - effort 重映射错 -> 设/调 `compat.reasoningEffortMap`。
   - `thinkingFormat` 不对 -> 设 `compat.thinkingFormat`（仅 completions）。
   - 其他 compat 字段错 -> 按第 3 步重新适配（查 `omp://models.md`）。
3. **重测**：重复步骤 6--用 `OMP_CAPTURE_LOG` 覆盖旧日志，确认问题已解决。
4. **上限**：≤3 轮。超过 3 轮仍未通过，**暂停**并向用户报告：当前抓取发现、已尝试调整及效果、待排查问题、回滚（从备份或 git 恢复）。

一轮定义：一次 `omp --extension capture.ts --print` 运行 + 日志分析。同轮内多次运行（修复后重测）仍算同一轮。

- **完成标准**：配置问题已解决 或 超限暂停向用户报告。

### 9. 固定

配置验证通过后固定最终结果：

1. **清除扩展**：调试完成后，确认 `models.yml` 未引用 `capture.ts`（capture 经 `--extension` 显式加载，不持久化到配置）；步骤 6 的临时 cwd（含 `.omp/settings.json`）留 `/tmp` 自动清理。
2. **校验**：`omp models` 确认无配置错误。
3. **确认**：`omp models 2>&1 | grep <provider>` 确认新模型可见。
4. **清理**：`rm -f /tmp/omp-verify-<provider>.jsonl`。
5. **简报**：告知用户：已添加的模型列表、已通过的测试维度、capture.ts 保留位置（后续排查可复用）。

- **完成标准**：models.yml 有效、模型在 omp 中可见、日志已清理、用户已被告知结果。
