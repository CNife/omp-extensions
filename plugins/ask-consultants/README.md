# ask-consultants

多模型顾问团面板：让多个不同模型的顾问对同一问题各自独立出意见，主模型汇总对比。

## 机制

- **命令 `/ask-consultants <评审对象>`**：薄扩展读取成员清单，把 `^provider/id` 模型标签作为用户消息投递。OMP 的伪名机制（user-tagged model agents）将标签一步注册为会话级伪名 m1、m2、…——伪名对 task 工具可见、走隐藏 notice 通道、不破坏提示词缓存。
- **技能 `ask-consultants`**：把同一 brief（含顾问立场）并行派发给每个伪名成员，成员互不可见、独立出报告，最后按「共识 / 分歧 / 独有发现 / 建议」汇总。

成员注册只能由用户触发（synthetic prompt 跳过伪名注册），模型的职责是扇出与汇总——准入权在人，使用权在模型。

> 场景限制：`/ask-consultants` 需要交互式会话（TUI）。print/json 无头宿主里命令触发的后续回合无法存活，命令会明确报错；无头场景请在消息里直接用 `^provider/id` 标签点名成员。

## 配置成员

个人覆盖文件 `~/.omp/agent/consultants.md`：内容为若干行 `^provider/id` 标签（一行一个，`#` 注释行忽略）。存在即生效——没有任何标签 = 明确清空面板、本次不派发；文件不存在才回退插件默认成员。该文件不属于插件，不会被 `omp plugin upgrade` 冲掉。

selector 须精确匹配 `provider/id`，不含 effort 后缀（如 `openai-codex/gpt-6-sol:high` 应写 `^openai-codex/gpt-6-sol`）。

## 安装

```
/marketplace add CNife/omp-extensions
/marketplace install ask-consultants@omp-extensions
```

## 为什么命令走扩展而不是清单 commands

omp 插件清单的 `commands` 键目前是死管道（`resolvePluginCommandPaths` 无调用方，命令发现不扫插件根），清单声明的命令文件不会被加载。本插件的扩展只做一件事：读成员清单 → `sendUserMessage` 投递 `^` 标签——伪名注册经用户消息路径生效（`expandMentions` 不受 `expandPromptTemplates: false` 影响）。
