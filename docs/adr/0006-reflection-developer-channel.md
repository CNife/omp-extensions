# 收敛检查走 developer 隐藏消息，不走可见用户消息

`loop-reflection` 要在主循环中途插一次收敛检查。移植自 pi 的原版用 `sendUserMessage(..., { deliverAs: "steer" })` 让提醒可见，但 omp 会把所有 `steering: true` 的用户消息在发给 provider 前包进一段声称「用户在工作途中打断」的信封（优先级最高，要求模型重读并服从）。插件插话时并没有用户打断，这个信封在语义上是假的，模型可能据此转向对话而非收敛。omp 的 `custom` 消息在 provider 侧落成 `developer` 角色（Anthropic 在支持中途系统消息时升格为真正的 `system`），正是「像系统消息一样与用户消息区分开」的原生通道，因此改用隐藏的 custom 消息，可见性改由 toast 与会话条目承担。

## 考虑过的选项

- **可见 user 消息**：transcript 里看得到发生了什么，但会带上冒用用户的打断信封。
- **`<system-reminder>` 标签的可见消息**：标签名是宿主保留的，插件冒用会污染日志排查。
- **隐藏 custom 消息（采用）**：provider 侧是 developer/system 级，无需自造 XML 伪装。

## 后果

- 提醒不显示在 transcript 里，触发事实靠 `ctx.ui.notify` 的 toast 与 `appendEntry` 写入的会话条目回溯。
- 提醒不进入用户可编辑界面，用户无法在提醒发出前后"改口"。
- 提示词缓存不受影响：提醒总是追加在 tail，前缀不变。
- 端点不支持 developer 角色时（自定义 `openai-completions` 代理未声明 `compat.supportsDeveloperRole`），该消息会降级为 `user` 角色，且因不带 `steering` 标记，仍不会被包成打断信封——与"冒充用户打断"的关键区别是信封，不是角色名。已在本机 magpie 端点上实测确认。
