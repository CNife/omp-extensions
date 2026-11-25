# plannotator-cli 的摘要文本与子进程细节

`/pnl` 要把助手消息压成一行菜单标签；子进程链路的几个取舍也写在这里。

## 摘要按码点截断

`truncateSummary` 用 `Array.from` 取码点再切片。JS 字符串的 `slice` 以 UTF-16 码元计，emoji 是代理对，按 40 个码元切会留下半个代理对，渲染成乱码。菜单 `description` 的字符数同样按码点计。

## markdown 噪声只剥离有把握的部分

`stripMarkdownNoise` 去掉标题符号、链接/图片语法、`*` 与反引号；下划线只在词边界成对出现时（`_x_`）当强调剥离，否则会吃掉 `api_key` 这类标识符；波浪号保留，它多是路径（`~/x`）而不是删除线。整行都是噪声时退回首行原文，保证菜单不会出现空标签。

## 反馈超时按人的审阅时长取值

默认 30 分钟（`DEFAULT_FEEDBACK_TIMEOUT_MS`，可用 `PLANNOTATOR_FEEDBACK_TIMEOUT_MS` 覆盖）。投递本身只要 29–55 秒（#38 实测），但计时覆盖整个人工标注/审阅期；按投递耗时取值会在用户点 Send Feedback 之前误杀进程、丢掉反馈。

## 完整 JSON 即成功，短宽限后 kill

stdout 一旦能解析出完整决策 JSON 就立即投递并回收进程，不等 `exited`——关闭期挂起对结果零影响。stdout 已关闭但进程仍不退出的，等 3 秒再 `SIGKILL`。kill 与 stdin 写入的错误处理见 [ADR 0012](0012-plannotator-subprocess-error-visibility.md)。

## 测试包装 Bun.spawn

`Bun.spawn` 不带 env 选项时使用进程启动时的环境快照，运行期改 `process.env` 对子进程不可见；`commands.test.ts` 因此包装 `Bun.spawn`，把当前 `process.env` 与插件显式 env 合并后再传给子进程，让逐用例的 stub 环境变量生效。

Bun 的 `os.tmpdir()` 每次重读 `TMPDIR`、不缓存，所以临时目录统一挂在一个扁平基目录下（`suiteBase`），避免上一个用例设置的 `TMPDIR` 让 `mkdtemp` 嵌套。
