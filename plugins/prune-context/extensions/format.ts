/**
 * format - 将 PrunedEntry[] 渲染为 summary 字符串。
 *
 * 输出格式（干净上下文，零统计噪音）：
 *   [previousSummary 原样透传（如有）]
 *   <空行>
 *   <user>
 *   text
 *   </user>
 *   <空行>
 *   <assistant>
 *   text
 *   </assistant>
 *   - read src/foo.ts #5          ← toolCall：工具名 + 主参数(path) + 锚点
 *   - glob #11                    ← 无 path 参数时省略
 *   <result tool="ask" status="ok">
 *   content
 *   </result>
 *
 * 成组规则（视觉聚合，减少空行噪音）：
 *   - text 块前留空行（首个除外）
 *   - toolCall 紧跟前一条（text 或 toolCall），不留空行
 *   - toolResultKept 紧跟其 toolCall，不留空行
 *   - toolCall 跟在 toolResultKept 后时留空行（新一轮开始）
 *
 * 纯函数，无副作用，可独立测试。
 */

import type { PrunedEntry } from "./prune.ts";

/** path 类参数键（按优先级），用于 toolCall 行内联渲染。 */
const PATH_KEYS = ["path", "file_path", "filePath"] as const;

/**
 * 提取 toolCall args 中的 path 类参数，空格连接。
 * 仅渲染 path（文件操作工具的目标），其余参数（intent/command/pattern 等）
 * 不渲染——需要时用 recall_pruned_tool_call 按锚点恢复。
 */
function renderToolCallArgs(args: Record<string, unknown>): string {
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v) paths.push(v);
  }
  const p = args.paths;
  if (Array.isArray(p)) {
    for (const item of p) {
      if (typeof item === "string" && item) paths.push(item);
    }
  }
  return paths.join(" ");
}

/** 渲染单个 PrunedEntry 为字符串（可能多行）。 */
function renderEntry(entry: PrunedEntry): string {
  switch (entry.kind) {
    case "text":
      return `<${entry.role}>\n${entry.text}\n</${entry.role}>`;

    case "toolCall": {
      const pathStr = renderToolCallArgs(entry.args);
      const anchor = entry.anchor ? ` ${entry.anchor}` : "";
      return pathStr
        ? `- ${entry.name} ${pathStr}${anchor}`
        : `- ${entry.name}${anchor}`;
    }

    case "toolResultKept": {
      const status = entry.isError ? "error" : "ok";
      return `<result tool="${entry.toolName}" status="${status}">\n${entry.content}\n</result>`;
    }
  }
}

/**
 * 当前条目前是否需要空行（成组规则）。仅在存在前一条时调用。
 */
function needsBlankBefore(prev: PrunedEntry, cur: PrunedEntry): boolean {
  if (cur.kind === "text") return true;
  if (cur.kind === "toolCall") return prev.kind === "toolResultKept";
  // toolResultKept：紧跟其 toolCall，不留空行
  return false;
}

/**
 * 将裁剪条目渲染为 summary 字符串。
 *
 * @param entries - pruneMessages 输出的 PrunedEntry[]
 * @param previousSummary - 迭代压缩时上一轮的 summary，原样透传在顶部
 */
export function formatSummary(
  entries: PrunedEntry[],
  previousSummary?: string,
): string {
  const parts: string[] = [];
  if (previousSummary) {
    parts.push(previousSummary);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const rendered = renderEntry(entry);
    const needBlank = i === 0
      ? previousSummary != null
      : needsBlankBefore(entries[i - 1], entry);
    if (needBlank) parts.push("");
    parts.push(rendered);
  }

  return parts.join("\n");
}
