# nmem 同步遵守的宿主预算与提示词分段

`nmem` 在进程退出前把会话落盘，在启动时可能给系统提示词补一段说明。这两处都受宿主给出的硬约束，代码本身读不出来，记录在此。

## 退出同步只有 2 秒

宿主 `runner.ts` 的 `SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS` 把 `session_shutdown` 处理器限制在 2 秒：超出窗口的部分被静默取消，数据没落盘，也看不到报错。一次普通请求是 8 秒超时加 2 次重试（`rest.ts` 的 `DEFAULT_TIMEOUT_MS` / `MAX_RETRIES`），套进去必然超窗。因此退出这一轮用 `SHUTDOWN_FLUSH_OPTIONS = { timeoutMs: 800, retries: 0 }`（`nmem.ts`）：两阶段至多两次请求（create → append 兜底），合计 1.6 秒，留在窗口内。

若 `agent_end` 的防抖同步已在飞，退出调用只并入同一条线程链（`session-sync.ts` 的 `flushPayload` / `drain`）；那条请求已经在线上，宿主上限自会兜住等待。

## 排队的快照自带预算

退出这一轮不继承先到的 `agent_end` 轮的默认预算（8 秒 + 重试），否则退出预算整个失效。同一线程只保留最新一份排队快照（`SyncState.queued`），旧快照不会被拿来顶替新快照。

## 防抖快照在点火时构建

防抖的 `scheduleFlush`（`FLUSH_DELAY_MS = 750`）在定时器点火时才调用 `buildSyncPayload`。提前 750 毫秒构建会漏掉期间追加的条目。

刚性 flush 会取消待触发的防抖定时器（`cancelScheduledFlush`）：防抖快照在点火时构建，取消它不丢任何条目——刚性 flush 从同一分支构建等宽或更宽的快照；留着它反而给退出路径多加一轮，越过 2 秒。

## 超时预算覆盖到正文读完

`rest.ts` 的 `nmemRequest` 在同一个 AbortController 下读取 `response.json()`：后端先回头、后慢发正文时同样在 `timeoutMs` 处中止，并映射为 `timeout`。只包住 `fetch` 会让慢正文无限悬挂。

## 退出事件只有 type

`SessionShutdownEvent` 只有 `type` 字段；带 `reason` 的是 `session_before_switch`。`nmem.ts` 的 `session_shutdown` 处理器固定写 `session_shutdown` 作为同步理由——曾读 `event.reason`，把 `"session_shutdown:undefined"` 写进后端线程的 `metadata.sync_reason`。

## 引导注入追加独立分段

`before_agent_start` 的 `event.systemPrompt` 与返回值都是 `string[]`，每项是一段。宿主与按段首标记定位易变段的 provider（Anthropic 侧的 `<project-context>` 等）依赖这些边界放缓存断点；字符串插值会把多段逗号拼成一段，易变段并入缓存前缀，cwd 或工作区一变化整段系统提示词缓存失效。因此 `nmem.ts` 追加 `[...event.systemPrompt, "\n" + startupGuidance()]`，而不是拼进已有字符串。
