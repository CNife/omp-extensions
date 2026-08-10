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
 *   - read src/foo.ts #5          ← toolCall：path 类参数 + 锚点
 *   - bash ls -la #5              ← 非 path 工具主参数（command 等）全量内联
 *   - glob #11                    ← 无参数时省略
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
 * 非 path 类工具的主参数键（全量内联）。
 *
 * 这些工具的核心信息不在 path 类参数中，裁剪层（pruneToolCallArgs）
 * 已全参数保留，渲染层在此映射中补充展示，使 summary 可读。
 * 不在此表的工具仅渲染 path 类参数（如有）。
 * intent（i）不在此映射中，不渲染。
 */
const PRIMARY_ARG_KEYS: Record<string, readonly string[]> = {
  bash: ["command"],
  grep: ["pattern"],
  ask: ["questions"],
  todo: ["op", "task", "phase"],
};

/** 提取 toolCall args 中的 path 类参数，空格连接。 */
function renderPathArgs(args: Record<string, unknown>): string {
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

/**
 * 提取非 path 类工具的主参数，全量内联。
 *
 * string 值原样输出；非 string 值（如 ask 的 questions 数组）用紧凑 JSON
 * 序列化。换行 -> 空格，避免破坏 summary 一行一 toolCall 结构。
 */
function renderPrimaryArg(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const keys = PRIMARY_ARG_KEYS[toolName];
  if (!keys) return "";
  const parts: string[] = [];
  for (const key of keys) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s) parts.push(s.replace(/\r?\n/g, " ").trim());
  }
  return parts.join(" ");
}

/** 渲染 toolCall 行的参数部分：path 类参数 + 主参数，空格连接。 */
function renderToolCallArgs(
  toolName: string,
  args: Record<string, unknown>,
): string {
  return [renderPathArgs(args), renderPrimaryArg(toolName, args)]
    .filter(Boolean)
    .join(" ");
}

/** 渲染单个 PrunedEntry 为字符串（可能多行）。 */
function renderEntry(entry: PrunedEntry): string {
  switch (entry.kind) {
    case "text":
      return `<${entry.role}>\n${entry.text}\n</${entry.role}>`;

    case "toolCall": {
      const argStr = renderToolCallArgs(entry.name, entry.args);
      const anchor = entry.anchor ? ` ${entry.anchor}` : "";
      return argStr
        ? `- ${entry.name} ${argStr}${anchor}`
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
