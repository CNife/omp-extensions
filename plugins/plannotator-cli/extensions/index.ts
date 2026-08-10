/**
 * plannotator-cli - OMP extension that shells out to the `plannotator` CLI.
 *
 * Three slash commands:
 *   /pnr [url]     - Browser-based code review for local git changes or a PR/MR URL
 *   /pna <target>  - Browser-based annotation for a markdown file, folder, or URL
 *   /pnl           - Annotate the last assistant message
 *
 * Requires the `plannotator` binary on PATH (>= 0.25.1, https://plannotator.ai/install.sh).
 * No npm dependencies; all UI/infra is handled by the CLI process.
 *
 * 架构（wayfinder map #43，2026-08）：
 * - CLI shell-out，复用官方 CLI 的进程内 HTTP server + HTML 资产，不依赖
 *   @plannotator/pi-extension npm 包（其 deliverAs:"followUp" 在 omp 上反馈断链）
 * - spawn 必设 BROWSER=none PLANNOTATOR_BROWSER=none：v0.26.7 存在罕见 ~1-3% 关闭期
 *   挂起（stdout 已写完整 JSON 但进程不退出），全部出现在未抑制浏览器
 *   （WSL2 cmd.exe /c start）的运行中；抑制后 0/89 次挂起
 *   （docs/research/plannotator-deadlock-v0.26.7.md）
 * - stdout JSON 完整即成功：不等 exited，残余挂起对用户体验零影响；
 *   json 模式解析决策 JSON 提取 feedback 字段投递，非 json 模式（/pnr）投递原始文本
 * - 超时兜底（默认 120s，PLANNOTATOR_FEEDBACK_TIMEOUT_MS 可覆盖）
 * - PLANNOTATOR_AI=disabled 默认注入：避免 CLI 派生嵌套 `pi --mode rpc` 子进程
 *   （AI 模型发现探针）；用户显式设置 PLANNOTATOR_AI 时尊重用户值
 * - 反馈直接 pi.sendUserMessage(feedback)：不带 deliverAs（"followUp" 只入队不启动
 *   回合，反馈会静默滞留到下一条显式输入）；不用 prompt 模板
 */

// ── 类型 ───────────────────────────────────────────────────────────────────

/** 插件用到的 omp ExtensionAPI 最小面（与 @earendil-works/pi-coding-agent 对齐）。 */
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

export interface CommandCtx {
  cwd: string;
  ui: { notify(message: string, type: "info" | "error"): void };
  sessionManager: {
    getBranch?(): unknown[];
    getEntries?(): unknown[];
  };
}

interface RunOptions {
  /** 通知与错误信息中的动作名，如 "Code review" / "Annotation"。 */
  label: string;
  /** CLI 以 --json 输出（/pna /pnl）：完整 JSON 行即视为成功，不等进程退出。 */
  json?: boolean;
  /** 写入子进程 stdin 的内容（/pnl annotate-last --stdin）。 */
  stdin?: string;
  /** 反馈投递时的 framing 前缀（/pnl：告知 AI 这是对上一条消息的标注）。 */
  feedbackPrefix?: string;
}

/** /pnl 反馈前缀：标注载体是会话内消息，反馈只有行号引用，无文件可查。 */
const PNL_FEEDBACK_PREFIX =
  "这是对你上一条助手消息的标注反馈，请直接处理，无需查找文件。";

// ── Spawn helpers ──────────────────────────────────────────────────────────

/** 构造子进程环境：继承父环境 + 强制项（#44 研究结论）。 */
function buildSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // 强制项：抑制浏览器启动路径，消除残余关闭期挂起（3 次挂起全在此路径）。
  env.BROWSER = "none";
  env.PLANNOTATOR_BROWSER = "none";
  // 默认禁用 AI 探针，避免 CLI 派生嵌套 `pi --mode rpc` 子进程；用户显式设置时尊重。
  if (env.PLANNOTATOR_AI === undefined) env.PLANNOTATOR_AI = "disabled";
  return env;
}

/** 从 stdout 提取反馈：json 模式解析取 feedback 字段，解析失败退化原始文本。 */
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
  // 省略 deliverAs：显式 deliverAs（如 "followUp"）只入队不启动回合，空闲时反馈会
  // 静默躺在队列里直到下一条显式输入；省略后空闲路径直接走 prompt() 启动回合。
  pi.sendUserMessage(prefix ? `${prefix}\n\n${feedback}` : feedback);
}

/** 归一化 plannotator 启动/运行错误通知：CLI 缺失与一般失败。 */
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

/** 运行 plannotator，将 stdout 反馈直接投递为会话用户消息。 */
async function runPlannotator(
  pi: PiLike,
  ctx: CommandCtx,
  args: string[],
  opts: RunOptions,
): Promise<void> {
  const timeoutMs =
    Number(process.env.PLANNOTATOR_FEEDBACK_TIMEOUT_MS) || 120_000;

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

  // spawn 配置固定 stdout/stderr/stdin 为 "pipe"，收窄 Bun 的 union 类型。
  const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
  const stderrStream = proc.stderr as ReadableStream<Uint8Array>;

  if (opts.stdin !== undefined) {
    try {
      // stdin 配置为 "pipe" 时是 FileSink（union 收窄到 object 分支）。
      const stdinSink = proc.stdin;
      if (typeof stdinSink === "object" && stdinSink !== null) {
        stdinSink.write(opts.stdin);
        stdinSink.end();
      }
    } catch {
      // 子进程可能已退出
    }
  }

  const stderrP = new Response(stderrStream).text();
  const exitedP = proc.exited;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  // stdout 累积在外部变量：timeout 兜底分支需要读取已累积的部分。
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
          // 等待完整 JSON
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
      // 兜底：stdout 若有内容仍投递（关闭期挂起场景 stdout 已完整），否则报错。
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      void stderrP.catch(() => {});
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
      // stdout JSON 完整即成功：不等 exited，残余关闭期挂起对体验零影响。
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      void stderrP.catch(() => {});
      const feedback = extractFeedback(stdoutText, true);
      if (feedback) {
        deliver(pi, feedback, opts.feedbackPrefix);
      } else {
        // 决策 JSON 完整但无 feedback（如 approved），当无反馈处理。
        ctx.ui.notify(`${opts.label} closed (no feedback).`, "info");
      }
      return;
    }

    // winner === "eof" | "exited"：stdout 已读完。进程可能已退出，也可能挂起
    // （stdout 关闭但进程不退出）；给短宽限等退出，超时则 kill。
    const exited = await Promise.race([
      exitedP.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    if (!exited) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      void stderrP.catch(() => {});
      const feedback = extractFeedback(stdoutText, opts.json === true);
      if (feedback) {
        deliver(pi, feedback, opts.feedbackPrefix);
      } else {
        ctx.ui.notify(`${opts.label} closed without output.`, "error");
      }
      return;
    }

    const stderr = await stderrP.catch(() => "");
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

// ── Path normalization ─────────────────────────────────────────────────────

/** 归一化用户输入路径：去 @ 前缀、去首尾引号、展开 ~。 */
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

// ── Last assistant message extraction ──────────────────────────────────────

interface SessionEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
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

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partToText).filter(Boolean).join("\n");
  if (content && typeof content === "object") return partToText(content);
  return "";
}

function getLastAssistantText(ctx: CommandCtx): string | undefined {
  const manager = ctx.sessionManager;
  const entries =
    (typeof manager?.getBranch === "function"
      ? manager.getBranch()
      : manager?.getEntries?.()) || [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as SessionEntry | undefined;
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const text = contentToText(entry.message.content).trim();
      if (text) return text;
    }
  }
  return undefined;
}

// ── Extension entry ─────────────────────────────────────────────────────────

export default function plannotatorCli(pi: PiLike): void {
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
      // review 无 --json 选项，stdout 为纯文本反馈。
      void runPlannotator(pi, ctx, cmdArgs, { label: "Code review" });
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
      // 不传 --markdown：HTML 文件按原始渲染，文件夹自动扫描，URL 直接抓取。
      void runPlannotator(pi, ctx, ["annotate", target, "--json"], {
        label: "Annotation",
        json: true,
      });
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

      ctx.ui.notify("Opening annotation UI for last message...", "info");
      // 消息内容经 stdin 传入（--stdin），无临时文件生命周期。
      void runPlannotator(pi, ctx, ["annotate-last", "--stdin", "--json"], {
        label: "Annotation",
        json: true,
        stdin: lastText,
        feedbackPrefix: PNL_FEEDBACK_PREFIX,
      });
    },
  });
}
