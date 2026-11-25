import { flush, scheduleFlush } from "./session-sync.ts";

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

const SHUTDOWN_FLUSH_OPTIONS = { timeoutMs: 800, retries: 0 };

export default function nmem(pi: any) {
  if (process.env.NMEM_GUIDANCE?.trim() === "1") {
    pi.on("before_agent_start", async (event: any) => {
      return { systemPrompt: [...event.systemPrompt, `\n${startupGuidance()}`] };
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

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    await flush(ctx, "session_shutdown", SHUTDOWN_FLUSH_OPTIONS);
  });
}
