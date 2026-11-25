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

输入 `/inject-skills` 打开 omp 原生勾选列表（`ctx.ui.select`，行多时自带 `Type to search`）：

- `↑↓` 导航
- 直接打字搜索技能名
- `Enter` 勾选/取消 `enabled` / `disabled`（即时保存；列表重开并回到刚切的那一行）
- `Esc` 或末尾 `Done selecting` 行关闭

语义：

- `enabled` = 注入到系统提示词
- `disabled` = 不注入

列表按技能名字母序排列。切换后下一条消息即生效，无需重载。

配置里登记过、但当前会话未加载的技能，也会以 `名字 (not installed)` 出现在列表里（与已装技能字母序混排），value 显示 `disabled`。把它切到 `enabled` 即从配置删除该登记项；该行保留到下次打开菜单才消失（用于清理卸载/改名后残留的配置项）。

每次启动会话时，扩展会用英文 notify 列出三类技能（名字母序 + 数量；空类列表位写 `0`）：

```text
Skills injection
injected (N): a, b
forbidden (0): 0
non-injectable (K): z
```

- `injected`：会注入系统提示词
- `forbidden`：用户在 `/inject-skills` 里 disabled 的
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

2. **`/inject-skills` 命令**：omp 原生的 `ctx.ui.select` 勾选列表（`selectionMarker: "checkbox"`，勾选 = 注入；行多时自带 `Type to search`）。切换即时写配置；每次 Enter 关掉再按新状态重开，光标回到刚切的那一行；`Esc` 或末尾 `Done selecting` 行关掉。行集 = 已加载非 hide 技能 ∪ 配置里登记但未加载的名字（`buildMenuItems`，字母序混排；后者 label 加 `(not installed)`）。

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
| 配置里有但当前会话未加载 | 以 `名字 (not installed)` 列入菜单（字母序混排），可 toggle 清除该登记项 |
| 无 `<skills>` 段（如无 `read` 工具） | 不修改，静默跳过 |

### 生效时机

`before_agent_start` 在每次用户发消息时触发，每次重新读配置文件。所以 `/inject-skills` 保存后，**下一条消息**就按新配置注入。重启 omp 后同样读配置文件生效。

## 测试

纯逻辑（`parseConfig` / `filterSkillsSection` / `summarizeSkills` / `formatStartupSummary` / `buildMenuItems` / `formatSkillLabel`）在 `test/skills-logic.test.ts`，零运行时 omp 依赖，独立可测：

```bash
cd plugins/skills-injection && bun test  # 或 node --test --experimental-strip-types
```
