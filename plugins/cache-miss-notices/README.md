# cache-miss-notices

显著的 prompt-cache miss 即时通知，移植自 pi 的 `showCacheMissNotices`。

## 功能

每条 assistant 消息结束时，对比上一轮请求的 prompt token 构成。如果本应命中缓存的 token 被重新计费且超过阈值（≥20k tokens 或 ≥$0.1），弹出 warning toast：

```
Cache miss after 7m idle: 45.2k tokens re-billed (~$0.34)
Cache miss after model switch: 120.0k tokens re-billed (~$0.36)
```

## 与 pi 的差异

- 呈现方式：pi 插入 transcript 文本；omp 扩展 API 不支持，改用 `ctx.ui.notify()` toast
- 无持久化：notice 不写入 session 历史，resume 后不重建
- `reportedCache` 分段继承：pi 的整链 sticky 会在切到不报告 cache usage 的模型（如 ollama-cloud）后把每轮全量 prompt 误判为 miss；omp 版只在同一模型链条内继承，跨模型切换最多报切换后第一条（模型切换本身），其后静默
- 默认开启：安装即 opt-in，无设置开关
- 仅即时通知：不含 pi `/stats` 里的累计 cache waste 统计
