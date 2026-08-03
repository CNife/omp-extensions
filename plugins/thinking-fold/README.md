# thinking-fold

OMP 推理块折叠预览插件，移植自 pi 版 [thinking-fold](https://github.com/CNife/pi-extensions/tree/main/personal/thinking-fold)。

OMP 内建 thinking 显示（`hideThinkingBlock` 开关 + 动画脉冲 ✻ Thinking · X toks/s）缺少三点：尾部预览、完成后的折叠计时行、按消息展开/折叠。本插件补齐这三点。

## 行为

| 阶段 | 显示 | 底部 working message |
|------|------|----------------------|
| 推理中（streaming） | `**Thinking 12.3s**` + 原始推理文本的最后 10 行（斜体 preview） | `Thinking...` |
| 推理完成 | `**Thought for 12.3s**`（单行折叠，加粗斜体） | `Responding...` |
| 按 `Ctrl+T` | 展开全部完整推理原文（斜体 thinkingText 色） | — |
| 再按 `Ctrl+T` | 折叠回 `**Thought for 12.3s**` | — |

- `Ctrl+T` 不触发 OMP 原生的 `hideThinkingBlock` 切换（不显示 "Thinking blocks: hidden/visible" 状态消息），而是展开/折叠本插件的推理块。
- 已完成的回合折叠为单行；streaming 中的回合显示尾部预览，每秒钟更新计时。
- 恢复已有会话（`omp --continue`）时，历史 thinking block 显示为 `**Thought for X.Xs**`（从 entry 时间戳 + 消息时间戳恢复计时）。

## 与 pi 版的差异

pi 版采用「render → 找 marker → 替换子组件」策略；OMP 的 `AssistantMessageComponent` 和 `Markdown` 使用 ES `#private` 字段，无法访问内部子组件。本插件改用**消息预处理**策略：在调用原生 `updateContent` 前，将 thinking block 的文本替换为折叠内容（label + 预览），由 OMP 原生渲染管线处理渲染。该策略与 OMP 的 fast-path 优化完全兼容（thinking 块在 shape key 中不参与文本哈希，折叠文本变化走 `setText` 高效更新）。

依赖的 `hideThinkingBlock` 是 TS `private` 构造参数属性（非 `#` 字段），运行时可临时改写为 `false`，使折叠内容经原生 Markdown 渲染（bold-italic label + italic preview），而非 OMP 的隐藏动画脉冲。

## 安装

通过 marketplace 安装：

```
/marketplace add CNife/omp-extensions
/marketplace install thinking-fold@omp-extensions
```

升级：

```
omp plugin upgrade thinking-fold
```

## 调整预览行数

预览行数默认为 7。修改 `plugins/thinking-fold/renderer.ts` 中 `DEFAULT_THINKING_FOLD_OPTIONS.previewLines`，或将 `installThinkingFoldPatch({ previewLines: N })` 的初始选项改为期望值，然后重新安装/升级插件。

## 兼容性说明

- `proseOnlyThinking`：预览文本若含代码块且开启了 prose-only，会被替换为 `...`（原生行为，prose-only 预览的预期效果）。
- 展开时渲染完整推理原文，与 OMP 原生可见 thinking 渲染一致（斜体 + thinkingText 色）。
- 卸载插件或会话关闭时，`AssistantMessageComponent.prototype.updateContent` 恢复原始实现，无残留。
