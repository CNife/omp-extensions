export interface PiLike {
  registerCommand(
    name: string,
    opts: {
      description: string;
      handler: (args: string | undefined, ctx: CommandCtx) => void;
    },
  ): void;
  sendUserMessage(content: string, opts?: unknown): void;
}

interface SelectOption {
  label: string;
  description?: string;
}

export interface CommandCtx {
  cwd: string;
  ui: {
    notify(message: string, type: "info" | "error"): void;
    select(
      title: string,
      options: SelectOption[],
      dialogOptions?: { initialIndex?: number },
    ): Promise<string | undefined>;
  };
  hasUI: boolean;
  sessionManager: {
    getBranch?(): unknown[];
    getEntries?(): unknown[];
  };
}

interface RunOptions {
  label: string;
  json?: boolean;
  stdin?: string;
  feedbackPrefix?: string;
}

const PNL_FEEDBACK_PREFIX =
  "这是对你上一条助手消息的标注反馈，请直接处理，无需查找文件。";

function pnlFeedbackPrefix(ordinal: number): string {
  return ordinal === 1
    ? PNL_FEEDBACK_PREFIX
    : `这是对倒数第 ${ordinal} 条助手消息的标注反馈，请直接处理，无需查找文件。`;
}

function buildSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (env.PLANNOTATOR_AI === undefined) env.PLANNOTATOR_AI = "disabled";
  return env;
}

const DEFAULT_FEEDBACK_TIMEOUT_MS = 30 * 60 * 1000;

export function resolveFeedbackTimeoutMs(): number {
  const raw = process.env.PLANNOTATOR_FEEDBACK_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_FEEDBACK_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FEEDBACK_TIMEOUT_MS;
}

function extractFeedback(stdoutText: string, json: boolean): string {
  const text = stdoutText.trim();
  if (!json) return text;
  try {
    const parsed = JSON.parse(text) as { feedback?: unknown };
    return typeof parsed?.feedback === "string" ? parsed.feedback.trim() : "";
  } catch {
    return text;
  }
}

function deliver(pi: PiLike, feedback: string, prefix?: string): void {
  pi.sendUserMessage(prefix ? `${prefix}\n\n${feedback}` : feedback);
}

function notifyPlannotatorError(ctx: CommandCtx, label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("spawn")) {
    ctx.ui.notify(
      "plannotator not found on PATH. Install: curl -fsSL https://plannotator.ai/install.sh | bash",
      "error",
    );
  } else {
    ctx.ui.notify(`${label} failed: ${msg}`, "error");
  }
}

const KILL_GRACE_MS = 3000;

function isExitedProcessError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EPIPE" || code === "ESRCH";
}

function warnSuppressed(where: string, err: unknown): void {
  if (isExitedProcessError(err)) return;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[plannotator] ${where}: ${message}`);
}

function hasExited(proc: Bun.Subprocess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function killIfRunning(proc: Bun.Subprocess, where: string): void {
  if (hasExited(proc)) return;
  try {
    proc.kill("SIGKILL");
  } catch (err) {
    warnSuppressed(where, err);
  }
}

async function waitForExit(proc: Bun.Subprocess, ms: number): Promise<boolean> {
  if (hasExited(proc)) return true;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), ms);
  try {
    return await Promise.race([proc.exited.then(() => true), promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function releaseProcess(proc: Bun.Subprocess, label: string): Promise<void> {
  if (await waitForExit(proc, KILL_GRACE_MS)) return;
  if (hasExited(proc)) return;
  console.warn(
    `[plannotator] ${label}: still running ${KILL_GRACE_MS}ms after the decision; killing the process`,
  );
  killIfRunning(proc, `${label} kill`);
}

function writeStdin(proc: Bun.Subprocess, input: string, label: string): void {
  const sink = proc.stdin;
  if (typeof sink !== "object" || sink === null) return;
  try {
    sink.write(input);
  } catch (err) {
    warnSuppressed(`${label} stdin write`, err);
  }
  try {
    sink.end();
  } catch (err) {
    warnSuppressed(`${label} stdin close`, err);
  }
}

function drainStderr(stderrP: Promise<string>, label: string): void {
  void stderrP.catch((err) => warnSuppressed(`${label} stderr read`, err));
}

async function runPlannotator(
  pi: PiLike,
  ctx: CommandCtx,
  args: string[],
  opts: RunOptions,
): Promise<void> {
  const timeoutMs = resolveFeedbackTimeoutMs();

  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(["plannotator", ...args], {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts.stdin !== undefined ? "pipe" : "ignore",
      env: buildSpawnEnv(),
    });
  } catch (err) {
    notifyPlannotatorError(ctx, opts.label, err);
    return;
  }

  const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
  const stderrStream = proc.stderr as ReadableStream<Uint8Array>;

  if (opts.stdin !== undefined) {
    writeStdin(proc, opts.stdin, opts.label);
  }

  const stderrP = new Response(stderrStream).text();
  const exitedP = proc.exited;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  let stdoutText = "";
  let jsonComplete = false;
  const stdoutP = (async () => {
    const reader = stdoutStream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      stdoutText += decoder.decode(value, { stream: true });
      if (opts.json) {
        try {
          JSON.parse(stdoutText.trim());
          jsonComplete = true;
          return;
        } catch {
        }
      }
    }
  })();

  try {
    const winner = await Promise.race([
      stdoutP.then(() => (jsonComplete ? "json" : "eof")),
      exitedP.then(() => "exited"),
      timeoutP,
    ]);

    if (winner === "timeout") {
      killIfRunning(proc, `${opts.label} kill`);
      drainStderr(stderrP, opts.label);
      const feedback = extractFeedback(stdoutText, opts.json === true);
      if (feedback) {
        deliver(pi, feedback, opts.feedbackPrefix);
      } else {
        ctx.ui.notify(
          `${opts.label} timed out waiting for feedback (plannotator may have hung). Please retry.`,
          "error",
        );
      }
      return;
    }

    if (winner === "json") {
      const feedback = extractFeedback(stdoutText, true);
      if (feedback) {
        deliver(pi, feedback, opts.feedbackPrefix);
      } else {
        ctx.ui.notify(`${opts.label} closed (no feedback).`, "info");
      }
      await releaseProcess(proc, opts.label);
      drainStderr(stderrP, opts.label);
      return;
    }

    if (!(await waitForExit(proc, KILL_GRACE_MS))) {
      if (!hasExited(proc)) {
        console.warn(
          `[plannotator] ${opts.label}: still running after stdout closed; killing the process`,
        );
      }
      killIfRunning(proc, `${opts.label} kill`);
      drainStderr(stderrP, opts.label);
      const feedback = extractFeedback(stdoutText, opts.json === true);
      if (feedback) {
        deliver(pi, feedback, opts.feedbackPrefix);
      } else {
        ctx.ui.notify(`${opts.label} closed without output.`, "error");
      }
      return;
    }

    let stderr = "";
    try {
      stderr = await stderrP;
    } catch (err) {
      warnSuppressed(`${opts.label} stderr read`, err);
    }
    const exitCode = await exitedP;
    const feedback = extractFeedback(stdoutText, opts.json === true);
    if (exitCode !== 0 && !feedback) {
      const detail = stderr.trim() || `exit code ${exitCode}`;
      ctx.ui.notify(`${opts.label} failed: ${detail}`, "error");
      return;
    }
    if (feedback) {
      deliver(pi, feedback, opts.feedbackPrefix);
    } else {
      ctx.ui.notify(`${opts.label} closed (no feedback).`, "info");
    }
  } catch (err) {
    notifyPlannotatorError(ctx, opts.label, err);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUserPath(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const unquoted = stripped.replace(/^["']|["']$/g, "");
  const home = process.env.HOME || "";
  if (unquoted === "~") return home;
  if (unquoted.startsWith("~/") || unquoted.startsWith("~\\")) {
    return home + unquoted.slice(1);
  }
  return unquoted;
}

const PNL_MESSAGE_LIMIT = 25;

const PNL_SELECTOR_TITLE = "Select an assistant message to annotate (#1 = latest)";

const SUMMARY_WIDTH = 40;

interface SessionEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: unknown;
    isError?: unknown;
    details?: unknown;
  };
}

interface MessagePiece {
  kind: "text" | "reply";
  text: string;
}

function partToText(part: unknown): string {
  if (typeof part === "string") return part;
  if (part && typeof part === "object") {
    const obj = part as { text?: unknown; content?: unknown };
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
  }
  return "";
}

function replyWriteOf(part: unknown): { toolCallId: string; text: string } | undefined {
  if (!part || typeof part !== "object") return undefined;
  const call = part as { type?: unknown; name?: unknown; id?: unknown; arguments?: unknown };
  if (call.type !== "toolCall" || call.name !== "write" || typeof call.id !== "string") {
    return undefined;
  }
  if (!call.arguments || typeof call.arguments !== "object") return undefined;
  const args = call.arguments as { path?: unknown; file_path?: unknown; content?: unknown };
  const target = typeof args.path === "string" ? args.path : args.file_path;
  if (typeof target !== "string" || !/^out:\/\//i.test(target.trim())) return undefined;
  if (typeof args.content !== "string" || args.content.trim() === "") return undefined;
  return { toolCallId: call.id, text: args.content };
}

function toolResultReplies(details: unknown): string[] {
  if (!details || typeof details !== "object") return [];
  const replies = (details as { replies?: unknown }).replies;
  if (!Array.isArray(replies)) return [];
  return replies.filter((reply): reply is string => typeof reply === "string");
}

function joinPieces(pieces: MessagePiece[]): string {
  let out = "";
  let previousReply = false;
  for (const piece of pieces) {
    const reply = piece.kind === "reply";
    if (out) out += reply || previousReply ? "\n\n" : "\n";
    out += piece.text;
    previousReply = reply;
  }
  return out.trim();
}

function assistantMessagePieces(entries: unknown[], index: number, end: number): MessagePiece[] {
  const content = (entries[index] as SessionEntry | undefined)?.message?.content;
  const parts = Array.isArray(content) ? content : content === undefined ? [] : [content];
  const replyWrites = new Set<string>();
  for (const part of parts) {
    const reply = replyWriteOf(part);
    if (reply) replyWrites.add(reply.toolCallId);
  }
  const shownWrites = new Set<string>();
  const windowReplies: string[] = [];
  for (let i = index + 1; i < end; i++) {
    const message = (entries[i] as SessionEntry | undefined)?.message;
    if (message?.role !== "toolResult") continue;
    const toolCallId = message.toolCallId;
    if (typeof toolCallId === "string" && replyWrites.has(toolCallId) && message.isError !== true) {
      shownWrites.add(toolCallId);
    }
    windowReplies.push(...toolResultReplies(message.details));
  }
  const pieces: MessagePiece[] = [];
  for (const part of parts) {
    const text = partToText(part);
    if (text) pieces.push({ kind: "text", text });
    const reply = replyWriteOf(part);
    if (reply && shownWrites.has(reply.toolCallId)) pieces.push({ kind: "reply", text: reply.text });
  }
  for (const reply of windowReplies) pieces.push({ kind: "reply", text: reply });
  return pieces;
}

function collectAssistantTexts(ctx: CommandCtx, limit: number): string[] {
  const manager = ctx.sessionManager;
  const entries =
    (typeof manager?.getBranch === "function"
      ? manager.getBranch()
      : manager?.getEntries?.()) || [];
  const assistantIndexes: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as SessionEntry | undefined;
    if (entry?.type === "message" && entry.message?.role === "assistant") assistantIndexes.push(i);
  }
  const texts: string[] = [];
  for (let n = assistantIndexes.length - 1; n >= 0 && texts.length < limit; n--) {
    const index = assistantIndexes[n];
    const end = n + 1 < assistantIndexes.length ? assistantIndexes[n + 1] : entries.length;
    const text = joinPieces(assistantMessagePieces(entries, index, end));
    if (text) texts.push(text);
  }
  return texts;
}

function stripMarkdownNoise(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)_{1,2}([^_]+)_{1,2}(?=\s|$)/g, "$1$2")
    .replace(/[*`]+/g, "")
    .trim();
}

function truncateSummary(line: string): string {
  const chars = Array.from(line);
  return chars.length > SUMMARY_WIDTH ? `${chars.slice(0, SUMMARY_WIDTH).join("")}…` : line;
}

function summarizeMessage(text: string): string {
  let fallback = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cleaned = stripMarkdownNoise(line);
    if (cleaned) return truncateSummary(cleaned);
    if (!fallback) fallback = line;
  }
  return truncateSummary(fallback);
}

function messageOption(text: string, ordinal: number): SelectOption {
  return {
    label: `#${ordinal} · ${summarizeMessage(text)}`,
    description: `${Array.from(text).length} 字符`,
  };
}

export default function plannotatorCli(pi: PiLike): void {

  pi.registerCommand("pnr", {
    description: "Open Plannotator code review for local git changes or a PR/MR URL",
    handler: async (args, ctx) => {
      const url = (args ?? "").trim();
      const cmdArgs = url ? ["review", url] : ["review"];
      ctx.ui.notify(
        url ? `Opening code review for ${url}...` : "Opening code review in browser...",
        "info",
      );
      void runPlannotator(pi, ctx, cmdArgs, { label: "Code review" });
    },
  });

  pi.registerCommand("pna", {
    description: "Open Plannotator annotation UI for a markdown file, folder, or URL",
    handler: async (args, ctx) => {
      const target = normalizeUserPath(args ?? "");
      if (!target) {
        ctx.ui.notify("Usage: /pna <file.md | folder/ | https://...>", "error");
        return;
      }

      ctx.ui.notify(`Opening annotation UI for ${target}...`, "info");
      void runPlannotator(pi, ctx, ["annotate", target, "--json"], {
        label: "Annotation",
        json: true,
      });
    },
  });

  pi.registerCommand("pnl", {
    description: "Annotate a recent assistant message in Plannotator",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/pnl requires an interactive terminal (no UI available in this session).",
          "error",
        );
        return;
      }

      const texts = collectAssistantTexts(ctx, PNL_MESSAGE_LIMIT);
      if (texts.length === 0) {
        ctx.ui.notify("No assistant message found in session.", "error");
        return;
      }

      let ordinal = 1;
      if (texts.length > 1) {
        const options = texts.map((text, i) => messageOption(text, i + 1));
        const picked = await ctx.ui.select(PNL_SELECTOR_TITLE, options, { initialIndex: 0 });
        if (picked === undefined) return;
        const index = options.findIndex((option) => option.label === picked);
        if (index < 0) return;
        ordinal = index + 1;
      }
      const message = texts[ordinal - 1];

      ctx.ui.notify(
        ordinal === 1
          ? "Opening annotation UI for last message..."
          : `Opening annotation UI for assistant message #${ordinal}...`,
        "info",
      );
      void runPlannotator(pi, ctx, ["annotate-last", "--stdin", "--json"], {
        label: "Annotation",
        json: true,
        stdin: message,
        feedbackPrefix: pnlFeedbackPrefix(ordinal),
      });
    },
  });
}
