// @ts-nocheck
/**
 * recall tool - thin adapter (spec #139 resolution).
 *
 * omp 移植要点：
 *   - defineTool -> 由 recallTool(pi) 返回工具定义对象，交给 pi.registerTool
 *   - Type（@earendil-works/pi-ai）-> pi.typebox 兼容垫片
 *   - Text 仍取自 @earendil-works/pi-tui（omp 加载扩展时自动重写到自带 pi-tui）
 *
 * execute 调 recall.ts（纯提取）+ render.ts（formatRecallText，LLM 文本），
 * renderCall/renderResult 委托 render.ts 并包 new Text(...)。
 * 错误遵循 throw 契约：parseAnchor / sessionFile 缺失 / recallFromJsonl 抛错
 * -> 框架置 isError，renderResult 经 opts.isError 走错误态。
 */

import { Text } from "@earendil-works/pi-tui";
import { parseAnchor, recallFromJsonl } from "./recall.ts";
import {
  formatRecallText,
  renderRecallCall,
  renderRecallResult,
} from "./render.ts";

/** 构建 recall 工具定义（需 pi 提供 typebox 兼容垫片）。 */
export function recallTool(pi: any) {
  const { Type } = pi.typebox;
  return {
    name: "recall_pruned_tool_call",
    label: "Recall",
    description:
      "Recall the full arguments and result of a pruned tool call by its anchor (e.g. #14.1). " +
      "Use this when the summary shows a truncated tool call and you need the complete details.",
    promptSnippet: "Recall full args/result of a pruned tool call by anchor",
    promptGuidelines: [
      "Pruned tool calls in the summary have anchors like `#14.1` (line 14, toolCall 1) or `#14` (single toolCall on line 14). " +
        'Call `recall_pruned_tool_call({ id: "#14.1" })` to recover the full arguments and result.',
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "Anchor from the summary, e.g. '#14.1', '14.1', or '14'",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        throw new Error("Cannot recall: in-memory session has no JSONL file");
      }
      const { line, index } = parseAnchor(params.id);
      const details = recallFromJsonl(sessionFile, line, index);
      return {
        content: [{ type: "text" as const, text: formatRecallText(details) }],
        details,
      };
    },

    renderCall(args, theme) {
      return new Text(renderRecallCall(args, theme), 0, 0);
    },

    renderResult(result, { expanded }, theme, context) {
      return new Text(
        renderRecallResult(
          result,
          { expanded, isError: context.isError },
          theme,
          context.args,
        ),
        0,
        0,
      );
    },
  };
}
