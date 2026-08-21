---
name: write-ttsr
disable-model-invocation: true
description: 编写/完善 TTSR 规则：意图确认 + 多轮多角度测试的完整流程。用户要求写规则、修规则、验证规则时手动调用。
---

# Write TTSR

把"写一条 TTSR 规则"做成带意图确认与多轮测试的完整流程，补上 `/omfg` 的两块短板：不确认意图、不充分测试。

## 定位

- **本技能是 OMFG 的增强层**：用技能流程替代 `/omfg` 的生成（意图确认先行、测试驱动收敛），而非依赖 `/omfg`。
- 规则文件写好后**下次会话生效**（本技能无法像 `/omfg` 那样实时注册进当前会话的 TtsrManager）——定稿时明确告知用户。
- 深度语义（astCondition、生命周期、分桶细节）查 `omp://ttsr-injection-lifecycle.md` 与 `omp://rulebook-matching-pipeline.md`，本技能不复述。

## 流程

### 1. 确认意图（先于任何生成）

用对话方式逐项确认，每项确认后再问下一项；用户跳过某项时采用默认值并记录：

1. **冒犯行为**——要防的具体行为模式（一句话可复述）。这是生成的核心输入。
2. **场景**——发生在哪个流？工具流（哪个工具、什么文件类型，如 `tool:write(*.ts)`）还是文本/思考流？还是两者？**默认：具体工具 + 文件类型，不用裸 `tool` 或 `text`**。
3. **中断性**——要阻止执行（`interruptMode: tool-only` / `always`）还是事后提醒（`never`）？**默认：`never`（警告不中断）**。注意：`never` 不阻止工具执行——要阻止必须显式选中断模式。
4. **保存层级**——项目 `.omp/rules/` 还是全局 `~/.omp/agent/rules/`？**默认：项目**。
5. **与现有规则关系**——是否已有同名规则（决定覆盖或改名）？是否与 `ttsr.disabledRules` / `ttsr.builtinRules` 冲突？**默认：无冲突，用新名字**。

确认完成后，向用户复述意图清单，确认后才进入第 2 步。

### 2. 起草规则

生成 frontmatter + 正文的 Markdown 文件，参照 `omfg-user.md` 的输出契约，但**补上契约没覆盖的三项**：

- `scope`：第 1 步确认的具体工具 + 文件 glob（`tool:edit(*.ts)` 形态）。
- `interruptMode`：第 1 步确认的取值（`always` / `prose-only` / `tool-only` / `never`）。**必写**——缺省时跟随全局 `ttsr.interruptMode`（默认 `always`），可能违背用户意图。
- 正文：正面描述正确行为（"Use X"）而非只写禁止（"Don't do Y"），给出 Avoid/Use 示例。

已知陷阱（写规则时自查，勿踩）：

- `condition` 写成文件 glob（如 `*.rs`）会被自动改写成 `tool:edit(*.rs), tool:write(*.rs)` + 通配条件 `.*`——想要"匹配某文件类型的工具流"应显式写 `scope`。
- frontmatter 里的 `name` 字段对规则**无效**——规则名取自文件名，文件名必须与规则名一致。
- 规则文件无 frontmatter 也能加载，但 `description` 缺失会进不了规则书、`condition` 缺失则完全不是 TTSR 规则。
- 正则要容忍工具参数流式传输的 JSON 转义（引号、反斜杠）。
- 一个规则对应一个冒犯行为；不同行为拆多条规则。

### 3. 多角度测试（核心环节）

先确认规则可被加载，再按测试矩阵逐项验证：

```bash
# 确认注册（能看到 condition/scope 即注册成功）
omp ttsr list
# 单规则隔离测试（不依赖项目其他规则）
omp ttsr test --rule <规则文件> --source tool --tool <工具> --path <示例路径> '<用例>'
# 文件扫描（可选：仓库现有代码是否会被误触发）
omp ttsr scan [目录]
```

**测试矩阵**（每条规则必须全部通过；任一失败进入第 4 步迭代）：

| 维度 | 构造原则 | 代表性命令 |
| --- | --- | --- |
| 正例-裸形态 | 冒犯行为的最简形态 | `omp ttsr test --rule <文件> --source tool --tool bash 'sleep 100'` |
| 正例-真实形态 | 冒犯行为的运行时包装：**JSON 参数**（`{"command":"…"}`）、命令链（`a && sleep 100`）、`bash -c` 包装、转义引号 | `omp ttsr test --rule <文件> --source tool --tool bash '{"command":"sleep 100"}'` |
| 负例-提到 | 文本里出现冒犯片段但不是执行（`grep "sleep 100"`、`echo 'sleep 2m'`） | `omp ttsr test --rule <文件> --source tool --tool bash 'grep "sleep 100" x.md'` |
| 负例-邻近 | 相似但不越界：短值（`sleep 99`）、小数（`sleep 0.100`）、其他上下文 | `omp ttsr test --rule <文件> --source tool --tool bash 'sleep 30'` |
| 边界 | 阈值两端（`99` vs `100`）、单位后缀（`2m`、`1h` 等价于长秒）、scope 外工具 | `omp ttsr test --rule <文件> --source tool --tool bash 'sleep 2m'` |

用例的"冒犯片段"替换为当前规则的实例；没有天然正例的规则（如纯文本规则）按上述维度用等价形态构造。

### 4. 迭代收敛

测试失败 → 诊断是 condition（漏报/误报）还是 scope（范围错）→ 修改规则文件 → 重跑第 3 步全矩阵。**上限 ≤3 轮**；超限**暂停**，向用户报告：当前矩阵结果、已尝试修改及效果、待排查问题，由用户决定继续或放弃。

### 5. 定稿

- 展示最终规则全文 + 保存路径 + 测试矩阵结果。
- 明确告知：**下次会话生效**（当前会话不实时注册）。
- 完成后可提示用户用 `/extensions` 查看规则、`/settings` 调 `ttsr.*` 全局参数。

---

**完成标准**：意图 5 项已确认并复述；规则文件已写入指定层级；测试矩阵全维度通过（或 ≤3 轮内收敛）；用户已被告知生效时机。
