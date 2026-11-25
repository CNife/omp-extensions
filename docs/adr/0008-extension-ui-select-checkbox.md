# 扩展交互列表用 `ctx.ui.select` 勾选，不自绘

omp 19.2.0 重写 TUI（`7784896434 feat(tui)!: rebuilt the terminal ui as a reactive pi-tui`）后，`@oh-my-pi/pi-tui` 只剩反应式节点框架：`SettingsList`、`Container`、`Text`、`DynamicBorder`、`getSettingsListTheme` 全部消失，`@oh-my-pi/pi-coding-agent` 也不再重导出 pi-tui。用它们的扩展（skills-injection、ask-consultants）在加载期直接失败：

```
Failed to load extension …: Export named 'DynamicBorder' not found in module 'omp-legacy-pi-bundled:@…
```

## 选择

两个插件的「勾选列表」改用宿主原生的 `ctx.ui.select(title, rows, { selectionMarker: "checkbox", checkedIndices, markableCount, initialIndex })` 循环：勾选即时持久化，勾完关掉再按新状态重开，光标按条目 id 回到刚切的那一行，末尾追加一行 `Done selecting` 作为关闭出口。

## 考虑过的选项

- **`ctx.ui.custom` + 行对象（`render(width)` + `handleInput(data)`）**：能保持对话框不重开。但 `handleInput` 收的是终端原始字节，kitty 键盘协议下 `Enter` 是 `\x1b[13u`、`Esc` 是 `\x1b[27u`，方向键与修饰键各有变体——手写解码等于重造框架已做好的按键层，且随终端变化而碎。
- **`ctx.ui.custom` + pi-tui 节点（`<list>` / `<prefs>` 等 TSP kind）**：那是 omp 自己设置页的私有画法（`/settings` 的 `prefs` 节点要 pages/sections/focus/editing 全套状态机），扩展照抄即绑死内部形状，比 `select` 更难跟随后续升级。
- **自绘 + `SettingsList`（旧实现）**：omp 19.2 起不存在。

## 后果

- 交互由宿主绘制：终端与 Tern 两种视图同一套外观，行多时自带 `Type to search`，`↑↓`/`Enter`/`Esc` 键位由宿主保证。
- 每次勾选对话框会关掉再重开（闪烁一次）。这是 omp 自己的多选路径（`tools/ask.ts` 的 multiple-choice）同样的做法，换来零按键解码、零内部 API 依赖。
- 旧实现里给启用行上 success 色高亮的主题包装随 `SettingsList` 一起删掉；状态改由勾选框与「已启用行排前」表达，标题里带 `N of M selected` 计数。
- 扩展入口只从包根导入 `getAgentDir` / `loadSkills` 这类稳定面；`pi-tui` 的组件集一律不碰。
- 根 `package.json` 的 `@oh-my-pi/pi-coding-agent` / `pi-tui` devDeps 必须跟当前 omp 主版本（现为 19.2.0）：`tsc` 靠它们校验扩展用到的 API，钉在旧版就等于用旧 API 过门禁——这次加载失败正是 18.11.3 的包根仍重导出 pi-tui、而 19.2.0 不再重导出造成的静默漏检。
