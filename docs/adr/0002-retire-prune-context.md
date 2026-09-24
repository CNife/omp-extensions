# 退役 prune-context 插件

`prune-context` 用确定性裁剪替代 LLM 摘要压缩：`/prune` 命令产出结构化 Markdown summary，`session_before_compact` 钩子接住 `/prune` 触发的压缩，`recall_pruned_tool_call` 工具按锚点捞回被裁掉的 toolCall 参数与结果。OMP 自己的压缩已经足够好用（`compaction.methodOrder` 里的 `remote` / `snapcompact` / `handoff` / `shake` / `soft`），插件带来的额外收益不再成立，因此退役：从 marketplace 摘除注册、删除插件目录。与 ADR-0001 属同一轮退役。

## 考虑过的选项

- **保留插件、只是不用它**：插件仍然会在每个会话注册 `/prune` 命令与 `recall_pruned_tool_call` 工具，并占用 `session_before_compact` 钩子——不退役就得一直带着这些面。
- **保留插件目录、只摘除注册**：同 ADR-0001，仓库不留死重。

## 后果

退役只覆盖仓库。清单里消失的条目在 `omp plugin upgrade` 时被静默跳过，不会自动卸载；已安装实例要手动 `omp plugin uninstall prune-context` 才会真正停用。

## 恢复线索

最后版本 0.3.2，最后提交 `71cf35f` nmem 插件改名 + skill 重写：单 nmem-guide + opt-in 引导。
