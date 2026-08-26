# nmem

nmem 会话自动同步 + opt-in 引导注入扩展，取代官方 nowledge-mem-omp 插件。

## 功能

- **会话自动同步**：`agent_end` 防抖 flush + `session_before_compact`/`switch`/`shutdown` 刚性 flush，两阶段 `POST /threads` -> `POST /threads/{id}/append`（dedup + idempotency_key），REST 重试，后端不可达时降级提示。
- **引导注入（opt-in）**：默认不注入。设 `NMEM_GUIDANCE=1` 后 `before_agent_start` 向 systemPrompt 追加简短 nmem 提示。默认靠 `nmem-guide` skill + `nmem context` / `nmem wm read` 自助。

不含 Context Bundle 自动注入（用户通过 `nmem context` / `nmem wm read` 按需获取）、custom tools。

## 技能

| 技能 | 模型主动触发 | 说明 |
| --- | --- | --- |
| `nmem-guide` | ✅ | nmem 认知地图 + 搜索/保存路由（SKILL.md 薄入口 + search.md / save.md） |

## 配置

后端连接：`~/.nowledge-mem/config.json` + `NMEM_API_URL` / `NMEM_API_KEY` 环境变量。

引导注入：`NMEM_GUIDANCE=1` 开启（默认关闭）。