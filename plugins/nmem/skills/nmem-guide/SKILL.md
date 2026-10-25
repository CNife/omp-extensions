---
name: nmem-guide
description: 搜过去知识 / 存新知识 / 查 nmem 命令树时进来。
---

# nmem-guide

nmem 是本地优先、图谱增强的跨工具个人记忆层。

## 路由

- 该搜过去知识 → 读 `skill://nmem-guide/search.md`
- 该存新知识 → 读 `skill://nmem-guide/save.md`
- 查 nmem 能干什么 → `nmem --help` 看组，`nmem <group> --help` 看子命令与 flag

## 约定

- `nmem context` / `nmem wm read` 是 opt-in 的启动上下文：OMP 不自动注入，要用时自己取。
- 出问题先 `nmem status`；连不上再看 `nmem doctor`。