# ime-switch：探索结论（不做）

> 地图：[Wayfinder map: ime-switch —— omp 触发 Windows 输入法自动切换](https://github.com/CNife/omp-extensions/issues/49)
> 日期：2026-08-14。结论：通路能走通，插件价值不够，整张地图关闭。

## 结论

**不做。** 不写实现规格，不进 marketplace，不把原型合进 main。

目的地是：空框按「、」/「！」时把 Windows 输入法切到英文，并写成 `/` / `!`。原型已经在本机 omp + 微信输入法上按通。停下来不是因为技术走不通，是因为要维持这条通路，必须常驻一个 Windows daemon（分发、自启、升级、卸载），换来的只是少按一次 Ctrl+空格——不值。

## 不要做什么

- 不要实现正式 `ime-switch` 插件。
- 不要把 [`prototype/ime-switch`](https://github.com/CNife/omp-extensions/tree/prototype/ime-switch) 合进 main。
- 不要重开这张地图，除非目的地重画（例如「接受 50–150ms、不要常驻进程」或价值判断反过来）。
- 不要重开已关的纸上决策票：[决策：扩展侧触发策略](https://github.com/CNife/omp-extensions/issues/54)、[决策：daemon 部署与生命周期](https://github.com/CNife/omp-extensions/issues/56)、[研究：微信输入法上 WM_IME_CONTROL 幂等设英文是否可用](https://github.com/CNife/omp-extensions/issues/57)。

## 已证实（以后别重研）

环境：WSL2 Arch → Windows 11；单布局 `00000804`；日常 IME 是**微信输入法**（不是微软拼音）；Ctrl+空格 = 中/英开关。

| 事实 | 出处 |
|---|---|
| 「、」「！」在微信输入法中文模式下直接上屏，无候选窗 | [任务：真实键盘验证「、」「！」直接上屏](https://github.com/CNife/omp-extensions/issues/53) |
| 幂等设英文：`WM_IME_CONTROL` 0x0006 发前台默认 IME 窗口（`ImmGetDefaultIMEWnd`）。IMM32 直调 / TSF profile / 注册表均不可行。SendInput Ctrl+空格只配合作废主路径的兜底，原型未试 | [研究：Windows IME 中/英模式的查询与幂等设置 API](https://github.com/CNife/omp-extensions/issues/50)（查询侧在微软拼音上测）；微信输入法设置侧由原型 7/7 确认 |
| WSL 调不了 Win32。一次性 exe / cmd / powershell 地板 50–155ms，破 <100ms 预算。唯一进预算的形态是 Windows 常驻进程 + TCP `127.0.0.1` fire-and-forget（中位 0.19ms）。死端口必须 ≤100ms 超时，否则 SYN 挂约 2 分钟 | [研究：WSL→Windows 低延迟切换通道](https://github.com/CNife/omp-extensions/issues/51) |
| `onTerminalInput` 先于编辑器；`getEditorText()` 同步安全；dialog 期间按键仍流过且接口无焦点状态。v1 用空框 `trim` + `ctx.isIdle()` 即可 | [研究：omp 扩展输入拦截与编辑器/overlay 状态检测](https://github.com/CNife/omp-extensions/issues/52) |
| 空框「、」/「！」写成 `/`/`!` 并切英文。扩展 `console.error` / 直打 stderr 会打乱 TUI，只写文件日志 | [原型：端到端趟通「、」→切英文并写入 /](https://github.com/CNife/omp-extensions/issues/58) |

研究全文（未合 main）：

- `research/ime-api` → `docs/research/ime-switch-api.md`
- `research/ime-channel` → `docs/research/ime-switch-channel.md`
- `research/ime-intercept` → `docs/research/ime-switch-intercept.md`

原型代码：[`prototype/ime-switch`](https://github.com/CNife/omp-extensions/tree/prototype/ime-switch) @ `544c45a`，`plugins/ime-switch/`（标 PROTOTYPE）。通道是 `127.0.0.1:19581` 单字节 `0x01`。

## 未拍板（也不再拍）

daemon 分发、落点、版本替换、自启动、卸载，以及协议要不要握手，都还在雾里。价值不够，不值得再 grilling。
