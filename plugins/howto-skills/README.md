# howto-skills

how-to 技能合集：把跨场景复用的打法固化为技能，按需加载。

## 技能

| 技能 | 说明 | 触发 |
| --- | --- | --- |
| [browser-guide](skills/browser-guide/SKILL.md) | omp browser 数据提取打法：数据接口优先、滚动/翻译/tab 处理、能力分层 | 模型主动加载 |
| [write-ttsr](skills/write-ttsr/SKILL.md) | TTSR 规则编写：动态意图对齐 + 多轮多角度测试收敛 | `/skill:write-ttsr` |
| [provider-models-guide](skills/provider-models-guide/SKILL.md) | provider/model 配置指南：改动归层、取参来源、thinking 方言、五通道验证 | `/skill:provider-models-guide` |
| [long-running-tasks](skills/long-running-tasks/SKILL.md) | 长任务打法：定托管、定等待、取结果；含远端作业专项参考 | 模型主动加载 |

> 迁移提示：`add-provider-models` 已改名为 **`provider-models-guide`**（0.3.0），调用面改为 `/skill:provider-models-guide`。

## 目录

- `skills/provider-models-guide/scripts/echo-endpoint.py`：本地回显端点探针，供配置验证做请求级取证（契约见 issue #85）。

请求级验证不再依赖自建抓包扩展：原 `extensions/capture.ts`（摘要抓包、无 Authorization、日志未脱敏）已退役，改用内置 `PI_REQ_DEBUG=1` 与回显探针，见 provider-models-guide 的 `references/verification.md`。