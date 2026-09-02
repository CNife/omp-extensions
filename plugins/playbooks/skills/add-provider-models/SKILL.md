---
name: add-provider-models
disable-model-invocation: true
description: 为 OMP 的 provider 添加模型，并完成请求级验证。
---

# Add Provider Models to Omp

把“向 OMP 的 `models.yml` 添加模型”固化成一条可验收的流水线。

**Provider-first**：按实际 `baseUrl` + `api` 识别托管 provider。模型厂商名不能替代托管端点；所有参数先取对应 provider，再翻译成 OMP 条目。

## 执行协议

### 1. 确认输入

- 目标 OMP provider：`~/.omp/agent/models.yml` 中已有的 provider key，或用户明确的新 provider 名。
- 模型清单：一个或多个模型，记录每个模型的准确 ID 和显示名。
- **完成标准**：provider、模型 ID、写入范围均已明确。

### 2. 取参：按对应 provider 定位来源

1. 读取目标 provider 的 `baseUrl` 和 `api`。
2. 调用 `models-dev-query`，按 `api`/`baseUrl` 匹配托管端点；命中时以该 provider 的条目为起点。
3. 未命中或出现冲突时，读取对应 provider 的官方 API/模型文档；模型厂商端点与托管端点的参数不混用。
4. 记录每个模型的 ID、能力、上下文、最大输出、价格和来源链接。

- **完成标准**：每个模型都有已确定的参数来源；冲突已按对应 provider 官方文档解决。

### 3. 适配：生成 OMP model 条目

字段目录和端点例外按需读取：

- `omp://models.md` 的 `models.yml shape`、`Compatibility and routing fields`、`Anthropic compatibility`。
- `omp://provider-endpoint-constraints.md`：仅当目标 `baseUrl`/`api` 命中端点例外时读取。

条目规则：

- `id`：填端点实际接受的模型 ID；`name`：显示名。
- `reasoning`：跟随模型来源的思考能力。
- `input`：只使用 OMP schema 接受的 `text`/`image`；源声明的其他模态先核对 OMP 能力。
- `contextWindow`/`maxTokens`：以对应 provider 官方文档为准；与 models.dev 冲突时记录并采用官方值。
- `cost`：按 OMP 规定的单位填 `input`/`output`/`cacheRead`/`cacheWrite`；源货币不同于 OMP 时，沿用现有 `models.yml` 的换算约定，并在 brief 记录汇率。
- `compat`：只填端点实际需要的字段。

thinking 只保留这条合成路径：

`模型能力 → OMP 可用 ON 档 → clamp → thinkingFormat / api wire 参数`

- 模型提供 OMP 可识别的命名 ON 档时，设置 `thinking.efforts`。
- 模型只提供 bool 或 budget 时，按 OMP 适配层映射实际 wire 参数；provider API 字段不直接抄进 `models.yml`。
- `openai-completions` 按需设置 `compat.thinkingFormat`；其他 API 按 `omp://models.md` 的发送形态适配。
- ON 档之外的关闭行为交给 OMP 运行时处理。

thinking 字段与 OMP schema 不一致、或来源只给 budget/bool 时，读取 [`references/thinking-adaptation.md`](references/thinking-adaptation.md)。

- **完成标准**：每个模型都有 schema 合法的条目；来源、能力、上下文、最大输出、成本和 thinking 结论均可追溯。

### 4. brief 与确认

写入前产出 brief，包含：

- 将插入的完整模型条目或精确 diff。
- 参数来源及链接。
- thinking 机制、模型能力、最终 `efforts`、`reasoningEffortMap`、`thinkingFormat` 结论。
- `contextWindow`/`maxTokens` 与 models.dev 的差异。
- cost 的填入、换算或省略理由。

等待用户确认后再写入。

- **完成标准**：brief 已呈现且用户明确确认写入。

### 5. 写入并校验

1. 将条目写入 `~/.omp/agent/models.yml` 的目标 provider。
2. 运行 `omp models <provider>`，确认无配置错误且新模型可见。

- **完成标准**：配置被 OMP 接受，目标模型在 provider 清单中可见。

---

**验证阶段（步骤 6–9）**：写入后立即做一次实际 agentic 调用，用 plugin 内置 `capture.ts` 读取 OMP 的请求和响应；四个维度都必须有证据。

**前提**：步骤 5 已通过；`capture.ts` 位于 plugin 的 `extensions/capture.ts`。

### 6. 运行隔离的 agentic 测试

只关闭扩展发现，再显式加载调试用的 `capture.ts`；skills、rules 和 advisor 都通过 CLI 参数关闭：

```bash
set -euo pipefail
VERIFY_CWD=$(mktemp -d /tmp/omp-verify-XXXX)
VERIFY_LOG=/tmp/omp-verify-<provider>.jsonl
VERIFY_MODEL="<model>"
VERIFY_CONFIG="$VERIFY_CWD/advisor-off.yml"

cat > "$VERIFY_CONFIG" <<'EOF'
advisor:
  enabled: false
EOF

cd "$VERIFY_CWD"
OMP_CAPTURE_LOG="$VERIFY_LOG" \
  omp --no-extensions \
  --extension <plugin-dir>/extensions/capture.ts \
  --config "$VERIFY_CONFIG" \
  --no-skills --no-rules \
  --print --model <provider>/<model> \
  '用 bash 工具列出 /tmp 目录下的前 5 个文件名，然后告诉我一共多少个'

jq -e --arg model "$VERIFY_MODEL" \
  'select(.role=="assistant" and .request.payload.model == $model)' \
  "$VERIFY_LOG" >/dev/null
```

- `--no-extensions` 禁止其他扩展发现；`--extension` 只放行调试用的 capture。
- `--config` 是 CLI overlay，关闭本次运行的 advisor；不修改项目级或全局配置。
- jq 断言必须找到目标模型的 assistant request，证明 capture 实际加载而非仅生成空日志。
- 多个模型逐一运行；每次覆盖自己的 `<provider>` 日志。
- **完成标准**：实际请求正常结束，capture 日志非空且通过 jq 加载断言。

测试隔离、CLI overlay 或 capture 未生效时，读取 [`references/verification.md`](references/verification.md)。

### 7. 抓取并检查四个维度

使用 `references/verification.md` 中的 jq 查询，逐模型检查：

1. **基础链路**：每个响应状态为 200，停止原因不是 error。
2. **思考参数**：请求侧出现正确的 thinking wire 参数，响应侧出现预期 thinking blocks。
3. **tool 格式**：请求带 tools，至少完成一次真实 tool call。
4. **缓存**：至少产生第二次 assistant 请求，并检查真实的 cache usage。

四个维度全部检查；任何一维没有请求/响应证据，都不能进入固定阶段。

- **完成标准**：四个维度均已判定为通过，或明确记录失败维度并进入步骤 8。

### 8. 循环改进

若步骤 7 发现配置问题：

1. 只调整与证据对应的 `models.yml` 字段。
2. 重复步骤 6–7；每轮重新生成并覆盖 capture 日志。
3. 最多 3 轮；一轮 = 一次实际 OMP 调用加一次日志分析。

超过 3 轮仍未通过时，暂停并向用户报告：失败维度、实际请求证据、已尝试调整和当前结果。

- **完成标准**：四个维度通过，或已按上限暂停并完整报告。

### 9. 固定并清理

1. 确认 `models.yml` 没有持久化 `capture.ts`；它只通过本次 CLI 参数加载。
2. 再运行 `omp models <provider>`，确认配置无误、模型可见。
3. 删除本轮 capture 日志和临时测试目录。
4. 向用户报告模型清单、四维测试结果和可复用的 `capture.ts` 路径。

- **完成标准**：配置有效、模型可见、临时产物已清理、用户已收到最终结果。
