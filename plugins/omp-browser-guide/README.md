# omp-browser-guide

omp browser 冷启动策略技能：把跨站点通用的提取策略前置，避免 agent 每次面对新站点都踩一遍坑（network-first、滚动/懒加载、自动翻译、独立 tab）。

## 心智模型

- **network-first**：页面数据几乎总是来自 JSON API。先挂 `page.on('response')` 抓 API 响应，比 DOM 提取更可靠——完整文本、结构化字段、绕过渲染层干扰。
- **响应即数据**：API 字段就是最终数据，不需要再解析渲染后的 DOM。
- **渲染层是干扰源**：自动翻译、虚拟列表、独立 tab 都是渲染层行为，network-first 天然绕过。
- **tab 语义**：独立 tab 对应独立 API 端点，切 tab 触发新请求，监听器继续捕获。

## 规范

1. 挂监听 `page.on('response')`，过滤目标 API 端点（`/i/api/graphql/`、`/api/` 特征）。
2. 触发请求（导航/滚动/切 tab），`await resp.json()` 递归提取目标字段。
3. API 拿不到才退回 DOM 提取。
4. 虚拟列表用键盘事件（`End`）触发加载，不用 `scrollTo`/`wheel`。
5. 自动翻译：`lang` 属性或"翻译自"标记判断，恢复原文或直接走 network。
6. 时间过滤用 API 的 `created_at`，不用 DOM 相对时间。
7. 提取完核对数据量，确认没漏独立 tab。

## 排查

- 监听器没捕获：确认请求发生，检查 URL 过滤。
- DOM 与 API 不一致：以 API 为准。
- 滚动不加载：换键盘事件或直接导航。
