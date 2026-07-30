# prune-context

确定性上下文裁剪：零 LLM 开销的 prune->format 管线替代 LLM 摘要压缩。

移植自 [pi-extensions](https://github.com/CNife/pi-extensions) 的 `@cnife/pi-prune-context`。

## 功能

- **`/prune` 命令**：手动触发确定性裁剪，产出结构化 Markdown summary 替代原始消息流
- **`session_before_compact` 钩子**：拦截 `/prune` 触发的压缩，用确定性裁剪替代默认 LLM 摘要
- **`recall_pruned_tool_call` 工具**：按锚点（如 `#14.1`）从会话 JSONL 恢复被裁 toolCall 的完整参数与结果
- **`/compact` 不受影响**：保持 omp 原生 LLM 摘要行为

## 裁剪规则（Plan C 最小管线）

- user / assistant text：全留
- thinking：全裁
- toolCall：read/bash/其他保留全参数；write 裁 content；edit 裁 oldText+newText（保留锚点 `#行号.索引`）
- toolResult：toolName ∈ {read, write} 全裁；其他成功裁、失败留
- bashExecution：成功裁 output 留 command；失败全留
- custom_message：作为 user text 保留

## 本地部署

```bash
omp plugin link ./plugins/prune-context
```

## 与 pi 版的差异（移植说明）

- **运行时**：omp 加载扩展时自动把 `@earendil-works/*` 导入重写到 omp 自带打包副本，故 `Text` 等仍按原 `@earendil-works/pi-tui` 导入。
- **工具定义**：`defineTool` / `Type` 改为 `pi.registerTool` + `pi.typebox` 兼容垫片（omp 推荐方式）。
- **`/prune` 触发**：omp 的 `ctx.compact` 是单参 `string | CompactOptions`，且 `CompactOptions` 不含 `customInstructions`，故改为 `ctx.compact(PRUNE_MARKER)`（字符串即 customInstructions）+ try/catch 替代原 `onError` 回调。
- **自动阈值压缩**：omp 的 `session_before_compact` 事件不暴露 `reason`，无法区分自动压缩与手动 `/compact`，故保守地仅对 `/prune` 标记介入（与旧版 pi 行为一致）；自动阈值压缩交给 omp 默认摘要。
- **零依赖**：recall 工具的 TUI 渲染原依赖 `@toon-format/toon`，移植版改为 JSON 缩进格式，保持插件自包含（与本仓库其他插件一致）。
