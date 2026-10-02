// @ts-nocheck
/**
 * nmem — OMP extension 薄入口：何时同步。
 *
 * 仅钩子注册 + opt-in guidance 注入判定；REST 传输见 ./rest.ts，
 * 会话同步见 ./session-sync.ts。
 */

import { flush, scheduleFlush } from "./session-sync.ts";

// ============================================================================
// Guidance injection (opt-in)
// ============================================================================

function startupGuidance(): string {
  return [
    "## Nowledge Mem",
    "",
    "Nowledge Mem (`nmem` CLI) is available. This extension auto-syncs your conversation as a thread; you need not save conversation history manually.",
    "The `nmem-guide` skill covers proactive search and autonomous save — reach it when past context would help.",
    "Context Bundle / Working Memory are opt-in: run `nmem context` or `nmem wm read` when you need session-start context.",
    "",
  ].join("\n");
}

// ============================================================================
// Extension entry
// ============================================================================

export default function nmem(pi: any) {
  // Guidance injection is opt-in: set NMEM_GUIDANCE=1 to enable.
  // Default: no injection — users self-serve via `nmem context` / `nmem wm read`
  // and the nmem-guide skill.
  if (process.env.NMEM_GUIDANCE?.trim() === "1") {
    pi.on("before_agent_start", async (event: any) => {
      return { systemPrompt: `${event.systemPrompt}\n\n${startupGuidance()}` };
    });
  }

  pi.on("agent_end", async (_event: any, ctx: any) => {
    scheduleFlush(ctx, "agent_end");
  });

  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    await flush(ctx, "session_before_compact");
  });

  pi.on("session_before_switch", async (event: any, ctx: any) => {
    await flush(ctx, event.reason === "new" ? "session_new" : "session_resume");
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    await flush(ctx, `session_shutdown:${event.reason}`);
  });
}
