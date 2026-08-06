# prune-context

确定性上下文裁剪：零 LLM 开销的 prune->format 管线替代 LLM 摘要压缩。

移植自 [pi-extensions](https://github.com/CNife/pi-extensions) 的 `@cnife/pi-prune-context`。

## 功能

- **`/prune` 命令**：手动触发确定性裁剪，产出结构化 Markdown summary 替代原始消息流
- **`session_before_compact` 钩子**：拦截 `/prune` 触发的压缩，用确定性裁剪替代默认 LLM 摘要
- **`recall_pruned_tool_call` 工具**：按锚点（如 `#14.1`）从会话 JSONL 恢复被裁 toolCall 的完整参数与结果
- **`/compact` 不受影响**：保持 omp 原生 LLM 摘要行为

## 裁剪规则（omp 工具集适配）

toolCall 参数裁剪：

| 场景 | 规则 |
|------|------|
| read / bash / grep / ask / 低频工具 | 全参数保留 |
| write（普通文件） | 裁 `content`，留 `path`+`i` |
| write（`xd://` 工具设备） | 全参数保留 |
| edit（hashline） | 裁 `input`，从 `[PATH#TAG]` 头提取 path |
| edit（其他模式） | 全参数保留 |
| glob | 仅留工具名占位（空参数），保持锚点编号 |

toolResult 裁剪：

| 工具 | 成功 | 失败 |
|------|------|------|
| read / bash / write / edit | 裁 | 留 |
| grep / glob | 裁 | 裁 |
| ask / 低频工具 | 留 | 留 |

其他：

- user / assistant text：全留
- thinking：全裁
- bashExecution / custom / fileMention / developer 等：跳过（omp 内部消息，不入 summary）

## 本地部署

```bash
/marketplace add CNife/omp-extensions
/marketplace install prune-context@omp-extensions
```

## 与 pi 版的差异（移植说明）

- **运行时**：omp 加载扩展时自动把 `@earendil-works/*` 导入重写到 omp 自带打包副本，故 `Text` 等仍按原 `@earendil-works/pi-tui` 导入。
- **工具定义**：`defineTool` / `Type` 改为 `pi.registerTool` + `pi.typebox` 兼容垫片（omp 推荐方式）。
- **`/prune` 触发**：omp 的 `ctx.compact` 是单参 `string | CompactOptions`，且 `CompactOptions` 不含 `customInstructions`，故改为 `ctx.compact(PRUNE_MARKER)`（字符串即 customInstructions）+ try/catch 替代原 `onError` 回调。
- **自动阈值压缩**：omp 的 `session_before_compact` 事件不暴露 `reason`，无法区分自动压缩与手动 `/compact`，故保守地仅对 `/prune` 标记介入（与旧版 pi 行为一致）；自动阈值压缩交给 omp 默认摘要。
- **零依赖**：recall 工具的 TUI 渲染原依赖 `@toon-format/toon`，移植版改为 JSON 缩进格式，保持插件自包含（与本仓库其他插件一致）。
- **工具集适配**：裁剪规则从 pi 的 4-5 个工具全面适配 omp 的 28 个内置工具。toolCall 参数裁剪支持 hashline edit（`[PATH#TAG]` 提取 path）、`xd://` write 检测、glob 占位（保持锚点编号）；toolResult 裁剪按工具分类矩阵（read/bash/write/edit 成功裁失败留，grep/glob 全裁，ask/低频全留）。移除 pi 遗留的 bashExecution/custom 消息角色处理。
