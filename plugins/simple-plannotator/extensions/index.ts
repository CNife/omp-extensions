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
): Promise<void> {
  try {
    const proc = Bun.spawn(["plannotator", ...args], {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0 && !stdout.trim()) {
      const detail = stderr.trim() || `exit code ${exitCode}`;
      ctx.ui.notify(`${label} failed: ${detail}`, "error");
      return;
    }

    const feedback = stdout.trim();
    if (feedback) {
      pi.sendUserMessage(feedback, { deliverAs: "followUp" });
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
      void runPlannotator(pi, ctx, ["annotate", tmpFile], "Annotation", () => {
        try {
          rmSync(tmpFile, { force: true });
        } catch {
          /* ignore */
        }
      });
    },
  });
}
