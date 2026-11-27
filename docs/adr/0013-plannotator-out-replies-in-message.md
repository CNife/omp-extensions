# `/pnl` 把 `out://` 回复并入所属助手消息

transcript 把 `out://` 回复画成 assistant prose，但会话里它们不在助手消息的 content 里：`write out://` 的正文在 toolCall 参数里，`bash > out://` 与 eval 桥接写入的正文在随后 toolResult 的 `details.replies` 里。`/pnl` 以前只取文本块，于是只发过 `out://` 的回合在选择器里消失（若它是唯一可选消息，`/pnl` 直接去标注上一条旧消息），文本与 `out://` 混排的回合则只把文本部分送进浏览器——用户看到的回复和实际标注的文档不一致（[#135](https://github.com/CNife/omp-extensions/issues/135)）。现在 `/pnl` 把**成功展示给用户的** `out://` 回复当作所属助手消息正文的一部分。

## 正文来源

一条助手消息的正文由按 content 顺序读取的 piece 组成：

- 文本 part 照旧作为 text piece。
- 成功的 `write` 工具调用，目标为 `out://` scheme（`path`，兼容旧会话的 `file_path`），`content` 为非空字符串时作为 reply piece。
- 其他工具调用（普通文件 `write`、`bash` 调用本身等）不贡献正文。

该助手消息之后、下一条助手消息之前的 toolResult 属于这条消息，其 `details.replies` 里的字符串按分支顺序追加为 reply piece。不解析 bash 命令文本里的 `out://` 重定向，也不读取 `out://`（write-only）。

## 成功判定

- `write out://`：按 `toolCallId` 找对应的 toolResult，只有它存在且 `isError` 不为 true 才纳入。失败、超限、被拒绝的写入有 error toolResult，不纳入；仍在流式或回合中断的写入没有 toolResult，视为未确认成功，同样不纳入。
- `details.replies`：出现即说明 `out://` 已经接受该写入并展示给用户，直接纳入，不要求该 bash/eval toolResult 本身非 error——命令可以写入回复之后再失败，已经展示的回复仍然可标注。非字符串项过滤掉。

## 拼接

text piece 之间保留一个换行，任何 reply piece 前后留一个空行，整体 `trim()`。合并结果为空的消息仍然跳过。选择器摘要（首行剥离 markdown 噪声、按码点截断）与字符数沿用原有逻辑，只把输入换成合并后的正文，不新增摘要规则。

## 为什么在插件里本地判断

宿主的 `reply-write` 模块（`isReplyWrite` / `toolResultReplies`）能直接回答「这是不是 reply 写入」和「结果带了多少回复」，但它是宿主内部模块，不在扩展文档化面上；引入它违背 [ADR 0003](0003-documented-cli-surface-only.md)，也让插件跟着宿主重构走。所需的两个事实——toolCall 的 `name`/`arguments`/`id` 与 toolResult 的 `toolCallId`/`isError`/`details`——都在宿主公开的会话条目结构里，本地判断的代价只是十几行纯函数。

## 后果

- 只有 `out://`、没有文本块的助手回合现在出现在选择器里，并正常计入反馈前缀的「倒数第 N 条」序号。这是有意行为：用户看到并标注的就是这条回复，序号必须与 transcript 一致。
- 纯文本消息的正文与行为不变；标注协议、`annotate-last --stdin --json` 的调用方式、超时与反馈投递路径都不变。
- `out://` 关闭、子代理、print/RPC/ACP 等没有 reply 的会话不需要额外判断：不存在可纳入的 piece，行为与以前一致。
