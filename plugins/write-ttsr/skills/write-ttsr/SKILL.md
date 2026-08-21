---
name: write-ttsr
disable-model-invocation: true
description: 动态对齐意图并用多角度测试收敛 TTSR 规则。
---

# Write TTSR

独立完成 TTSR 规则的意图对齐、编写与测试。

## 流程

### 1. 对齐意图

维护以下意图清单：

- **冒犯行为**：要捕获的一个具体行为模式。
- **匹配场景**：`text`、`thinking`，或具体工具及文件 glob，如 `tool:write(*.ts)`。
- **中断方式**：`always`、`prose-only`、`tool-only` 或 `never`。
- **保存层级**：项目 `.omp/rules/` 或全局 `~/.omp/agent/rules/`。
- **现有规则关系**：新建、覆盖或改名。

先从用户原话填写已知项；用工具查事实；仅向用户询问仍未解决的决定。每轮一次问完当前已知前提下能回答的问题，得到答案后重新检查清单。

根据冒犯行为拟定 kebab-case 规则名，然后检查现有规则与禁用名单：

```bash
omp ttsr list --json
omp config get ttsr.disabledRules --json
```

仅在候选名已存在或被禁用时，请用户决定覆盖、改名或调整设置。用户明确跳过某项时采用并记录默认值：具体工具与文件 glob、`never`、项目层级、新名字。

**完成条件**：五项意图均已确定；候选规则名及完整清单已复述并经用户确认。

### 2. 编写规则

文件名是规则名；写入 `<保存目录>/<kebab-case-name>.md`，frontmatter 使用以下四个字段：

```markdown
---
description: <一行摘要>
condition: <JavaScript 正则字符串或字符串数组>
scope: <匹配流字符串或字符串数组>
interruptMode: <always|prose-only|tool-only|never>
---

<简洁说明正确行为，并给出必要的 Avoid/Use 示例>
```

- `condition` 精确匹配冒犯行为，并能处理实际工具参数中的 JSON 转义。
- `scope` 使用第 1 步确认的最窄范围；文件类型约束只放在 `scope`。
- 一个规则只处理一个冒犯行为；不同行为拆成不同规则。
- 正文以正确行为为中心，说明替代做法。

写入后读回文件，逐项核对路径、文件名、四个 frontmatter 字段与正文。

**完成条件**：规则文件已写入确认的路径，读回内容符合上述契约和意图清单。

### 3. 验证规则

先确认项目实际注册的是刚写入的文件，且规范化后的 `condition` 与 `scope` 正确：

```bash
omp ttsr list --json
```

再用当前规则的真实 source、tool 和 path 运行隔离测试：

```bash
# 工具流
omp ttsr test --json --rule <规则文件> --source tool --tool <工具> --path <示例路径> '<用例>'
# 文本或思考流
omp ttsr test --json --rule <规则文件> --source <text|thinking> '<用例>'
```

以 JSON 中的 `triggered` 判定结果：正例包含当前规则名才通过；负例为空才通过。每个维度选择一个最有代表性的用例，边界维度使用一对分界两侧的断言：

| 维度 | 构造原则 | 期望 |
| --- | --- | --- |
| 正例-裸形态 | 冒犯行为的最简形态 | TRIGGER |
| 正例-真实形态 | 当前流中风险最高的实际包装，如 JSON 参数、命令链或转义 | TRIGGER |
| 负例-提到 | 提到冒犯片段但没有执行该行为 | NO_TRIGGER |
| 负例-邻近 | 相似但允许的行为 | NO_TRIGGER |
| 边界 | 一对相邻输入：允许侧与冒犯侧；也可使用 scope 内外作为分界 | NO_TRIGGER / TRIGGER |

记录每个用例的 source、tool、path、输入、期望与实际结果。需要检查仓库现有文件的误报时，补跑 `omp ttsr scan [目录]`。

**完成条件**：静态读回与注册结果一致，矩阵中每个实际结果都等于期望。

### 4. 迭代收敛

首次完整矩阵算第 1 轮。失败时判断问题来自 `condition`、`scope` 或测试上下文，修改规则后重跑完整矩阵；最多运行三轮。

第 3 轮仍失败时暂停，报告当前矩阵、每轮修改及效果、剩余问题，交由用户决定继续或放弃。

**完成条件**：完整矩阵通过，或第三轮失败报告已交付并暂停。

### 5. 定稿

矩阵通过后展示最终规则全文、保存路径和矩阵结果，并明确告知用户：规则在下次会话生效，当前会话不会实时注册。可提示用 `/extensions` 查看规则、用 `/settings` 调整 `ttsr.*` 参数。

**完成条件**：最终文件与测试证据已展示，生效时机已说明。

深度语义（astCondition、生命周期、分桶与优先级）按需查 `omp://ttsr-injection-lifecycle.md` 和 `omp://rulebook-matching-pipeline.md`。
