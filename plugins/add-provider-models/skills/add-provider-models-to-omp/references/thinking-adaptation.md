# Thinking 适配参考

在这些情况读取本文件：

- provider 文档只描述 bool 或 budget；
- `models.yml` 的 thinking 字段触发 schema 错误；
- capture 中的 thinking wire 参数与预期不一致。

## 三层合成

1. **Provider 机制**：端点通过 `api` 和 `thinkingFormat` 接收什么参数，查 `omp://models.md` 的 thinking 适配说明。
2. **模型能力**：模型是否推理、支持哪些 ON 档，取对应 provider 的模型文档。
3. **OMP 处理**：

   `ThinkingLevel → Effort|undefined → clamp → wire-map → provider 请求`

`compat.reasoningEffortMap` 只在 OMP 档位与端点字符串不一致时设置；没有重映射时使用 identity。

## 配置决策

- 模型有 OMP 可识别的命名 ON 档：设置 `thinking.efforts`。
- 模型只给 bool 或 budget：先按 OMP 适配层找到实际 wire 形态，再配置模型条目。provider API 的 `thinking_budget` 等字段不是 `models.yml` 字段的同义词。
- 当前 OMP 自定义模型 schema 的 thinking 入口以 `efforts` 为准；`mode: budget` 这类 provider 风格写法先经过 schema 校验。
- `openai-completions` 使用 `compat.thinkingFormat` 选择发送形态；Qwen 形态实际发送顶层 `enable_thinking`。
- ON 档写入 `thinking.efforts`；关闭信号由 OMP 运行时按 `thinkingFormat` 生成。

## 调查顺序

先读 OMP 内置文档并运行 `omp models <provider>`。只有出现 schema 错误或实际 wire 与文档不一致时，才检查本地运行时代码；不要把运行时源码调查当成每次添加模型的前置步骤。
