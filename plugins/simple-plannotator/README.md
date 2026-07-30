# simple-plannotator

基于 [Plannotator](https://github.com/backnotprop/plannotator) 的浏览器审阅/标注，为 OMP 注入三个斜杠命令。

直接调用 `plannotator` CLI 二进制，不依赖 `@plannotator/pi-extension`，规避 Pi/OMP 包作用域不兼容问题。

## 前置条件

安装 `plannotator` 命令行工具：

```bash
# macOS / Linux / WSL
curl -fsSL https://plannotator.ai/install.sh | bash

# Windows PowerShell
irm https://plannotator.ai/install.ps1 | iex
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `/pnr [url]` | 在浏览器中审阅本地 git 变更，或传入 GitHub PR / GitLab MR URL |
| `/pna <path>` | 在浏览器中标注 Markdown 文件、文件夹或 URL |
| `/pnl` | 标注当前会话中最后一条 AI 消息 |

在浏览器中标注后，反馈作为 follow-up 消息发回 agent；无反馈时仅通知关闭。

## 安装

```bash
omp plugin link ./plugins/simple-plannotator
```

或通过 marketplace 远程安装：

```
/marketplace add CNife/omp-extensions
/marketplace install simple-plannotator@omp-extensions
```

## 实现说明

- `/pnr` → `plannotator review [url]`
- `/pna` → `plannotator annotate <path>`
- `/pnl` → 从 OMP 会话提取最后一条 assistant 消息，写入临时 `.md` 文件后调用 `plannotator annotate <tmpfile>`（`plannotator last` 无法识别 OMP 会话日志格式，故走此路径）

进程非阻塞：命令立即返回，浏览器关闭后异步将反馈发回 agent。
