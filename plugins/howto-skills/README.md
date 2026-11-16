# howto-skills

how-to 技能合集：把跨场景复用的打法固化为技能，按需加载。

## 技能

| 技能 | 说明 | 触发 |
| --- | --- | --- |
| [provider-models-guide](skills/provider-models-guide/SKILL.md) | provider/model 配置指南：改动归层、取参来源、thinking 方言、五通道验证 | `/skill:provider-models-guide` |

> 迁移提示：`add-provider-models` 已改名为 **`provider-models-guide`**（0.3.0），调用面改为 `/skill:provider-models-guide`。

## 目录

- `skills/provider-models-guide/scripts/echo-endpoint.py`：本地回显端点探针，供配置验证做请求级取证（契约见 issue #85）。

请求级验证不再依赖自建抓包扩展：原 `extensions/capture.ts`（摘要抓包、无 Authorization、日志未脱敏）已退役，改用内置 `PI_REQ_DEBUG=1` 与回显探针，见 provider-models-guide 的 `references/verification.md`。

## 下线记录（0.3.2）

`browser-guide`、`long-running-tasks`、`write-ttsr` 已从本插件下线：内容随 omp 版本漂移（browser 默认引擎换成 WebKit、`wait` 改为空闲阶梯、TTSR frontmatter 扩展），且与内置文档重复。需要时直接读当前文档：

- 浏览器：`xd://eval/browser`、`omp://tools/browser.md`
- 长任务：`omp://tools/bash.md`、`omp://tools/wait.md`、`omp://tools/write.md`
- TTSR：`omp://ttsr-injection-lifecycle.md`、`omp://rulebook-matching-pipeline.md`，命令行 `omp ttsr --help`
