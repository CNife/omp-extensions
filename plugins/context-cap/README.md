# context-cap

进程内每个 Available model 的 Context window 封顶 256K。

安装即生效，没有通知，没有开关。压缩、溢出恢复、用量展示和模型选择器都读封顶后的值。用户不能用 `models.yml` 把窗口抬回 256K 以上。

## 行为

- 正数 Context window 写成 `min(原值, 256000)`；本来就 ≤256K 的保持原值
- `maxTokens` 非空时写成 `min(原 maxTokens, 封顶后窗口)`
- `null` / 非正窗口整条不动，不会被填成 256K
- 会话开始之后才出现的模型（发现刷新、登录、其他扩展 `registerProvider`）也会被盖住
- 不改写磁盘上的 `models.yml`，不往 `/login` 塞假 provider
- 256K 上限不能配置

卸载插件并新开进程后，模型恢复原生窗口。

## 安装

```bash
/marketplace add CNife/omp-extensions
/marketplace install context-cap@omp-extensions
```

## 测试

纯逻辑（`applyContextCap`）在 `test/cap.test.ts`，零运行时 omp 依赖：

```bash
cd plugins/context-cap && bun test
```
