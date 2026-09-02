---
name: omp-browser-guide
description: 用 omp browser 工具做网页数据提取、抓取、自动化操作时进来；network-first 优先抓 API 响应，滚动/懒加载、自动翻译、分页/独立 tab 的处理策略。
---

# omp-browser-guide

omp 的 browser 工具是通用驾驶舱：能力上限高，但第一次面对一个站点时，提取策略要靠自己探索。本技能把跨站点通用的策略经验前置，避免每次冷启动都踩一遍坑。

## 心智模型

- **network-first**：页面数据几乎总是来自 JSON API（GraphQL/REST）。先挂 `page.on('response')` 抓 API 响应，比 DOM 提取更可靠——完整文本、结构化字段、绕过渲染层的一切干扰（翻译、懒加载、虚拟列表）。DOM 提取是兜底，不是首选。
- **响应即数据**：API 响应里的字段（`full_text`、`created_at`、互动数）就是最终数据，不需要再解析渲染后的 DOM。递归遍历 JSON 提取目标字段，一次拿到全部。
- **渲染层是干扰源**：自动翻译、虚拟列表滚动、独立 tab 分页——都是渲染层行为，不是数据本身。network-first 天然绕过它们；被迫走 DOM 时才逐个处理。
- **tab 语义**：站点常把内容分到独立 tab（帖子/转帖/媒体），每个 tab 对应不同 API 端点。切 tab 会触发新的网络请求，监听器继续捕获即可。

## 规范

### 提取：先 network，后 DOM

1. 挂监听：`page.on('response', handler)`，过滤目标 API 端点（URL 含 `/i/api/graphql/`、`/api/` 等特征）。
2. 触发请求：导航、滚动、切 tab 都会发新请求，监听器持续捕获。
3. 解析：`await resp.json()`，递归遍历找目标字段（如 `legacy.full_text`）。
4. 只有 API 拿不到（无网络请求、数据在服务端渲染）才退回 DOM 提取。

### 滚动与懒加载

- 虚拟列表（X、Reddit 等）对 `scrollTo`/`wheel` 事件不敏感，**键盘事件**（`End` 键）通常能触发加载。
- 滚动方向：时间线是倒序，往旧方向翻页会远离目标窗口，先确认方向再翻。
- 滚动加载慢时，用 `waitForResponse` 等目标 API 响应，而不是固定 sleep 循环。

### 自动翻译

- 站点（X 等）按浏览器语言自动翻译内容，DOM 里是翻译文本，`lang` 属性会变。
- 恢复原文：批量点"显示原文"按钮，或直接走 network-first 拿 API 原文。
- 判断依据：`lang` 属性不是目标语言，或文本里有"翻译自"标记。

### 分页与独立 tab

- 内容分到独立 tab 时（帖子/转帖/媒体），切 tab 触发对应 API 端点（如 `UserRepostsTimeline`），监听器继续捕获。
- 时间过滤：API 的 `created_at` 字段是权威时间戳，按它过滤窗口，不要用 DOM 里的相对时间（"9小时"）。

### 验证

- 提取完成后，核对数据量与预期一致（如 24h 窗口内条数），确认没有漏掉独立 tab 的内容。

## 排查

- 监听器没捕获到：先确认请求确实发生（`network` 面板/日志），再检查 URL 过滤条件。
- DOM 提取与 API 数据不一致：以 API 为准，API 是数据源，DOM 是渲染结果。
- 滚动不加载：换键盘事件（`End`/`PageDown`），或直接导航触发新请求。
