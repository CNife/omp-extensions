---
name: long-running-tasks
description: 需要长时间运行的任务（长命令/构建/训练、长驻服务、远端 ssh 作业、子代理、外部作业）加载：定托管、定等待、取结果。
---

# 长任务

活跑得比一次工具调用久，就不再是「执行一条命令」，而是「安排一个任务」：**定谁负责它活着，定怎么知道它好了，把结果拿回来**。

## 托管：谁负责它活着

任务离开调用之后归谁，决定它怎么活、你去哪取证：

| 归属 | 谁在维持它 | 取证处 |
| --- | --- | --- |
| omp 进程 | `bash`/`eval` 的 job、子代理 | 结果自动投递；`read proc://` |
| 项目 broker | `bash {name}` 起的服务（默认 `session` 档随 broker 空闲关闭；`persist` 活过 omp，`detached` 活过 broker） | `read proc://<name>`、`grep proc://<name>` |
| 远端主机 | 远端自己的 tmux；缺 tmux 用 `setsid nohup` | `ssh://` 读日志与标记、`tmux capture-pane` |
| 外部系统 | 它自己 | 一次最短查询 |

## 决策表：按「等谁」选最小够用档

| 等谁 | 最小调用形 |
| --- | --- |
| 本地有限任务 | `bash {command, async: true, timeout: 0}` |
| 本地服务 / 长驻进程 | `bash {command, name, ready:{…}}` |
| 远端 ssh 作业 | `ssh host 'tmux new -d -s j "…"'`，取证走 `ssh://` |
| 可独立完成的一大块活 | `task` 批量，或 `eval` 里的 `agent()`/`workpool()` |
| 外部系统 | 一次最短查询（用退出码收敛），或挂 watcher job 交给投递 |
| 多个互不依赖的长任务 | 一次并行起多个 `async: true`，或 `workpool` |

长命令显式 `async: true`；`pty: true` 与客户端终端接管的前台命令不自动转后台，会等到 `timeout` 或你打断。机制语义（就绪判定、取证上限、超时上限）以 `omp://tools/bash.md`、`omp://tools/wait.md`、`omp://tools/write.md` 为准——`ready.log` 是 JS 正则、对最近 64 KiB 输出 buffer 整体匹配（`$` 只在 buffer 末尾成立，首匹配即锁存），PCRE 的 `(?i)` 会被拒。

## 等待

- **结果自己来，别去够**：job 与子代理的结果自动投递到你面前；只有完全没事可做时才 `wait`——它无参数，单次 30 分钟封顶后返回仍在跑的快照，再发一次即可。
- **等条件，不等时间**：盯退出码、日志行、端口、产物文件。**等它到** = watcher job（`until …` 条件满足即退出，投递叫醒；先定好看什么、间隔多少、最多几次）；**看一眼** = `grep proc://<name>` 搜活日志、`read proc://<name>` 看尾部；启动条件交给 `ready`，远端交给 `wait-for`。
- **等的时候留着身**：`wait` 遇到对等消息或 steering 会提前返回；被叫停就把任务留在后台，先答人再回来等。

## 收尾

- 结果取回并落到工作区；「我见过它一眼」不算取回。
- 进程有归宿：停掉（`write proc://<id>/kill`），或说清它活到什么时候（随 omp、随 broker、远端自己）。

作业还在跑时也能收工，代价是交代清楚：什么还在跑、结果从哪来、下次从哪看。

## 远端

远端作业的 tmux 用法、取证与收尾见 [`references/remote-long-jobs.md`](references/remote-long-jobs.md)。

等 vibe 的多会话 worker 用 `vibe_wait`。
