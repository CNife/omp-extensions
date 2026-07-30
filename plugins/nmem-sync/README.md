# nmem-sync

nmem 会话自动同步 + 引导注入扩展，取代官方 nowledge-mem-omp 插件。

## 功能

- **会话自动同步**：`agent_end` 防抖 flush + `session_before_compact`/`switch`/`shutdown` 刚性 flush，两阶段 `POST /threads` -> `POST /threads/{id}/append`（dedup + idempotency_key），REST 重试，后端不可达时降级提示。
- **引导注入**：`before_agent_start` 向 systemPrompt 追加 Nowledge Mem 能力概览。

不含 Context Bundle 自动注入（agent 通过 `read-working-memory` 技能按需获取）、custom tools。

## 技能

| 技能 | 模型主动触发 | 说明 |
| --- | --- | --- |
| `distill-memory` | ✅ | 保存记忆 |
| `search-memory` | ✅ | 搜索记忆 |
| `read-working-memory` | ❌ | 读取 Working Memory |
| `save-thread` | ❌ | 保存会话 handoff |
| `status` | ❌ | 检查 nmem 后端连通性 |

## 配置

后端连接：`~/.nowledge-mem/config.json` + `NMEM_API_URL` / `NMEM_API_KEY` 环境变量。
