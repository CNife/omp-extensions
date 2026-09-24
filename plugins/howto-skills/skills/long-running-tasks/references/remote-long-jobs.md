# 远端长任务

所有权在远端。本地只做三件事：起作业、取证据、收尾。

下文 `host` 指配置好的 ssh 别名，`j` 指你给这次作业取的名字——它同时是 tmux 会话名（`-t j`）与文件名前缀（`/tmp/j.log`、`/tmp/j.exit`、`/tmp/j.done`）；命令里的构建目标、路径、时长都是本次任务的载荷，按任务替换。

## 起

形状是「外层单引号 + 内层双引号」：单引号把整条远端命令原样交给 ssh，双引号把一段载荷整体交给 tmux，由远端的 shell 执行。

```bash
ssh host 'tmux new -d -s j "cd /srv/app && nice -n 19 make -j16 > /tmp/j.log 2>&1; echo done > /tmp/j.done; tmux wait-for -S j.done"'
```

`cd /srv/app && nice -n 19 make -j16` 是本次载荷，换成你的任务；末尾 `echo done > /tmp/j.done; tmux wait-for -S j.done` 是交棒，照抄——前者是判决书，后者是叫醒。退出码不在这一层写：双引号里的 `$?` 会被远端 shell 在起作业时就展开成 0，它属于脚本。

载荷不止一行就先落脚本（`write ssh://host/tmp/j.sh`），脚本收尾写 `echo $? > /tmp/j.exit; echo done > /tmp/j.done; tmux wait-for -S j.done`，再让 tmux 起脚本——省掉引号套引号，长 `sleep` 也留在脚本里（本机 `no-long-sync-sleep` 拦的是命令行上的超长 `sleep`）：

```bash
ssh host 'tmux new -d -s j "sh /tmp/j.sh"'
```

没装 tmux 的机器上，同一份脚本换 `setsid nohup` 起（少一层会话，也就没有 `capture-pane` 与 `send-keys`）：

```bash
ssh host 'setsid nohup sh /tmp/j.sh > /tmp/j.log 2>&1 & echo launched'
```

pid 让脚本自己写（`echo $$ > /tmp/j.pid`）：`$!` 拿到的是 setsid 的中间进程，作业控制开着时它当场就退出。

两种起法都立刻返回；日志、pid、退出码都落在远端文件，不从连接里捞。

## 取证据

- **判决书是标记文件**：`/tmp/j.exit`（退出码，脚本写）与 `/tmp/j.done`。
- **叫醒用 `wait-for`**：作业里 `tmux wait-for -S j.done`，本地 `bash {command:"ssh host 'timeout 900 tmux wait-for j.done'", async: true}`——一次调用、退出码即答案，不排 sleep。会话或服务退出会让 `wait-for` 报错退出，这时回看标记文件；降级路径直接看标记文件。
- **日志**：`read ssh://host/tmp/j.log`、`grep 'pattern' ssh://host/tmp/j.log`；大日志先 `tail -c`/`wc -l` 缩小再取，超 1 MiB 就远端压缩再取，或 `sshfs` 挂载后当本地文件处理。
- **进程内状态与交互**：`tmux capture-pane -p -t j` 看当前屏幕（替代不了日志）、`tmux has-session -t j` 判会话还在不在（命令结束会话即消失）、`tmux send-keys -t j …` 应答作业的交互提问。
- **产物**：写在远端路径；要落本地才 `rsync`，或 `write ssh://host/path` 回写。

## 收尾

`tmux kill-session -t j`；降级路径按 `/tmp/j.pid` 确认已退。远端不留会话、不留等待器。

## 连接

omp 的 `ssh://` 自带主连接复用（`ControlMaster=auto` + `ControlPersist=3600`），反复读同一个远端日志不会反复握手；`bash` 里手写的 `ssh` 没有这层，要复用自己加 `-o ControlMaster=auto -o ControlPath=… -o ControlPersist=1h`。`bash {name}` 托管的 ssh 客户端只管**本地**那一侧：本地侧由项目 broker 维持（默认 `session` 档活到 broker 空闲；`persist` 活过 omp，`detached` 活过 broker）。连接断开后，**远端**子进程的生死由远端会话决定——sshd 对断连发不发 SIGHUP 是远端的处置，本地不替它 detach，远端仍要 tmux 或 `setsid nohup` 自救。
