/**
 * plannotator-cli - OMP extension that shells out to the `plannotator` CLI.
 *
 * Three slash commands:
 *   /pnr [url]     - Browser-based code review for local git changes or a PR/MR URL
 *   /pna <target>  - Browser-based annotation for a markdown file, folder, or URL
 *   /pnl           - Annotate a recent assistant message (interactive selector)
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
 * - 超时兜底（默认 30min，PLANNOTATOR_FEEDBACK_TIMEOUT_MS 可覆盖）
 * - PLANNOTATOR_AI=disabled 默认注入：避免 CLI 派生嵌套 `pi --mode rpc` 子进程
 *   （AI 模型发现探针）；用户显式设置 PLANNOTATOR_AI 时尊重用户值
 * - 反馈直接 pi.sendUserMessage(feedback)：不带 deliverAs（"followUp" 只入队不启动
 *   回合，反馈会静默滞留到下一条显式输入）；不用 prompt 模板
 * - /pnl 消息选择器（#82）：ctx.ui.select 列出当前分支最近 25 条非空助手消息，
 *   默认光标停在最新一条（回车 = 旧行为）、Esc 取消不投递、仅 1 条可选时跳过选择器；
 *   hasUI=false（无 UI 的宿主，如 print / json）明确报错。选中的仍只是单条消息
 *   （ADR-0003）。rpc 模式的宿主自带 UI（选择器经 extension_ui_request 转发给客户端），
 *   故 hasUI=true，不报错
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

/** UI 选择列表项（对齐宿主 ExtensionUISelectOption）。 */
interface SelectOption {
  label: string;
  description?: string;
}

export interface CommandCtx {
  cwd: string;
  ui: {
    notify(message: string, type: "info" | "error"): void;
    /** 选择列表：返回被选中项的 label；用户取消（Esc）时返回 undefined。 */
    select(
      title: string,
      options: SelectOption[],
      dialogOptions?: { initialIndex?: number },
    ): Promise<string | undefined>;
  };
  /** false 表示 print / rpc / json 模式：选择器不可用。 */
  hasUI: boolean;
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

/** /pnl 反馈前缀。ordinal 为「倒数第几条助手消息」（1 = 最新一条）：
 *  ordinal 为 1 时与历史版本逐字一致，N > 1 时指明序号以便 AI 在会话里对位。 */
function pnlFeedbackPrefix(ordinal: number): string {
  return ordinal === 1
    ? PNL_FEEDBACK_PREFIX
    : `这是对倒数第 ${ordinal} 条助手消息的标注反馈，请直接处理，无需查找文件。`;
}

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

/** 默认反馈超时：覆盖整个人工审阅期（标注/审阅常需数分钟）。
 *  按人类活动时长尺度取值，而非投递耗时尺度（#38 实测正常投递 29-55s）——
 *  过短会在用户尚未点 Send Feedback 时误杀进程、丢失反馈。 */
const DEFAULT_FEEDBACK_TIMEOUT_MS = 30 * 60 * 1000;

/** 解析 PLANNOTATOR_FEEDBACK_TIMEOUT_MS：未设或非法值（非有限数 / ≤0）回退默认。 */
export function resolveFeedbackTimeoutMs(): number {
  const raw = process.env.PLANNOTATOR_FEEDBACK_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_FEEDBACK_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FEEDBACK_TIMEOUT_MS;
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

// ── Assistant message collection & selector ────────────────────────────────

/** /pnl 选择器最多列出多少条消息（与 plannotator 官方 RECENT_MESSAGES_LIMIT 对齐）。 */
const PNL_MESSAGE_LIMIT = 25;

const PNL_SELECTOR_TITLE = "Select an assistant message to annotate";

/** 摘要宽度（字符数），超出即截断加省略号。 */
const SUMMARY_WIDTH = 40;

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

/** 倒序收集当前分支上最近的非空助手消息文本（索引 0 = 最新一条，最多 limit 条）。 */
function collectAssistantTexts(ctx: CommandCtx, limit: number): string[] {
  const manager = ctx.sessionManager;
  const entries =
    (typeof manager?.getBranch === "function"
      ? manager.getBranch()
      : manager?.getEntries?.()) || [];
  const texts: string[] = [];
  for (let i = entries.length - 1; i >= 0 && texts.length < limit; i--) {
    const entry = entries[i] as SessionEntry | undefined;
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const text = contentToText(entry.message.content).trim();
      if (text) texts.push(text);
    }
  }
  return texts;
}

/** 剥离 markdown 噪声：标题符号、链接/图片语法、强调符、行内代码符。 */
function stripMarkdownNoise(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]+/g, "")
    .trim();
}

function truncateSummary(line: string): string {
  return line.length > SUMMARY_WIDTH ? `${line.slice(0, SUMMARY_WIDTH)}…` : line;
}

/** 首行摘要：首个剥离噪声后非空的行的截断；整行都是噪声时退回首行原文。 */
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

/** 选择器选项：label 以「倒数第 N 条」序号前缀保证唯一（宿主回传值只有 label），
 *  description 给出该消息的体量（字符数）。 */
function messageOption(text: string, ordinal: number): SelectOption {
  return {
    label: `倒数第 ${ordinal} 条 · ${summarizeMessage(text)}`,
    description: `${text.length} 字符`,
  };
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
    description: "Annotate a recent assistant message in Plannotator",
    handler: async (_args, ctx) => {
      // 选择器只在有 UI 的宿主里可用（hasUI=false 的 print/json 等模式）：
      // 明确报错，而不是静默退化成"标注最后一条"。
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

      // 选项从新到旧，故 initialIndex: 0 即最新一条（回车 = 旧行为）；
      // 只有一条可选消息时不弹选择器。
      let ordinal = 1;
      if (texts.length > 1) {
        const options = texts.map((text, i) => messageOption(text, i + 1));
        const picked = await ctx.ui.select(PNL_SELECTOR_TITLE, options, { initialIndex: 0 });
        if (picked === undefined) return; // Esc：静默取消，不投递
        const index = options.findIndex((option) => option.label === picked);
        if (index < 0) return; // 回传了未知 label：按取消处理
        ordinal = index + 1;
      }
      const message = texts[ordinal - 1];

      ctx.ui.notify(
        ordinal === 1
          ? "Opening annotation UI for last message..."
          : `Opening annotation UI for assistant message ${ordinal} back...`,
        "info",
      );
      // 消息内容经 stdin 传入（--stdin），无临时文件生命周期。
      void runPlannotator(pi, ctx, ["annotate-last", "--stdin", "--json"], {
        label: "Annotation",
        json: true,
        stdin: message,
        feedbackPrefix: pnlFeedbackPrefix(ordinal),
      });
    },
  });
}
