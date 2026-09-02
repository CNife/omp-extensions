# playbooks

playbook 技能合集：把跨场景复用的打法固化为技能，按需加载。

## 技能

| 技能 | 说明 | 触发 |
| --- | --- | --- |
| [browser-guide](skills/browser-guide/SKILL.md) | omp browser 数据提取打法：数据接口优先、滚动/翻译/tab 处理、能力分层 | 模型主动加载 |
| [write-ttsr](skills/write-ttsr/SKILL.md) | TTSR 规则编写：动态意图对齐 + 多轮多角度测试收敛 | `/skill:write-ttsr` |
| [add-provider-models](skills/add-provider-models/SKILL.md) | 给 OMP provider 加模型的流水线：取参→适配→写入→四维验证 | `/skill:add-provider-models` |

## 目录

- `extensions/capture.ts`：调试脚本，不在启动时注册；由 add-provider-models 技能经 `--extension` 显式加载，抓取 omp 实际请求/响应做请求级验证。