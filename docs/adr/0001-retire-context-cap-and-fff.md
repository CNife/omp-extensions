# 退役 context-cap 与 fff 插件

两个插件都是在 OMP 缺对应能力时自造的：`context-cap` 把每个 Available model 的 Context window 封顶 200K，`fff` fork `@ff-labs/pi-fff` 提供 `fffind` / `ffgrep` 模糊搜索。用下来 `context-cap` 没有带来额外价值，还剥夺了用 `models.yml` 把窗口抬回去的自由；`fff` 的能力 OMP 原生已经够用。因此退役两者：从 marketplace 摘除注册、删除插件目录，不留占位条目，也不写迁移指引——本仓只有 CNife 一个消费者，两个插件在任何机器上都没有在用实例。

## 考虑过的选项

- **保留插件目录、只摘除注册**：仓库会积累无人维护的死重，而 git 历史本来就完整保留了代码。
- **移入 `attic/` 退役区**：同样是死重，还额外发明了一个仓库不存在的目录约定。
- **在 marketplace 留 tombstone 条目**：没有已安装实例需要迁移，占位条目只会在插件列表里制造噪音。

## 恢复线索

要捞回任一插件，取它在退役前的最后一次提交：

| 插件 | 最后版本 | 最后提交 |
| --- | --- | --- |
| context-cap | 0.2.0 | `1f38122` context-cap 上限从 256K 降到 200K |
| fff | 0.1.1 | `3d75f7d` 修复 fff 插件缺失依赖自动安装 |
