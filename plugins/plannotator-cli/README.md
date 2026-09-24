# plannotator-cli

基于 [Plannotator](https://github.com/backnotprop/plannotator) 的浏览器审阅/标注，为 OMP 注入三个斜杠命令。

直接调用 `plannotator` CLI 二进制（CLI shell-out），不依赖 `@plannotator/pi-extension` npm 包：
官方扩展用 `deliverAs: "followUp"` 投递反馈，在 omp 上只入队不启动回合（反馈断链）；CLI 方案
反馈直接经 `pi.sendUserMessage` 发送，无 npm 依赖、无 HTML 资产、无进程内 server。

## 前置条件

安装 `plannotator` 命令行工具（≥ 0.25.1，建议最新）：

```bash
# macOS / Linux / WSL
curl -fsSL https://plannotator.ai/install.sh | bash
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `/pnr [url]` | 在浏览器中审阅本地 git 变更，或传入 GitHub PR / GitLab MR URL |
| `/pna <path>` | 在浏览器中标注 Markdown 文件、文件夹或 URL（HTML 文件按原始渲染） |
| `/pnl` | 弹出终端选择列表，标注当前会话中最近的一条 AI 消息（最多 25 条，默认光标在最新一条） |

在浏览器中标注后，反馈作为用户消息直接发回 agent（立即触发处理回合）；无反馈时仅通知关闭。

`/pnl` 先弹出会话内最近 25 条 AI 消息的选择列表：默认光标停在最新一条（直接回车 = 旧行为），
Esc 取消则什么都不发生，只有一条可选消息时不弹列表。宿主没有 UI 时（`hasUI` 为 false 的模式）
直接报错，不会静默退化成“标注最后一条”；`rpc` 模式由客户端接管选择器。浏览器里标注的仍是被
选中的那**一条**消息（不新增多选/多文档形态）。反馈会附加说明前缀（“这是对你上一条助手消息的
标注反馈”；选更早的消息时为“这是对倒数第 N 条助手消息的标注反馈”），因为标注载体是会话内消息、
反馈本身不含文件名，不加说明会让 AI 困惑“文件在哪”。

## 安装

```bash
/marketplace add CNife/omp-extensions
/marketplace install plannotator-cli@omp-extensions
```

## 实现说明

- `/pnr` → `plannotator review [url]`（stdout 为纯文本反馈）
- `/pna` → `plannotator annotate <target> --json`（解析决策 JSON 提取 `feedback`；文件夹自动
  扫描，HTML 不传 `--markdown` 即原始渲染，URL 直接抓取）
- `/pnl` → 先用 `ctx.ui.select` 列出当前会话分支上最近 25 条非空 assistant 消息（选项
  `倒数第 N 条 · 首行摘要` + 字符数），选中项内容经 stdin 传给
  `plannotator annotate-last --stdin --json`（无临时文件）

进程非阻塞：命令立即返回，浏览器关闭后异步将反馈发回 agent。

## 稳健性设计

依据 [deadlock 复测报告](../../docs/research/plannotator-deadlock-v0.26.7.md)（wayfinder #43/#44）：

1. **spawn 必设 `BROWSER=none PLANNOTATOR_BROWSER=none`**：v0.26.7 存在罕见（~1-3%）关闭期挂起
   （stdout 已写完整 JSON 但进程不退出），全部出现在未抑制浏览器（WSL2 `cmd.exe /c start`）的
   运行中；抑制后 0/89 次挂起。
2. **stdout JSON 完整即成功**：`/pna` `/pnl` 读到完整决策 JSON 立即投递反馈并回收进程，不等
   `exited`，残余挂起对用户体验零影响。
3. **超时兜底**：默认 30min（环境变量 `PLANNOTATOR_FEEDBACK_TIMEOUT_MS` 可覆盖），到点 kill
   进程；若 stdout 已有内容仍投递，否则通知用户重试。
4. **`PLANNOTATOR_AI=disabled` 默认注入**：避免 CLI 派生嵌套 `pi --mode rpc` 子进程（AI 模型
   发现探针）；用户显式设置 `PLANNOTATOR_AI` 时尊重用户值。

## 测试

```bash
cd plugins/plannotator-cli && bun test
```

用 stub CLI 替换真实二进制，覆盖：命令注册、参数构造、路径归一化、stdin 内容、消息选择器
（选项构造、选中项 → stdin 映射、取消、单条跳过、非交互报错）、spawn 环境强制项、反馈直接
投递（无 deliverAs）、json 完整即投递、超时兜底、错误与无反馈通知。
