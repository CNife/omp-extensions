// @ts-nocheck
/**
 * thinking-fold renderer — monkey-patch `AssistantMessageComponent.updateContent`。
 *
 * 与 pi 版不同，OMP 的 `AssistantMessageComponent` / `Markdown` 使用 ES `#private`
 * 字段，「render → 找 marker → 替换子组件」策略无法移植。本插件改用消息预处理：
 * 在调用原生 `updateContent` 之前，将 thinking block 的文本替换为折叠内容
 * （label + 尾部预览），让 OMP 原生渲染管线处理渲染。此策略与原生 fast-path
 * 优化完全兼容：thinking 块在 shape key 中只编码 `KV`/`KH`/`K0`（文本不参与），
 * 折叠文本变化时走 `setText` 高效更新。
 */

import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent";

export interface ThinkingFoldOptions {
  previewLines: number;
  toggleKey: string;
}

export interface ThinkingTiming {
  startedAt: number;
  completedAt?: number;
}

export const DEFAULT_THINKING_CURSOR_LABEL = "Thinking...";

export const DEFAULT_THINKING_FOLD_OPTIONS: ThinkingFoldOptions = {
  previewLines: 7,
  toggleKey: "ctrl+t",
};

// 固定三态行为：streaming 显示尾部预览，完成折叠为单行计时。展开时 rebuild
// 提前返回渲染原文，因此折叠态只有这两种。
type EffectiveBehavior = "collapse" | "preview";

interface ComponentState {
  fullMessage?: AssistantMessage;
  renderedMessage?: AssistantMessage;
  lastOpts?: { transient?: boolean };
}

interface PatchRecord {
  owners: number;
  expanded: boolean;
  now: number;
  options: ThinkingFoldOptions;
  originalUpdate: AssistantMessageComponent["updateContent"];
  states: WeakMap<AssistantMessageComponent, ComponentState>;
  components: Set<WeakRef<AssistantMessageComponent>>;
  knownComponents: WeakSet<AssistantMessageComponent>;
  timings: Map<number, ThinkingTiming>;
  updateOptions(options: Partial<ThinkingFoldOptions>): void;
  setExpanded(expanded: boolean): void;
  setMessageTiming(timestamp: number, timing: ThinkingTiming): void;
  beginMessage(message: AssistantMessage, startedAt?: number): void;
  completeMessage(message: AssistantMessage, completedAt?: number): void;
  tick(now?: number): void;
  rerenderAll(): void;
  rerenderTimestamp(timestamp: number): void;
}

export interface ThinkingFoldPatchHandle {
  readonly expanded: boolean;
  readonly options: ThinkingFoldOptions;
  updateOptions(options: Partial<ThinkingFoldOptions>): void;
  setExpanded(expanded: boolean): void;
  toggle(): void;
  setMessageTiming(timestamp: number, timing: ThinkingTiming): void;
  beginMessage(message: AssistantMessage, startedAt?: number): void;
  completeMessage(message: AssistantMessage, completedAt?: number): void;
  tick(now?: number): void;
  dispose(): void;
}

const PATCH_SYMBOL = Symbol.for(
  "omp-extensions/thinking-fold/assistant-message-patch",
);

function normalizedOptions(
  options: Partial<ThinkingFoldOptions>,
): ThinkingFoldOptions {
  const previewLines =
    options.previewLines ?? DEFAULT_THINKING_FOLD_OPTIONS.previewLines;
  return {
    previewLines:
      Number.isInteger(previewLines) && previewLines > 0
        ? previewLines
        : DEFAULT_THINKING_FOLD_OPTIONS.previewLines,
    toggleKey:
      options.toggleKey?.trim() || DEFAULT_THINKING_FOLD_OPTIONS.toggleKey,
  };
}

export function formatThinkingSeconds(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}

function createStreamingThinkingLabel(
  options: ThinkingFoldOptions,
  timing: ThinkingTiming | undefined,
  now: number,
  canExpand: boolean,
): string {
  const duration = timing
    ? formatThinkingSeconds(now - timing.startedAt)
    : "0.0s";
  return `Thinking ${duration}${canExpand ? `  (${options.toggleKey} to expand)` : ""}`;
}

function createCompletedThinkingLabel(
  options: ThinkingFoldOptions,
  timing: ThinkingTiming,
  canExpand: boolean,
): string {
  const completedAt = timing.completedAt ?? timing.startedAt;
  const duration = formatThinkingSeconds(completedAt - timing.startedAt);
  return `Thought for ${duration}${canExpand ? `  (${options.toggleKey} to expand)` : ""}`;
}

/**
 * 构建折叠消息：每个非空 thinking block 替换为折叠内容。
 * - collapse：`**label**`（单行）
 * - preview：`**label**` + 空行 + 原始 thinking 文本的最后 previewLines 行
 * `{ ...block, thinking }` 保留 `rawThinking` 等附加字段；`resolveThinkingDisplay`
 * 在 `rawThinking` 存在时直接使用 `block.thinking`（折叠内容），可见性仍由
 * `rawThinking`（原始文本）决定——原始有内容则折叠内容可见。行为正确。
 * 无 thinking block 时返回 undefined。
 */
function buildFoldedMessage(
  message: AssistantMessage,
  behavior: EffectiveBehavior,
  timing: ThinkingTiming | undefined,
  record: PatchRecord,
): AssistantMessage | undefined {
  const content = message.content;
  let modified: typeof content | undefined;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type !== "thinking" || !block.thinking.trim()) continue;
    const label =
      behavior === "collapse" && timing
        ? createCompletedThinkingLabel(record.options, timing, true)
        : createStreamingThinkingLabel(
            record.options,
            timing,
            record.now,
            true,
          );
    let folded: string;
    if (behavior === "collapse") {
      folded = `**${label}**`;
    } else {
      const lines = block.thinking.trim().split("\n");
      folded = `**${label}**\n\n${lines
        .slice(-record.options.previewLines)
        .join("\n")}`;
    }
    if (!modified) modified = [...content];
    modified[i] = { ...block, thinking: folded };
  }
  return modified ? { ...message, content: modified } : undefined;
}

function getPatchRecord(): PatchRecord | undefined {
  return (
    AssistantMessageComponent.prototype as unknown as Record<
      PropertyKey,
      unknown
    >
  )[PATCH_SYMBOL] as PatchRecord | undefined;
}

function setPatchRecord(record: PatchRecord | undefined): void {
  const prototype = AssistantMessageComponent.prototype as unknown as Record<
    PropertyKey,
    unknown
  >;
  if (record) prototype[PATCH_SYMBOL] = record;
  else delete prototype[PATCH_SYMBOL];
}

/**
 * 核心：折叠渲染入口。所有 thinking block 的折叠/展开决策都在这里完成，
 * 随后交给原生 `updateContent` 渲染。`hideThinkingBlock` 是 TS `private`
 * 构造参数属性（非 `#` 字段），编译后为普通属性，运行时可临时改写。
 */
function rebuild(
  component: AssistantMessageComponent,
  state: ComponentState,
  record: PatchRecord,
): void {
  const message = state.fullMessage;
  if (!message) return;

  const internals = component as { hideThinkingBlock: boolean };
  const nativeHidden = internals.hideThinkingBlock;
  // 折叠内容由原生 Markdown 渲染，而非 OMP 的隐藏动画脉冲：
  // 临时关闭 hideThinkingBlock，让原生管线渲染折叠文本。
  internals.hideThinkingBlock = false;
  try {
    if (
      record.expanded ||
      !message.content.some((block) => block.type === "thinking")
    ) {
      state.renderedMessage = message;
      record.originalUpdate.call(component, message, state.lastOpts);
      return;
    }

    const timing = record.timings.get(message.timestamp);
    const completed = timing?.completedAt !== undefined;
    const behavior: EffectiveBehavior = completed ? "collapse" : "preview";
    const modified = buildFoldedMessage(message, behavior, timing, record);
    if (!modified) {
      state.renderedMessage = message;
      record.originalUpdate.call(component, message, state.lastOpts);
      return;
    }

    state.renderedMessage = modified;
    record.originalUpdate.call(component, modified, state.lastOpts);
  } finally {
    internals.hideThinkingBlock = nativeHidden;
  }
}

function forEachLiveComponent(
  record: PatchRecord,
  callback: (
    component: AssistantMessageComponent,
    state: ComponentState,
  ) => void,
): void {
  for (const reference of record.components) {
    const component = reference.deref();
    if (!component) {
      record.components.delete(reference);
      continue;
    }
    const state = record.states.get(component);
    if (state) callback(component, state);
  }
}

function createPatchRecord(
  options: Partial<ThinkingFoldOptions>,
): PatchRecord {
  const prototype = AssistantMessageComponent.prototype;
  const originalUpdate = prototype.updateContent;
  const record: PatchRecord = {
    owners: 0,
    expanded: false,
    now: Date.now(),
    options: normalizedOptions(options),
    originalUpdate,
    states: new WeakMap(),
    components: new Set(),
    knownComponents: new WeakSet(),
    timings: new Map(),
    updateOptions(next) {
      this.options = normalizedOptions({ ...this.options, ...next });
      this.rerenderAll();
    },
    setExpanded(expanded) {
      if (this.expanded === expanded) return;
      this.expanded = expanded;
      this.rerenderAll();
    },
    setMessageTiming(timestamp, timing) {
      this.timings.set(timestamp, { ...timing });
      this.rerenderTimestamp(timestamp);
    },
    beginMessage(message, startedAt = Date.now()) {
      this.timings.set(message.timestamp, { startedAt });
      this.now = startedAt;
      this.rerenderTimestamp(message.timestamp);
    },
    completeMessage(message, completedAt = Date.now()) {
      const timing = this.timings.get(message.timestamp) ?? {
        startedAt: Math.min(message.timestamp, completedAt),
      };
      if (timing.completedAt !== undefined) return;
      this.timings.set(message.timestamp, { ...timing, completedAt });
      this.now = completedAt;
      // Ctrl+T 是持久的全局显示偏好。完成折叠只控制折叠表示；
      // 后续回合的完成不得覆盖用户显式的展开选择。
      this.rerenderTimestamp(message.timestamp);
    },
    tick(now = Date.now()) {
      this.now = now;
      forEachLiveComponent(this, (component, state) => {
        const timestamp = state.fullMessage?.timestamp;
        if (
          timestamp === undefined ||
          this.timings.get(timestamp)?.completedAt !== undefined
        )
          return;
        rebuild(component, state, this);
      });
    },
    rerenderAll() {
      forEachLiveComponent(this, (component, state) =>
        rebuild(component, state, this),
      );
    },
    rerenderTimestamp(timestamp) {
      forEachLiveComponent(this, (component, state) => {
        if (state.fullMessage?.timestamp === timestamp)
          rebuild(component, state, this);
      });
    },
  };

  prototype.updateContent = function (
    message: AssistantMessage,
    opts?: { transient?: boolean },
  ): void {
    const state = record.states.get(this) ?? {};

    // 区分外部调用（新 fullMessage）与内部重渲染（renderedMessage 回灌，
    // 如 Container.invalidate() 传入上次渲染的消息克隆）。
    if (message !== state.renderedMessage) {
      state.fullMessage = message;
      state.lastOpts = opts;
    }
    record.states.set(this, state);
    if (!record.knownComponents.has(this)) {
      record.knownComponents.add(this);
      record.components.add(new WeakRef(this));
    }
    rebuild(this, state, record);
  };

  setPatchRecord(record);
  return record;
}

export function installThinkingFoldPatch(
  options: Partial<ThinkingFoldOptions> = {},
): ThinkingFoldPatchHandle {
  const prototype = AssistantMessageComponent.prototype;
  if (
    typeof prototype.updateContent !== "function" ||
    typeof prototype.render !== "function"
  ) {
    throw new Error(
      "OMP's AssistantMessageComponent rendering API is unavailable",
    );
  }

  const record = getPatchRecord() ?? createPatchRecord(options);
  record.owners += 1;
  record.updateOptions(options);
  let disposed = false;

  return {
    get expanded() {
      return record.expanded;
    },
    get options() {
      return { ...record.options };
    },
    updateOptions(next) {
      record.updateOptions(next);
    },
    setExpanded(expanded) {
      record.setExpanded(expanded);
    },
    toggle() {
      record.setExpanded(!record.expanded);
    },
    setMessageTiming(timestamp, timing) {
      record.setMessageTiming(timestamp, timing);
    },
    beginMessage(message, startedAt) {
      record.beginMessage(message, startedAt);
    },
    completeMessage(message, completedAt) {
      record.completeMessage(message, completedAt);
    },
    tick(now) {
      record.tick(now);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      record.owners -= 1;
      if (record.owners > 0 || getPatchRecord() !== record) return;

      prototype.updateContent = record.originalUpdate;
      setPatchRecord(undefined);
    },
  };
}
