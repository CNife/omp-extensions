// @ts-nocheck
/**
 * prune-context - 确定性上下文裁剪扩展。
 *
 * - /prune 命令：手动触发确定性裁剪，内部调 ctx.compact(PRUNE_MARKER)
 * - session_before_compact 钩子：
 *   - /prune 触发（customInstructions 标记）-> 确定性裁剪
 *   - 手动 /compact -> 不干预，保持 omp 原生 LLM 摘要
 *
 * 纯逻辑在 ./prune.ts 和 ./format.ts，本文件只做编排。
 *
 * omp 移植要点：
 *   - 去掉 @earendil-works/pi-coding-agent 类型导入，改用 any（@ts-nocheck）
 *   - omp 的 ctx.compact 是单参 string | CompactOptions，且 CompactOptions
 *     不含 customInstructions；故 /prune 改为 ctx.compact(PRUNE_MARKER)
 *     （字符串即 customInstructions）+ try/catch 替代原 onError 回调
 *   - omp 的 session_before_compact 事件不暴露 reason（与旧版 pi 一致），
 *     故仅 /prune 标记时介入，自动阈值压缩保守交给 omp 默认摘要
 */

import { readFileSync } from "node:fs";
import { formatSummary } from "./format.ts";
import { extractFiles, type MessageLike, pruneMessages } from "./prune.ts";
import { recallTool } from "./tool.ts";

/** /prune 命令的 customInstructions 标记，用于在钩子中识别来源。 */
const PRUNE_MARKER = "pi-prune-context:prune";

/**
 * 从 JSONL 文件构建 entryId -> lineNumber 映射。
 *
 * JSONL 第 1 行是 header，第 2 行起是 entry（1-based 行号）。
 * 返回 Map<entryId, lineNumber>。
 */
function buildLineNumberMap(sessionFile: string): Map<string, number> {
  const map = new Map<string, number>();
  let content: string;
  try {
    content = readFileSync(sessionFile, "utf-8");
  } catch {
    return map;
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id) {
        map.set(entry.id, i + 1); // 1-based
      }
    } catch {
      // 跳过无法解析的行
    }
  }
  return map;
}

/**
 * 从 branchEntries 提取活跃消息（orphan-recovery 模式）。
 *
 * 找最后一个 compaction entry：
 * - 若其 firstKeptEntryId 为空（compact-all 哨兵）或指向不存在的 entry
 *   -> 从该 compaction 之后收集所有 message entry
 * - 否则从 firstKeptEntryId 开始收集
 * - 无 compaction entry -> 收集全部 message entry
 *
 * 返回 message + entryId 的结构化数组。
 */
interface LiveMessage {
  message: MessageLike;
  entryId: string;
}

function extractLiveMessages(branchEntries: any[]): LiveMessage[] {
  // 找最后一个 compaction entry
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const e = branchEntries[i];
    if (e.type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = e.firstKeptEntryId;
      break;
    }
  }

  const result: LiveMessage[] = [];

  const collect = (entries: any[]) => {
    for (const e of entries) {
      if (e.type === "message") {
        result.push({ message: e.message, entryId: e.id });
      }
    }
  };

  if (lastCompactionIdx < 0) {
    // 无 compaction entry，收集全部
    collect(branchEntries);
    return result;
  }

  // orphan recovery：firstKeptEntryId 为空或不存在于 branch 中
  const hasValidKeptId =
    !!lastKeptId && branchEntries.some((e) => e.id === lastKeptId);

  if (!hasValidKeptId) {
    // 从 compaction 之后收集
    collect(branchEntries.slice(lastCompactionIdx + 1));
    return result;
  }

  // 从 firstKeptEntryId 开始收集
  let foundKept = false;
  for (const e of branchEntries) {
    if (!foundKept && e.id === lastKeptId) foundKept = true;
    if (!foundKept) continue;
    if (e.type === "message") {
      result.push({ message: e.message, entryId: e.id });
    }
  }
  return result;
}

export default function (pi: any) {
  // recall 工具：行号查表恢复被裁细节（定义在 ./tool.ts）
  pi.registerTool(recallTool(pi));

  // /prune 命令：手动触发确定性裁剪
  pi.registerCommand("prune", {
    description: "确定性裁剪上下文（零 LLM 开销）",
    handler: async (_args: string, ctx: any) => {
      try {
        await ctx.compact(PRUNE_MARKER);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg === "Compaction cancelled" || msg === "Already compacted") {
          ctx.ui.notify("Nothing to prune", "warning");
        } else {
          ctx.ui.notify(`Prune failed: ${msg}`, "error");
        }
      }
    },
  });

  // session_before_compact 钩子
  pi.on("session_before_compact", (event: any, _ctx: any) => {
    const { preparation, branchEntries, customInstructions } = event;
    // omp 不在事件中暴露 reason（与旧版 pi 一致）-> reason 恒为 undefined
    const reason = event.reason;

    // 手动 /compact（非 /prune 标记）-> 不干预，保持 omp 原生行为
    if (reason === "manual" && customInstructions !== PRUNE_MARKER) {
      return;
    }

    // 无 reason（omp）：仅 /prune 标记时介入，其余交给 omp 原生
    if (reason === undefined && customInstructions !== PRUNE_MARKER) {
      return;
    }

    // 提取活跃消息
    const liveMessages = extractLiveMessages(branchEntries);
    if (liveMessages.length === 0) return;

    // 构建行号映射
    const sessionFile = _ctx.sessionManager.getSessionFile();
    let messageLineNumbers: (number | undefined)[] | undefined;
    if (sessionFile) {
      const lineMap = buildLineNumberMap(sessionFile);
      messageLineNumbers = liveMessages.map((lm) => lineMap.get(lm.entryId));
      // 如果全部未命中（映射失败），不传行号
      if (messageLineNumbers.every((n) => n === undefined)) {
        messageLineNumbers = undefined;
      }
    }

    // prune -> format 管线
    const messages = liveMessages.map((lm) => lm.message);
    const entries = pruneMessages(messages, messageLineNumbers);
    const files = extractFiles(messages);
    const summary = formatSummary(
      entries,
      messages.length,
      files,
      preparation.previousSummary,
    );

    return {
      compaction: {
        summary,
        firstKeptEntryId: "",
        tokensBefore: preparation.tokensBefore,
        details: {
          prunedCount: messages.length,
          keptCount: entries.length,
          filesCount: files.length,
        },
      },
    };
  });
}
