// @ts-nocheck
/**
 * simple-plannotator - OMP extension that shells out to the `plannotator` CLI.
 *
 * Three slash commands:
 *   /pnr [url]     - Open browser-based code review for local git changes or a PR/MR URL
 *   /pna <path>    - Open browser-based annotation for a markdown file, folder, or URL
 *   /pnl           - Annotate the last assistant message
 *
 * Requires the `plannotator` binary on PATH (https://plannotator.ai/install.sh).
 * No npm dependencies; all UI/infra is handled by the CLI process.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// ── Spawn helpers ───────────────────────────────────────────────────────────

/** Run `plannotator` with the given args, capture stdout, deliver feedback. */
async function runPlannotator(
  pi: ExtensionAPI,
  ctx: any,
  args: string[],
  label: string,
  cleanup?: () => void,
  feedbackPrefix?: string,
): Promise<void> {
  // plannotator 偶发进程内死锁（futex 阻塞，不写 stdout、不退出，~20% 概率）：
  // 裸 await Promise.all([stdout, stderr, exited]) 会永久挂起 -> "卡死"。
  // 加超时：到点 kill 进程并通知用户重试（反馈只走 stdout，卡死时不可恢复）。
  const timeoutMs = Number(Bun.env.PLANNOTATOR_FEEDBACK_TIMEOUT_MS) || 120_000;
  try {
    const proc = Bun.spawn(["plannotator", ...args], {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const delivery = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let timer;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    let outcome;
    try {
      outcome = await Promise.race([
        delivery.then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })),
        timeout,
      ]);
    } finally {
      // delivery reject 时 race 直接 reject -> 外层 catch；finally 保证定时器不残留。
      clearTimeout(timer);
    }

    if (outcome === "timeout") {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      ctx.ui.notify(
        `${label} timed out waiting for feedback (plannotator may have hung). Please retry.`,
        "error",
      );
      return;
    }

    const { stdout, stderr, exitCode } = outcome;

    if (exitCode !== 0 && !stdout.trim()) {
      const detail = stderr.trim() || `exit code ${exitCode}`;
      ctx.ui.notify(`${label} failed: ${detail}`, "error");
      return;
    }

    const feedback = stdout.trim();
    if (feedback) {
      // 省略 deliverAs：显式 deliverAs（如 "followUp"）只入队不启动回合，空闲时
      // 反馈会静默躺在队列里直到下一条显式输入；省略后空闲路径直接走 prompt()
      // 启动回合，反馈立即作为用户消息进入会话。
      // feedbackPrefix：/pnl 标注的是扩展生成的临时载体文件，反馈本身只含
      // "(line N)" 行号引用、无文件名，AI 收到后会困惑"文件在哪"。前缀明确
      // 告知这是对"上一条助手消息"的标注反馈，无需查找文件（内容即在会话中）。
      pi.sendUserMessage(feedbackPrefix ? `${feedbackPrefix}\n\n${feedback}` : feedback);
    } else {
      ctx.ui.notify(`${label} closed (no feedback).`, "info");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("spawn")) {
      ctx.ui.notify(
        "plannotator not found on PATH. Install: curl -fsSL https://plannotator.ai/install.sh | bash",
        "error",
      );
    } else {
      ctx.ui.notify(`${label} failed: ${msg}`, "error");
    }
  } finally {
    cleanup?.();
  }
}

// ── Path normalization (ported from pi simple-plannotator) ──────────────────

function normalizeUserPath(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const unquoted = stripped.replace(/^["']|["']$/g, "");
  const home = Bun.env.HOME || process.env.HOME || "";
  if (unquoted === "~") return home;
  if (unquoted.startsWith("~/") || unquoted.startsWith("~\\")) {
    return home + unquoted.slice(1);
  }
  return unquoted;
}

// ── Last assistant message extraction ──────────────────────────────────────

function partToText(part: any): string {
  if (typeof part === "string") return part;
  if (part && typeof part === "object") {
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
  }
  return "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partToText).filter(Boolean).join("\n");
  if (content && typeof content === "object") return partToText(content);
  return "";
}

function getLastAssistantText(ctx: any): string | undefined {
  const manager = ctx.sessionManager;
  const entries =
    typeof manager?.getBranch === "function"
      ? manager.getBranch()
      : manager?.getEntries?.() || [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const text = contentToText(entry.message.content).trim();
      if (text) return text;
    }
  }
  return undefined;
}

// ── Extension entry ─────────────────────────────────────────────────────────

export default function simplePlannotator(pi: ExtensionAPI): void {
  // ── /pnr: Code Review ──────────────────────────────────────────────────

  pi.registerCommand("pnr", {
    description: "Open Plannotator code review for local git changes or a PR/MR URL",
    handler: async (args, ctx) => {
      const url = (args ?? "").trim();
      const cmdArgs = url ? ["review", url] : ["review"];
      ctx.ui.notify(
        url ? `Opening code review for ${url}...` : "Opening code review in browser...",
        "info",
      );
      void runPlannotator(pi, ctx, cmdArgs, "Code review");
    },
  });

  // ── /pna: Annotate ─────────────────────────────────────────────────────

  pi.registerCommand("pna", {
    description: "Open Plannotator annotation UI for a markdown file, folder, or URL",
    handler: async (args, ctx) => {
      const target = normalizeUserPath(args ?? "");
      if (!target) {
        ctx.ui.notify("Usage: /pna <file.md | folder/ | https://...>", "error");
        return;
      }

      ctx.ui.notify(`Opening annotation UI for ${target}...`, "info");
      void runPlannotator(pi, ctx, ["annotate", target], "Annotation");
    },
  });

  // ── /pnl: Annotate Last Message ────────────────────────────────────────

  pi.registerCommand("pnl", {
    description: "Annotate the last assistant message in Plannotator",
    handler: async (_args, ctx) => {
      const lastText = getLastAssistantText(ctx);
      if (!lastText) {
        ctx.ui.notify("No assistant message found in session.", "error");
        return;
      }

      const tmpFile = join(tmpdir(), `plannotator-last-${Date.now()}.md`);
      try {
        await Bun.write(tmpFile, lastText);
      } catch (err) {
        ctx.ui.notify(
          `Failed to write temp file: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }

      ctx.ui.notify("Opening annotation UI for last message...", "info");
      void runPlannotator(
        pi,
        ctx,
        ["annotate", tmpFile],
        "Annotation",
        () => {
          try {
            rmSync(tmpFile, { force: true });
          } catch {
            /* ignore */
          }
        },
        // 反馈 framing：告知 AI 这是对"上一条助手消息"的标注反馈，避免其困惑于
        // 已删除的临时载体文件"在哪"。
        "这是对你上一条助手消息的标注反馈，请直接处理，无需查找文件。",
      );
    },
  });
}
