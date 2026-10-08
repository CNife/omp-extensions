# ask-consultants

多模型顾问团：让多个不同模型的顾问对同一问题各自独立出意见，主模型权衡分歧、裁决出最终结论。

## 机制

- **命令 `/consultants`**：交互式选择成员（与 `/inject-skills` 同款设置列表）。候选为当前可用模型（`ctx.modelRegistry.getAvailable()`），`↑↓` 导航、字符模糊筛选、`Space`/`Enter` 切换、`Esc` 关闭；切换即时写入成员配置。配置里登记过、但当前会话不可用的成员以 `provider/id (not available)` 行保留在列表里，切回 `disabled` 即从配置移除。
- **命令 `/ask-consultants <评审对象>`**：读取成员清单，把成员组装成 `^provider/id` 模型标签投递。OMP 的代号机制（user-tagged model agents）将标签一步注册为会话级代号 m1、m2、…——代号对 task 工具可见、走隐藏 notice 通道、不破坏提示词缓存。注册顺序 = 配置里的书写顺序。
- **技能 `ask-consultants`**：把同一 brief（含顾问立场）并行派发给每个成员，成员互不可见、独立出报告，最后主模型以主位者身份汇总：给出权衡后的最终结论与成员分歧。

成员注册只能由用户触发（synthetic prompt 跳过代号注册），模型的职责是派发与汇总——准入权在人，使用权在模型。

> 场景限制：两条命令都需要交互式会话（TUI）。print/json 无头宿主里命令触发的后续回合无法存活，命令会明确报错；无头场景请在消息里直接用 `^provider/id` 标签点名成员。

## 配置成员

个人配置文件 `~/.omp/agent/cnife-ask-consultants.json`：

```json
{
	"members": ["openai-codex/gpt-6-sol", "ark-coding-plan/glm-5.3-flash"]
}
```

成员为**裸 `provider/id`** selector，不含 `^` 前缀（`^` 由 `/ask-consultants` 组装消息时拼接），也不含 effort 后缀——代号注册按 `provider/id` 精确匹配 selector，`openai-codex/gpt-6-sol:high` 这类写法不合法。

存在即生效——`members` 为空数组 = 明确清空成员清单、本次不派发；文件不存在才回退插件默认成员；JSON 写错时明确报错不派发（不会悄悄换成默认成员）。该文件不属于插件，不会被 `omp plugin upgrade` 冲掉。

> 0.2.0 起配置格式硬切换为裸 `provider/id`：含 `^` 前缀的 0.1.x 旧条目会让 `/ask-consultants` 明确报错，请用 `/consultants` 重新选择或手编配置。

## 安装

```
/marketplace add CNife/omp-extensions
/marketplace install ask-consultants@omp-extensions
```

## 为什么命令走扩展而不是清单 commands

omp 插件清单的 `commands` 键目前是死管道，清单声明的命令文件不会被加载。本插件的扩展负责：成员配置读写（`/consultants` 选择器 + `/ask-consultants` 派发）→ `sendUserMessage` 投递 `^` 标签——代号注册经用户消息路径生效（`expandMentions` 不受 `expandPromptTemplates: false` 影响）。取舍详见 [ADR 0004](../../docs/adr/0004-plugin-commands-dead-pipe.md)。

## 测试

纯逻辑（`SELECTOR_RE` / `parseMembers` / `invalidMembers` / `buildModelMenuItems` / `toggleSelected`）在 `test/consultants-logic.test.ts`，零运行时 omp 依赖，独立可测：

```bash
cd plugins/ask-consultants && bun test  # 或 node --test --experimental-strip-types
```
