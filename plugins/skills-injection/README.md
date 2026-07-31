# skills-injection

交互式控制哪些技能被注入到 omp 的系统提示词（`<skills>`），持久化配置。

## 解决的痛点

omp 启动时会加载所有已安装技能（`~/.omp/agent/skills/`、`.agents/skills/` 等），并把它们的名称与描述以 `<skills>` 列表注入系统提示词。技能一多，系统提示词变长、占用上下文、干扰模型注意力，但用户无法 selectively 关闭某些技能的注入。

本扩展让用户交互式开关技能注入，配置持久化，下一条消息即生效。

> 从 `@cnife/pi-skills-injection` 移植；适配 omp 的技能段格式与扩展 API，效果与原插件相同。

## 安装

本机部署（开发）：

```bash
omp plugin link ./plugins/skills-injection
```

远程安装：

```
/marketplace add CNife/omp-extensions
/marketplace install skills-injection@omp-extensions
```

## 使用

输入 `/skills-injection` 打开设置列表（与 `/settings`、`/tools` 同款交互）：

- `↑↓` 导航
- 输入字符模糊筛选技能名
- `Space` / `Enter` 切换 `enabled` / `disabled`（即时保存）
- `Esc` 关闭

语义：

- `enabled` = 注入到系统提示词
- `disabled` = 不注入

列表按技能名字母序排列。切换后下一条消息即生效，无需重载。

每次启动会话时，扩展会用英文 notify 列出三类技能（名字母序 + 数量；空类列表位写 `0`）：

```text
Skills injection
injected (N): a, b
forbidden (0): 0
non-injectable (K): z
```

- `injected`：会注入系统提示词
- `forbidden`：用户在 `/skills-injection` 里 disabled 的
- `non-injectable`：`disable-model-invocation`（omp 归一化为 `hide`），本身不进系统提示词（TUI 列表不展示）

## 配置

配置文件：`~/.omp/agent/cnife-skills-injection.json`

```json
{
  "excluded": ["skill-name-1", "skill-name-2"]
}
```

`excluded` 是内部存储（disabled 的技能名）。也可手动编辑此文件，下一条消息生效。

## 技术实现

三个部分：

1. **`before_agent_start` 拦截**：读取配置，从 `event.systemPrompt`（omp 为 `string[]`）中匹配 `<skills>` 块，删除被排除技能对应的 `- name: description` 行。每 turn 读配置文件，所以下一条消息即生效。无需 `formatSkillsForPrompt`：omp 的技能段已是纯文本列表，按名删除即可。

2. **`/skills-injection` 命令**：`ctx.ui.custom()` + `DynamicBorder`（border 色，对齐 `/settings`）+ `SettingsList`，`enableSearch` 做名称模糊筛选。切换即时写配置。技能列表与启动通知同源（见下）。

3. **`session_start` 通知**（与命令共用 `resolveSkills`）：
   - 技能名单与 `hide` 标志直接取自 omp 导出的 `loadSkills({ cwd })`（omp 已从 frontmatter 归一化 `disable-model-invocation` -> `Skill.hide`，无需再读文件兜底）
   - 按配置分成 injected / forbidden / non-injectable，英文多行 `ctx.ui.notify`

### 边界情况

| 情况 | 处理 |
|------|------|
| 配置为空 / 无排除项 | `before_agent_start` 直接 return，不修改系统提示词 |
| 排除项未命中任何实际技能 | 不修改（避免无谓替换） |
| 所有技能都被排除 | 整个技能段（说明行 + `<skills>` 块）从系统提示词移除 |
| `disable-model-invocation` 技能 | omp 本就不注入 `<skills>`；命令列表中也不显示（排除它无意义） |
| 无 `<skills>` 段（如无 `read` 工具） | 不修改，静默跳过 |

### 生效时机

`before_agent_start` 在每次用户发消息时触发，每次重新读配置文件。所以 `/skills-injection` 保存后，**下一条消息**就按新配置注入。重启 omp 后同样读配置文件生效。

## 测试

纯逻辑（`parseConfig` / `filterSkillsSection` / `summarizeSkills` / `formatStartupSummary` / `sortSkillItems`）在 `test/skills-logic.test.ts`，零运行时 omp 依赖，独立可测：

```bash
cd plugins/skills-injection && bun test  # 或 node --test --experimental-strip-types
```

## 已知问题

skills-injection 插件的 `/skills-injection` 命令有两个视觉 bug，根因在 omp 框架而非插件本身，插件层无法干净修复：

1. **幻影 user message**：命令文本被渲染进对话、却从未发给模型（session JSONL 无对应记录），关闭 TUI 后仍残留。
2. **Working 闪烁**：自定义 TUI 显示期间，顶部状态行挂着 `⠏ Working…`，而非等待输入。

**根因**：omp 主 Enter 提交路径（`input-controller.ts`）对所有扩展命令无条件走 `startPendingSubmission`--先 `addMessageToChat`（echo）再 `ensureLoadingAnimation`（loader）。内置命令（`/tools`、`/settings`）在 `executeBuiltinSlashCommand` 即短路返回，不走此路径；扩展命令不在其中。`ctx.ui.custom`（`showHookCustom`）不清 loader；本地命令无模型 turn，`replaceOptimisticUserMessage` 不触发，故 echo 不被移除（`finishPendingSubmission` 只清引用、不 `removeChild`）。skills-injection 插件代码与官方范例 `examples/extensions/tools.ts` 结构一致。

**影响**：仅视觉，不影响功能——配置读写、`before_agent_start` 过滤均正常。

**修复方向**：改 omp 框架——主 Enter 路径对已知斜杠命令（`isKnownSlashCommand`）在 `startPendingSubmission` 前 `return`（仿队列消息路径 `#deliverQueuedMessage`），两个 bug 同时消失。
