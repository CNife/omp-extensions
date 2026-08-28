# 验证隔离与 capture 参考

在这些情况读取本文件：

- 需要确认显式加载的 `capture.ts` 是否生效；
- 测试出现额外模型调用、插件输出或 advisor 注入；
- 需要按四个维度解析 JSONL。

## 隔离契约

当前 OMP 的 CLI 组合如下：

- `--no-extensions`：关闭扩展发现；
- `--extension <path>`：只加载调试用的 `capture.ts`；
- `--no-skills --no-rules`：移除技能和规则注入；
- `--config <file>`：加载一次性的配置 overlay。

用临时 overlay 关闭 advisor：

```yaml
advisor:
  enabled: false
```

当前环境的 OMP v18.0.8 已实际验证这组 flag：capture 日志含目标模型的 assistant request。每次运行仍以日志断言为准，不以进程退出成功代替 capture 生效。

```bash
jq -e --arg model "<model>" \
  'select(.role=="assistant" and .request.payload.model == $model)' \
  "$VERIFY_LOG" >/dev/null
```

验证时不使用项目级 `.omp/config.yml` 或全局 settings。若 `--no-extensions` 后显式 capture 未加载，本轮直接判为隔离失败并修正 CLI 调用；保持“只加载调试插件”的契约。

## 四维 capture 查询

每行是一个聚合 CALL 块。只分析 assistant 块；user/toolResult 块的 `callIndex` 可能为空。

```bash
L=/tmp/omp-verify-<provider>.jsonl

# 基础链路：每个响应都应为 200，停止原因不能是 error
jq -c 'select(.role=="assistant") | {
  callIndex,
  statuses: [.responses[]?.status],
  stopReason: .message.stopReason,
  errorMessage: .message.errorMessage
}' "$L"

# 思考参数：同时看请求 wire 与响应 thinking blocks
jq -c 'select(.role=="assistant") | {
  callIndex,
  wire: {
    reasoning: .request.payload.reasoning,
    thinking: .request.payload.thinking,
    reasoningEffort: .request.payload.reasoning_effort,
    thinkingBudget: .request.payload.thinking_budget,
    enableThinking: .request.payload.enable_thinking
  },
  thinkingBlocks: .message.content.thinkingBlocks
}' "$L"

# tool 格式：请求带工具，并实际出现 tool call
jq -c 'select(.role=="assistant") | {
  callIndex,
  toolCount: ((.request.payload.tools // []) | length),
  stopReason: .message.stopReason,
  toolCalls: .message.content.toolCalls
}' "$L"

# 缓存：看第二次及之后的 assistant 请求
jq -c 'select(.role=="assistant" and ((.callIndex // 0) > 1)) | {
  callIndex,
  cacheRead: .message.usage.cacheRead,
  cacheWrite: .message.usage.cacheWrite
}' "$L"
```

判定时读取真实值，而不是只判断键是否存在：

1. 基础链路：所有 status 为 200，且没有 error message。
2. 思考参数：wire 字段与模型适配结论一致，响应出现预期 thinking blocks。
3. tool 格式：`toolCount > 0`，并出现真实 tool call。
4. 缓存：存在第二次 assistant 请求，并有可解释的 cache usage。

四个维度都必须产生证据。任何一维失败都回到主技能步骤 8；不通过日志解析来假设通过。

## 清理

capture 日志含完整请求 payload，检查结束后删除日志和本轮生成的临时目录：

```bash
rm -f "$VERIFY_LOG"
rm -rf "$VERIFY_CWD"
```
