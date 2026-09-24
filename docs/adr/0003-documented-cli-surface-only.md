# 只依赖 plannotator 的文档化 CLI 面

`/pnl` 要把「会话里最近的若干条助手消息」交给 plannotator，但 CLI 不解析 omp 的会话日志（`session-log.ts` 只认 Claude Code 与 Droid），而 `annotate-last --stdin` 只填 `lastMessage`、`recentMessages` 恒为空，所以浏览器端永远拿不到消息列表。能注入 `recentMessages` 的只有内部命令 `opencode-annotate-last`——它未进 `--help`、列在 `INTERNAL_SUBCOMMANDS`、origin 写死 `opencode`。因此不接内部面：消息选择器由插件自己做（宿主公开的 `ui.select` + 会话分支读取接口），选中的仍是单条消息，经 stdin 交给 `annotate-last --stdin`。

## 考虑过的选项

- **调内部桥 `opencode-annotate-last`**：体验最好（浏览器端原生多消息标注：消息 tab、每条消息独立标注、跨消息反馈），但该命令不在文档化面内，上游随时可改签名或移除；origin 写死 `opencode` 也只是在假装自己是别的宿主，一旦断裂还会连累 `/pnr` `/pna` 共用的 CLI 链路。
- **临时目录多文档**：一条消息一个文件，全部交给 `annotate`。文档化面内，代价是引入临时文件生命周期，以及「反馈里的文件名回指到哪条消息」的映射负担。
- **合并成单文档再标注**：同样在文档化面内，但要把多条消息拼成一份 markdown 并保证围栏/结构保真，拼接与还原都得额外验证。
- **选择器自绘**：宿主已提供 `ui.select`，自绘只是重复造轮子，还会跟宿主主题与键盘行为脱节。

## 后果

- `/pnl` 保持单条标注：选中哪条就把哪条送进浏览器，浏览器里的体验与改动前完全一致。反馈里的 `Feedback on: "<原文引用>"` 让「标注的是哪条消息」天然可辨，不需要额外元数据。
- 浏览器端的原生多消息标注拿不到。上游若真公开注入 `recentMessages` 的接口，届时另起新 effort，不在此续做。
- 插件保持零 npm 依赖：宿主侧只用公开的 `ui.select` / `hasUI` / 会话读取接口，不 import 宿主内部包；CLI 侧只用文档化子命令（`review` / `annotate` / `annotate-last`）。
- 宿主 `hasUI` 为 false 的模式下 `/pnl` 报错而非静默退化成「标注最后一条」；`rpc` 模式的宿主自带 UI，选择器经 `extension_ui_request` 转发给客户端，照常可用。
