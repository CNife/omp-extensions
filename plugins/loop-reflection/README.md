# loop-reflection

主循环的周期性**收敛检查**：连续推进 N 个回合后，以一条隐藏消息要求模型停下来只回答三个问题——目标是否达成、证据是否足够、下一步是否仍是最小有效动作。

移植自 pi 的 `agent-loop-reflection`，按 omp 的注入通道与「过度思考 / 过度验证」这个新问题重写；三处刻意偏离见文末。

## 功能

- 只对主会话生效（`ctx.agent.kind === "main"`），子代理不受影响。
- 计数归零后的第一个「还会继续」（`stopReason === "toolUse"`）回合触发；触发后重新从满值倒数，不封顶。
- 提醒以隐藏 custom 消息注入，transcript 不渲染；触发事实由 toast 与会话条目承担。
- 每次触发弹 toast：`Loop reflection at turn 12 (provider/id)`；同时 `appendEntry("loop-reflection", { turnIndex, model })` 写一条**不进 LLM** 的会话条目。
- 不动状态栏，不封顶，不做提醒强度分级。

## 配置

`~/.omp/agent/cnife-loop-reflection.json`（命名风格与 `cnife-skills-injection.json` 一致）。文件不存在时自动写出默认配置。

```json
{
  "enabled": true,
  "intervalTurns": 15,
  "models": { "include": [], "exclude": [] },
  "reminderText": "<loop-reflection turns=\"{turns}\">\n…\n</loop-reflection>"
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后完全不计回合。 |
| `intervalTurns` | `15` | 两次收敛检查之间推进的回合数，正整数。 |
| `models.include` | `[]` | 白名单 glob；空表示不限制。 |
| `models.exclude` | `[]` | 黑名单 glob，**优先于 include**。 |
| `reminderText` | 见下文 | 非空字符串，`{turns}` 会替换为实际间隔。 |

配置**要么可信、要么回默认**：JSON 非法、字段类型不对、列表里有非字符串，都整体回退默认值并告警（console 一行），不做逐字段降级。每次事件现读文件，改 `enabled` 无需重启。

### 模型门控

- 匹配对象先试 `provider/id`，再退化试裸 `id`。
- 大小写不敏感；`*` 匹配任意字符，**包括 `/`**（模型 id 不是路径）。其余字符（`.`, `:`, `+` 等）按字面处理。
- `exclude` 命中即关闭；`exclude` 都未命中时，若 `include` 为空则启用，否则须有一条 include 命中。
- 门控不匹配的回合**完全不计**（不递减、不触发）——计数器只度量当前模型自己跑了多少回合。
- 切到被门控的模型时从满值重新倒数，不会立刻弹提醒。

示例：

```json
{ "models": { "include": ["*deepseek*"], "exclude": ["*-free"] } }
```

## 计数规则

状态是一个单调整数计数器，初值为 `intervalTurns`：

1. 重置点：`session_start`、`session_tree`、`session_compact`、`agent_start`，以及任何 `source !== "extension"` 的 `input`（排除插件自己的注入，否则会重置自己）。不监听 `agent_end`——它的重置由 `agent_start` 覆盖。
2. 门控不匹配 / 插件关闭 / 模型未知：不计。
3. 门控匹配：当前模型与上一回合不同（含首次进入匹配态）→ 先重置为满值再计数。
4. 递减；仅当该回合 `stopReason === "toolUse"`（还会继续）且计数 `<= 0` 时触发。
5. 触发后复位为 `intervalTurns`。

## 注入通道

触发时发一条 custom 消息：`customType: "loop-reflection"`、`display: false`、`deliverAs: "steer"`（在下一个 step 边界插入，不打断进行中的工具批次）。

不用可见用户消息，因为 omp 会给 `steering: true` 的**用户**消息套上「用户在工作途中打断」的信封——插件插话时那是假话。custom 消息在 provider 侧落成 `developer` 角色（Anthropic 在支持中途系统消息时升格为 `system`）；不支持该角色的端点（如自定义 `openai-completions` 代理）会降级为 `user`，但仍不会被包成打断信封。理由与后果见 [ADR 0006](../../docs/adr/0006-reflection-developer-channel.md)。

提醒总追加在对话尾部，已有前缀不变，提示词缓存不受影响。

## 与 pi 原版的差异

- **第 3 步从「调用 `advisor`」改为「问用户」**：omp 的 advisor 是被动审阅子系统，模型够不着。
- **删掉结尾「用一两句话说明判断依据」**：那是在要求模型再自证一轮，对过度思考是反向的。
- **开头点明实际回合数**（`turns="N"` 与正文）：事实优于空泛口号。
- 通道从可见 user 消息改为隐藏 custom 消息，可见性由 toast + 会话条目承担。
- 新增 `enabled` 与模型门控；配置文件名改为 `cnife-loop-reflection.json`；默认间隔 15 保持不变。删除状态栏显示与 `agent_end` 重置，`session_tree` 保留。
- 原版触发后把计数设为 `interval + 1`（因为递减发生在触发回合之前）；这里按 spec 直接复位为 `interval`。

## 验证

```bash
bun test plugins/loop-reflection   # 纯逻辑单测（配置解析 / 门控 / 计数归约）
bun run smoke                      # 以 -e 真加载入口：看 stderr 无 "Failed to load extension"
```

真机验证（本机）：主会话连续跑工具回合，toast 出现、会话 JSONL 有 `{"type":"custom","customType":"loop-reflection"}` 与 `{"type":"custom_message","customType":"loop-reflection","display":false}` 两条记录、transcript 不渲染提醒。
