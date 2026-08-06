/**
 * prune - 确定性裁剪纯函数（omp 工具集适配）。
 *
 * 输入 AgentMessage[]（结构兼容）+ 可选行号映射，
 * 按 omp 裁剪规则裁剪：
 *   - thinking：全裁
 *   - toolCall 参数裁剪：
 *     - write（普通文件）：裁 content，留 path+i
 *     - write（xd://）：全参数保留
 *     - edit（hashline）：裁 input，从 [PATH#TAG] 头提取 path
 *     - edit（其他模式）：全参数保留
 *     - glob：仅留工具名占位（空参数），保持锚点编号
 *     - read/bash/grep/ask/低频工具：全参数保留
 *   - toolResult 裁剪矩阵：
 *     - read/bash/write/edit：成功裁、失败留
 *     - grep/glob：成功失败都裁
 *     - ask/低频工具：成功失败都留
 *   - user / assistant text：全留
 *   - bashExecution / custom / fileMention / developer 等：跳过
 *
 * 输出窄类型 PrunedEntry[]，供 format 消费。
 * 纯函数，无副作用，可独立测试。
 */

import { extractText } from "./content.ts";

// ============================================================================
// Types
// ============================================================================

/** 裁剪后的窄类型条目（discriminated union）。 */
export type PrunedEntry =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | {
      kind: "toolCall";
      name: string;
      args: Record<string, unknown>;
      anchor: string;
    }
  | { kind: "toolResultKept"; toolName: string; content: string; isError: boolean };

/**
 * 结构兼容 omp AgentMessage 的最小输入类型。
 *
 * 纯函数只需 role + 相关字段，不依赖完整类型。
 * omp 的 bash 走 toolResult+toolName:"bash"，不用 bashExecution 角色；
 * omp 没有 role:"custom" 消息（custom_message 是顶层 JSONL 条目类型）。
 */
export interface MessageLike {
  role: string;
  content?: unknown;
  // toolResult fields
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * hashline [PATH#TAG] 头提取正则（与 omp extractHashlineHeaderPaths 一致）。
 *
 * 匹配 `[src/foo.ts#A1B2]` 形式的 section 头，捕获 path 部分。
 * tag 为 4 位 hex（#A1B2），可选。
 */
const HASHLINE_HEADER_RE = /^\s*\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]\s*$/gm;

/** 从 hashline input 中提取所有 section path（去重，保序）。 */
export function extractHashlinePaths(input: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(HASHLINE_HEADER_RE)) {
    const p = match[1].trim();
    if (p && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}

/** 从 args 中移除指定键，返回新对象。 */
function dropKeys(
  args: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!keys.includes(k)) {
      result[k] = v;
    }
  }
  return result;
}

/**
 * 对 toolCall args 执行裁剪（不截断，只删键/替换）。
 *
 * | 场景 | 规则 |
 * |------|------|
 * | write（普通文件） | 裁 content，留 path+i |
 * | write（xd://） | 全参数保留 |
 * | edit（hashline） | 裁 input，提取 paths |
 * | edit（其他模式） | 全参数保留 |
 * | glob | 空参数占位（保持锚点编号） |
 * | 其他 | 全参数保留 |
 */
export function pruneToolCallArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (toolName) {
    case "write": {
      const path = args.path;
      // xd:// 写入（工具设备）：全参数保留
      if (typeof path === "string" && path.startsWith("xd://")) return args;
      // 普通文件写入：裁 content
      return dropKeys(args, ["content"]);
    }
    case "edit": {
      // hashline 模式（input 字段）：裁 input，提取 path
      if (typeof args.input === "string") {
        const paths = extractHashlinePaths(args.input);
        if (paths.length > 0) return { paths };
      }
      // 其他模式（replace/patch/apply-patch）：全参数保留
      return args;
    }
    case "glob": {
      // 仅留工具名占位，保持锚点编号
      return {};
    }
    default:
      // read/bash/grep/ask/低频工具：全参数保留
      return args;
  }
}

/** toolResult 裁剪规则。 */
type ToolResultRule = "prune-success-keep-fail" | "always-prune" | "always-keep";

const TOOL_RESULT_RULES: Record<string, ToolResultRule> = {
  read: "prune-success-keep-fail",
  bash: "prune-success-keep-fail",
  write: "prune-success-keep-fail",
  edit: "prune-success-keep-fail",
  grep: "always-prune",
  glob: "always-prune",
  ask: "always-keep",
};

/**
 * toolResult 是否应保留（omp 裁剪矩阵）。
 *
 * | 工具 | 成功 | 失败 |
 * |------|------|------|
 * | read/bash/write/edit | 裁 | 留 |
 * | grep/glob | 裁 | 裁 |
 * | ask/低频工具 | 留 | 留 |
 */
export function shouldKeepToolResult(
  toolName: string,
  isError: boolean,
): boolean {
  const rule = TOOL_RESULT_RULES[toolName] ?? "always-keep";
  if (rule === "always-prune") return false;
  if (rule === "always-keep") return true;
  return isError; // prune-success-keep-fail
}

/** 构建锚点字符串。 */
function buildAnchor(
  lineNumber: number | undefined,
  toolCallIndex: number,
  totalToolCalls: number,
): string {
  if (lineNumber === undefined || lineNumber < 1) return "";
  // 单 toolCall 行可省略 .1
  if (totalToolCalls === 1 && toolCallIndex === 1) {
    return `#${lineNumber}`;
  }
  return `#${lineNumber}.${toolCallIndex}`;
}

// ============================================================================
// Main export
// ============================================================================

/**
 * 对消息序列执行确定性裁剪。
 *
 * @param messages - 活跃消息序列
 * @param messageLineNumbers - 可选，与 messages 等长的 JSONL 行号数组（1-based，未映射为 undefined）
 */
export function pruneMessages(
  messages: MessageLike[],
  messageLineNumbers?: (number | undefined)[],
): PrunedEntry[] {
  const entries: PrunedEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const lineNumber = messageLineNumbers?.[i];

    switch (msg.role) {
      case "user": {
        const text = extractText(msg.content);
        if (text) {
          entries.push({ kind: "text", role: "user", text });
        }
        break;
      }

      case "assistant": {
        const content = msg.content;
        if (!Array.isArray(content)) {
          // 纯字符串 content
          if (typeof content === "string" && content) {
            entries.push({ kind: "text", role: "assistant", text: content });
          }
          break;
        }

        // 提取 text parts
        const textParts: string[] = [];
        // 提取 toolCall parts
        const toolCalls: Array<{
          name: string;
          args: Record<string, unknown>;
        }> = [];

        for (const part of content) {
          if (part == null || typeof part !== "object" || !("type" in part)) {
            continue;
          }
          const p = part as { type: string; [k: string]: unknown };
          if (p.type === "text" && typeof p.text === "string" && p.text) {
            textParts.push(p.text);
          } else if (p.type === "toolCall") {
            const name = (p.name as string) || "?";
            const rawArgs = (p.arguments as Record<string, unknown>) ?? {};
            toolCalls.push({ name, args: pruneToolCallArgs(name, rawArgs) });
          }
          // thinking: 全裁（跳过）
        }

        // 输出 text（如有）
        if (textParts.length > 0) {
          entries.push({
            kind: "text",
            role: "assistant",
            text: textParts.join("\n"),
          });
        }

        // 输出 toolCall（如有），不合并连续纯 toolCall 消息
        if (toolCalls.length > 0) {
          for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
            const tc = toolCalls[tcIdx];
            const anchor = buildAnchor(lineNumber, tcIdx + 1, toolCalls.length);
            entries.push({
              kind: "toolCall",
              name: tc.name,
              args: tc.args,
              anchor,
            });
          }
        }
        break;
      }

      case "toolResult": {
        const toolName = msg.toolName || "?";
        const isError = msg.isError ?? false;
        if (!shouldKeepToolResult(toolName, isError)) {
          break; // 被裁，直接消失
        }
        // 保留的 toolResult（成功或失败）
        const text = extractText(msg.content);
        if (text) {
          entries.push({ kind: "toolResultKept", toolName, content: text, isError });
        }
        break;
      }

      default:
        // 其他 role（bashExecution, custom, fileMention, developer,
        // compactionSummary, branchSummary 等）：跳过
        break;
    }
  }

  return entries;
}

/**
 * 从消息序列中提取文件列表（从 toolCall args 的 path/file_path 派生，零正则）。
 */
export function extractFiles(messages: MessageLike[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (
        part == null ||
        typeof part !== "object" ||
        !("type" in part) ||
        (part as { type: string }).type !== "toolCall"
      ) {
        continue;
      }
      const args = (part as { arguments?: Record<string, unknown> }).arguments;
      if (!args || typeof args !== "object") continue;

      for (const key of ["path", "file_path", "filePath"]) {
        const p = args[key];
        if (typeof p === "string" && p && !seen.has(p)) {
          seen.add(p);
          files.push(p);
        }
      }
    }
  }

  return files;
}
