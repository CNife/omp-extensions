# cache-miss 检测按引用跳过已持久化的当前消息

omp 在把 `message_end` 派发给扩展之前，已把当前消息写进会话记录，所以扫描 `entries` 找「上一轮请求」时，列表里已经包含当前这条消息。

`detectCacheMiss`（`plugins/cache-miss-notices/extensions/cache-miss-notices.ts`）按引用相等（`m === msg`）跳过它：不跳就会把消息与自身比较，prompt token 相等、缓存没被重读，也会报成 miss。pi 的事件顺序相反（先派发后持久化），移植时这处必须改；测试用同一引用模拟该顺序。
