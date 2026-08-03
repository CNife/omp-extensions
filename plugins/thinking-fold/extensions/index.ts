import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  formatKeyHints,
  VERSION,
} from "@oh-my-pi/pi-coding-agent";
import { getKeybindings } from "@oh-my-pi/pi-tui";
import {
  DEFAULT_THINKING_CURSOR_LABEL,
  installThinkingFoldPatch,
  type ThinkingFoldPatchHandle,
} from "../renderer.ts";

const STREAM_STATUS_KEY = "thinking-fold-stream";
const ITEM_TIMER_INTERVAL_MS = 1000;

export function endsThinkingPhase(
  type: AssistantMessageEvent["type"],
): boolean {
  return (
    type === "thinking_end" ||
    type === "text_start" ||
    type === "text_delta" ||
    type === "toolcall_start" ||
    type === "toolcall_delta"
  );
}

/** OMP 未从包导出 keyText（pi 版直接导入），自建：格式化为用户可读按键。 */
function keyText(action: string): string {
  return formatKeyHints(getKeybindings().getKeys(action as never));
}

function restoreTimings(
  ctx: ExtensionContext,
  patch: ThinkingFoldPatchHandle,
): void {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const message = entry.message;
    if (
      !message.content.some(
        (block) => block.type === "thinking" && block.thinking.trim(),
      )
    )
      continue;

    const completedAt = Date.parse(entry.timestamp);
    const startedAt = Number.isFinite(message.timestamp)
      ? message.timestamp
      : completedAt;
    // 时间戳缺失/不可解析时用对方回退，避免 NaN 传播到渲染（会显示 "NaNs"）。
    if (!Number.isFinite(startedAt) && !Number.isFinite(completedAt)) continue;
    const start = Number.isFinite(startedAt) ? startedAt : completedAt;
    const end = Number.isFinite(completedAt) ? completedAt : start;
    patch.setMessageTiming(message.timestamp, {
      startedAt: Math.min(start, end),
      completedAt: end,
    });
  }
}

export default function (pi: ExtensionAPI) {
  let patch: ThinkingFoldPatchHandle | undefined;
  let removeInputListener: (() => void) | undefined;
  let itemTimer: Timer | undefined;
  let thinkingStartedAt: number | undefined;
  let lastItemTimerSecond = -1;
  let lastWorkingMessage: string | undefined;
  let currentAssistant: AssistantMessage | undefined;
  let sawThinkingInCurrentMessage = false;
  let thinkingCompleted = false;
  let patchError: string | undefined;

  try {
    patch = installThinkingFoldPatch({});
  } catch (error) {
    patchError = error instanceof Error ? error.message : String(error);
  }

  const stopItemTimer = (ctx: ExtensionContext) => {
    if (itemTimer) ctx.clearTimer(itemTimer);
    itemTimer = undefined;
  };

  const renderThinkingCursor = (ctx: ExtensionContext) => {
    if (
      !ctx.hasUI ||
      thinkingStartedAt === undefined ||
      thinkingCompleted ||
      !currentAssistant ||
      !patch
    ) {
      return;
    }
    if (DEFAULT_THINKING_CURSOR_LABEL === lastWorkingMessage) return;
    lastWorkingMessage = DEFAULT_THINKING_CURSOR_LABEL;
    ctx.ui.setWorkingMessage(DEFAULT_THINKING_CURSOR_LABEL);
  };

  const refreshItemTimer = (now = Date.now()) => {
    if (!patch || thinkingStartedAt === undefined || thinkingCompleted) return;
    const elapsedSecond = Math.floor(
      Math.max(0, now - thinkingStartedAt) / 1000,
    );
    if (elapsedSecond === lastItemTimerSecond) return;
    lastItemTimerSecond = elapsedSecond;
    patch.tick(now);
  };

  const startItemTimer = (ctx: ExtensionContext) => {
    if (!patch || itemTimer || !ctx.hasUI) return;
    const now = Date.now();
    refreshItemTimer(now);
    renderThinkingCursor(ctx);
    itemTimer = ctx.setInterval(
      () => refreshItemTimer(),
      ITEM_TIMER_INTERVAL_MS,
    );
  };

  const showResponding = (ctx: ExtensionContext) => {
    stopItemTimer(ctx);
    lastWorkingMessage = "Responding...";
    ctx.ui.setWorkingMessage(lastWorkingMessage);
  };

  pi.on("session_start", (_event, ctx) => {
    if (patchError) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `thinking-fold disabled on Pi ${VERSION}: ${patchError}`,
          "warning",
        );
      }
      return;
    }
    if (!patch || !ctx.hasUI) return;

    const toggleKey = keyText("app.thinking.toggle") || "ctrl+t";
    patch.updateOptions({ toggleKey });
    restoreTimings(ctx, patch);

    removeInputListener?.();
    removeInputListener = ctx.ui.onTerminalInput((data) => {
      if (!patch || !getKeybindings().matches(data, "app.thinking.toggle"))
        return;

      patch.toggle();
      return { consume: true };
    });
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant" || !ctx.hasUI || !patch) return;
    currentAssistant = event.message;
    sawThinkingInCurrentMessage = false;
    thinkingCompleted = false;
    thinkingStartedAt = Date.now();
    lastItemTimerSecond = -1;
    lastWorkingMessage = undefined;
    patch.beginMessage(event.message, thinkingStartedAt);
    renderThinkingCursor(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant" || !ctx.hasUI || !patch) return;
    currentAssistant = event.message;

    const hasThinking = event.message.content.some(
      (block) => block.type === "thinking",
    );
    if (hasThinking) {
      sawThinkingInCurrentMessage = true;
      startItemTimer(ctx);
      renderThinkingCursor(ctx);
    }

    if (
      sawThinkingInCurrentMessage &&
      !thinkingCompleted &&
      endsThinkingPhase(event.assistantMessageEvent.type)
    ) {
      // OpenAI-compatible providers such as DeepSeek may emit thinking_end only
      // after the entire response stream. Freeze the duration as soon as actual
      // text or a tool call begins, then ignore the provider's late event.
      patch.completeMessage(event.message, Date.now());
      thinkingCompleted = true;
      stopItemTimer(ctx);
      showResponding(ctx);
    }

    if (
      !sawThinkingInCurrentMessage &&
      ctx.model?.reasoning &&
      (event.assistantMessageEvent.type === "text_start" ||
        event.assistantMessageEvent.type === "text_delta")
    ) {
      const label = "Responding... reasoning details unavailable";
      if (lastWorkingMessage === label) return;
      lastWorkingMessage = label;
      ctx.ui.setWorkingMessage(label);
      ctx.ui.setStatus(STREAM_STATUS_KEY, "reasoning details unavailable");
    }
  });

  const clearStreamStatus = (ctx: ExtensionContext) => {
    stopItemTimer(ctx);
    thinkingStartedAt = undefined;
    lastWorkingMessage = undefined;
    if (!ctx.hasUI) return;
    ctx.ui.setWorkingMessage();
    ctx.ui.setStatus(STREAM_STATUS_KEY, undefined);
  };

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (patch && sawThinkingInCurrentMessage && !thinkingCompleted) {
      patch.completeMessage(event.message);
    }
    currentAssistant = undefined;
    clearStreamStatus(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (
      patch &&
      currentAssistant &&
      sawThinkingInCurrentMessage &&
      !thinkingCompleted
    ) {
      patch.completeMessage(currentAssistant);
    }
    currentAssistant = undefined;
    clearStreamStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopItemTimer(ctx);
    removeInputListener?.();
    removeInputListener = undefined;
    if (ctx.hasUI) {
      ctx.ui.setStatus(STREAM_STATUS_KEY, undefined);
      ctx.ui.setWorkingMessage();
    }
    patch?.dispose();
    patch = undefined;
  });
}
