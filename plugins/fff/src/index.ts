/**
 * fff: FFF-powered fuzzy file and content search for OMP
 *
 * Provides two tools: fffind (fuzzy file search) and ffgrep (content search).
 * Forked from @ff-labs/pi-fff, stripped to tools-only (no autocomplete,
 * commands, or multi-grep).
 */

import nodePath from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
  FileFinderApi,
  GrepCursor,
  GrepMode,
  GrepResult,
  SearchResult,
} from "@ff-labs/fff-node";
import { Type, type TSchema } from "@sinclair/typebox";
import { AuxFinderPool, routePathConstraint } from "./aux-finders";
import { loadConfig } from "./config";
import { FilePickerFactory } from "./file-picker";
import { isHomeDir, resolveDbPaths } from "./paths";
import { buildQuery } from "./query";

export { SCAN_TIMEOUT_MS } from "./sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_NAME_GREP = "ffgrep";
const TOOL_NAME_FIND = "fffind";

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_PAGE_SIZE_MAX = 50;
const GREP_CONTEXT_MAX = 20;
const GREP_MAX_LINE_LENGTH = 500;

// If we exceed 10 seconds for indexed grep - something is definitely off
const GREP_TIME_BUDGET_MS = 10_000;

const HOME_SCAN_STATUS_KEY = "fff";
const HOME_SCAN_POLL_MS = 1_000;
const HOME_SCAN_DISABLE_HINT =
  "You can prevent home dir indexing with FFF_ENABLE_HOME_SCAN=0, or enableHomeDirScanning in omp-fff.json.";

// ---------------------------------------------------------------------------
// Cursor store — simple bounded Map for pagination cursors
// ---------------------------------------------------------------------------

const cursorCache = new Map<string, GrepCursor>();
let cursorCounter = 0;

function storeCursor(cursor: GrepCursor): string {
  const id = `fff_c${++cursorCounter}`;
  cursorCache.set(id, cursor);
  if (cursorCache.size > 200) {
    const first = cursorCache.keys().next().value;
    if (first) cursorCache.delete(first);
  }
  return id;
}

function getCursor(id: string): GrepCursor | undefined {
  return cursorCache.get(id);
}

// Find pagination uses a page-index cursor: native `fileSearch` takes
// pageIndex/pageSize, so the cursor is just the next page index paired with
// the query+limit that produced it. Stored tokens are opaque IDs to the agent.
interface FindCursor {
  query: string;
  pattern: string;
  pageSize: number;
  nextPageIndex: number;
  auxRoot?: string;
}

const findCursorCache = new Map<string, FindCursor>();
let findCursorCounter = 0;

function storeFindCursor(cursor: FindCursor): string {
  const id = `${++findCursorCounter}`;
  findCursorCache.set(id, cursor);
  if (findCursorCache.size > 200) {
    const first = findCursorCache.keys().next().value;
    if (first) findCursorCache.delete(first);
  }
  return id;
}

function getFindCursor(id: string): FindCursor | undefined {
  return findCursorCache.get(id);
}

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

// Clamp caller-supplied context to a non-negative bounded integer so a large
// value cannot multiply output size past the model window.
function clampContext(context: number | undefined): number {
  if (!context || context < 0) return 0;
  return Math.min(Math.floor(context), GREP_CONTEXT_MAX);
}

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;

// Shared annotation helper for both find-output paths and grep-output file
// headers. Returns at most ONE tag so output stays scannable. Priority:
// git-dirty (most actionable — file is changing right now) beats frecency
// (historically often-touched). Keeping one function ensures the two tools
// never drift in how they surface git/frecency signal.
function fffFileAnnotation(item: {
  gitStatus?: string;
  totalFrecencyScore?: number;
  accessFrecencyScore?: number;
}): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown" && git !== "") {
    return `  [${git} in git]`;
  }

  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
  if (frecency >= WARM_FRECENCY) return "  [often touched file]";

  return "";
}

// DO NOT ATTEMPT TO RESORT OUTPUT HERE IT ONLY CONFUSES MODELS
function formatGrepOutput(result: GrepResult): string {
  if (result.items.length === 0) return "No matches found";

  // Build file-grouped output in the order files first appear in the result.
  // This preserves native frecency ordering across files without re-sorting.
  const lines: string[] = [];
  let currentFile = "";

  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fffFileAnnotation(match)}`);
    }

    match.contextBefore?.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber - match.contextBefore!.length + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });

    lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

    match.contextAfter?.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber + 1 + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });
  }

  return lines.join("\n");
}

// Weak-match threshold is derived from the query length, matching the
// scoring formula in crates/fff-core/src/score.rs: a perfect match scores
// `len * 16`, so we treat anything below 50% of that as scattered fuzzy noise.
// When the top score is weak, trim output to a small sample instead of dumping
// the full limit worth of noise into the agent's context.
const FIND_WEAK_SAMPLE_SIZE = 5;

function weakScoreThreshold(pattern: string): number {
  const perfect = pattern.length * 12;
  return Math.floor((perfect * 50) / 100);
}

interface FormattedFind {
  output: string;
  weak: boolean;
  shownCount: number;
}

function formatFindOutput(
  result: SearchResult,
  limit: number,
  pattern: string,
): FormattedFind {
  if (result.items.length === 0) {
    return {
      output: "No files found matching pattern",
      weak: false,
      shownCount: 0,
    };
  }

  // NO CUSTOM SORTING — trust native frecency order from the engine.
  const reordered = result.items.map((item) => ({ item }));

  // Peek at the top native score to decide whether results are scattered
  // fuzzy noise (query length-scaled threshold from score.rs).
  const topScore = result.scores[0]?.total ?? 0;
  const weak = topScore < weakScoreThreshold(pattern);
  const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
  const shown = reordered.slice(0, effective);

  return {
    output: shown
      .map((p) => `${p.item.relativePath}${fffFileAnnotation(p.item)}`)
      .join("\n"),
    weak,
    shownCount: shown.length,
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fffExtension(pi: ExtensionAPI) {
  let mainFinder: FileFinderApi | null = null;
  let finderCwd: string | null = null;
  // Concurrent ensureFinder() callers share the same in-flight promise so
  // FileFinder.create() (which takes native DB locks) runs at most once per
  // base path at a time — otherwise parallel tool calls would race and
  // deadlock at the native layer (issue #403).
  let finderPromise: Promise<FileFinderApi> | null = null;
  let activeCwd = process.cwd();

  const config = loadConfig();

  let resolvedDbPaths: ReturnType<typeof resolveDbPaths>;
  let enableFsRootScanning = false;
  let enableHomeDirScanning = true;

  function resolveStartupConfig(): void {
    resolvedDbPaths = resolveDbPaths({
      frecency: process.env.FFF_FRECENCY_DB || config.frecencyDbPath || undefined,
      history: process.env.FFF_HISTORY_DB || config.historyDbPath || undefined,
    });

    // Root scanning opt-in: FFF refuses to init at / unless this is set.
    enableFsRootScanning =
      process.env.FFF_ENABLE_ROOT_SCAN === "1" || config.enableFsRootScanning || false;
    // Home dir scanning is on by default (launching from $HOME is a normal
    // flow), but configurable so users with huge $HOME trees can opt out.
    const envHome = process.env.FFF_ENABLE_HOME_SCAN;
    enableHomeDirScanning = envHome === undefined ? (config.enableHomeDirScanning ?? true) : envHome !== "0";
  }

  // Set on session_start; the only handle to the UI outside an event handler.
  // setStatus is TUI/RPC-only, hence optional.
  let uiCtx: {
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => void;
      setStatus?: (key: string, text: string | undefined) => void;
    };
  } | null = null;
  let homeScanTimer: ReturnType<typeof setInterval> | null = null;

  function warnHomeDirScan(root: string): void {
    uiCtx?.ui.notify(
      `(fff): Your cwd (${root}) is too large. Indexing will take additional time and resources.\n${HOME_SCAN_DISABLE_HINT}`,
      "warning",
    );
  }

  let pickers: FilePickerFactory | null = null;
  let auxPool: AuxFinderPool | null = null;

  function initializeFinderFactories(): void {
    if (pickers) return;

    pickers = new FilePickerFactory({
      frecencyDbPath: resolvedDbPaths.frecency,
      historyDbPath: resolvedDbPaths.history,
      onDbFailure: (error) =>
        uiCtx?.ui.notify(
          `(fff): Failed to open frecency/history database (${error}). Continuing without frecency persistence.`,
          "error",
        ),
    });
    auxPool = new AuxFinderPool({
      enableFsRootScanning,
      enableHomeDirScanning,
      onHomeDirScan: warnHomeDirScan,
      pickers,
    });
  }

  // in case cwd changes we need to figure this out
  function ensureFinder(cwd: string): Promise<FileFinderApi> {
    if (mainFinder && !mainFinder.isDestroyed && finderCwd === cwd)
      return Promise.resolve(mainFinder);

    if (finderPromise) return finderPromise;

    finderPromise = (async () => {
      if (mainFinder && !mainFinder.isDestroyed) {
        mainFinder.destroy();
        mainFinder = null;
        finderCwd = null;
      }

      // if the dbs can't be opened the factory falls back to a db-less picker,
      // e.g. when some other process corrupts the lock
      if (!pickers) throw new Error("FFF picker factory is not initialized");
      mainFinder = await pickers.create({
        basePath: cwd,
        enableHomeDirScanning,
        enableFsRootScanning,
      });
      finderCwd = cwd;
      return mainFinder;
    })().finally(() => {
      finderPromise = null;
    });

    return finderPromise;
  }

  function stopHomeScanStatus(): void {
    if (homeScanTimer) {
      clearInterval(homeScanTimer);
      homeScanTimer = null;
    }
    uiCtx?.ui.setStatus?.(HOME_SCAN_STATUS_KEY, undefined);
  }

  // waitForScan() resolves on timeout too, so the scan can still be running.
  // Poll the live progress until it settles, then clear the footer.
  function trackHomeScanStatus(): void {
    stopHomeScanStatus();
    if (!uiCtx?.ui.setStatus) return;

    const tick = () => {
      const progress = mainFinder?.getScanProgress?.();
      if (!progress?.ok || !progress.value.isScanning) {
        stopHomeScanStatus();
        return;
      }
      uiCtx?.ui.setStatus?.(
        HOME_SCAN_STATUS_KEY,
        `Agent is indexing $HOME (${progress.value.scannedFilesCount} files), this can lead to high CPU`,
      );
    };

    homeScanTimer = setInterval(tick, HOME_SCAN_POLL_MS);
    // Must not hold the process open once OMP is done.
    (homeScanTimer as { unref?: () => void }).unref?.();
    tick();
  }

  function destroyFinder() {
    stopHomeScanStatus();
    if (mainFinder && !mainFinder.isDestroyed) {
      mainFinder.destroy();
      mainFinder = null;
      finderCwd = null;
    }

    auxPool?.destroy();
    auxPool = null;
    pickers = null;
  }

  async function resolveFinderForPath(
    pathParam: string | undefined,
    pattern: string,
    exclude: string | string[] | undefined,
  ): Promise<{ finder: FileFinderApi; query: string; root: string } | null> {
    const route = routePathConstraint(pathParam, activeCwd);
    if (!route) return null;
    if (!auxPool) throw new Error("FFF auxiliary finder pool is not initialized");
    const aux = await auxPool.acquire(route.root);
    // A broader covering picker may have been reused; rebase the suffix so the
    // constraint stays relative to the picker's actual root.
    const rebase = nodePath.relative(aux.root, route.root).replaceAll(nodePath.sep, "/");
    const suffix = [rebase, route.suffix].filter(Boolean).join("/");
    const query = buildQuery(suffix || undefined, pattern, exclude, aux.root);
    return { finder: aux.finder, query, root: aux.root };
  }

  type PendingToolDefinition<
    TParams extends TSchema,
    TDetails = unknown,
    TState = any,
  > = Omit<
    ToolDefinition<TParams, TDetails, TState>,
    "name" | "label" | "promptGuidelines"
  >;

  const pendingTools: (() => string)[] = [];
  let toolsRegistered = false;

  function queueTool<TParams extends TSchema, TDetails = unknown, TState = any>(
    name: string,
    definition: PendingToolDefinition<TParams, TDetails, TState>,
  ): void {
    pendingTools.push(() => {
      pi.registerTool({
        ...definition,
        name,
        label: name,
      } as ToolDefinition<TParams, TDetails, TState>);
      return name;
    });
  }

  function registerPendingTools(): void {
    if (toolsRegistered) return;

    const registeredNames = pendingTools.map((register) => register());
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...registeredNames])]);
    toolsRegistered = true;
  }

  function reportInitFailure(ctx: ExtensionContext, error: unknown): void {
    ctx.ui.notify(
      `FFF init failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }

  function prepareSession(ctx: ExtensionContext): void {
    activeCwd = ctx.cwd;
    uiCtx = ctx;
    if (toolsRegistered) return;

    resolveStartupConfig();
    initializeFinderFactories();
    registerPendingTools();
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      prepareSession(ctx);
      await ensureFinder(activeCwd);

      // Warn when launched from $HOME with home scanning on: indexing a large
      // home tree can run for a long time in the background (issue #743).
      const atHome = enableHomeDirScanning && isHomeDir(activeCwd);
      if (atHome) {
        warnHomeDirScan(activeCwd);
        ctx.ui.setStatus?.(
          HOME_SCAN_STATUS_KEY,
          "Agent is indexing $HOME, this can lead to high CPU",
        );
      }

      // waitForScan() also resolves on timeout, so poll until the scan really
      // settles before clearing the footer.
      if (atHome) trackHomeScanStatus();
    } catch (error: unknown) {
      reportInitFailure(ctx, error);
    }
  });

  // SDK callers can prompt without binding session_start. Prepare on the first
  // agent turn as a fallback so the tools still reach that turn's tool set.
  pi.on("before_agent_start", (_event, ctx) => {
    if (toolsRegistered) return;
    try {
      prepareSession(ctx);
    } catch (error: unknown) {
      reportInitFailure(ctx, error);
    }
  });

  pi.on("session_shutdown", async () => {
    destroyFinder();
  });

  // --- Shared render helpers ---

  const renderTextResult = (
    result: { content?: { type: string; text?: string }[] },
    options: { expanded?: boolean },
    theme: any,
    context: any,
    maxLines = 15,
  ) => {
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    const output = result.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
    if (!output) {
      text.setText(theme.fg("muted", "No output"));
      return text;
    }

    const lines = output.split("\n");
    const displayLines = lines.slice(0, options.expanded ? lines.length : maxLines);
    let content = `\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
    if (lines.length > displayLines.length) {
      content += theme.fg(
        "muted",
        `\n... (${lines.length - displayLines.length} more lines)`,
      );
    }
    text.setText(content);
    return text;
  };

  // --- grep tool ---

  const grepSchema = Type.Object({
    pattern: Type.String({
      description: "Search pattern (literal text or regex)",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path. Absolute, ~/, and ../ paths outside the workspace are also supported and searched with a separate index.",
      }),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
      }),
    ),
    caseSensitive: Type.Optional(
      Type.Boolean({
        description:
          "Force case-sensitive matching. Default uses smart-case (case-insensitive when pattern is all lowercase).",
      }),
    ),
    context: Type.Optional(
      Type.Number({
        description: `Context lines before+after each match (0-${GREP_CONTEXT_MAX})`,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `Max matches (default ${DEFAULT_GREP_LIMIT})`,
      }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Pagination cursor from previous result" }),
    ),
  });

  queueTool(TOOL_NAME_GREP, {
    description: `Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Default limit ${DEFAULT_GREP_LIMIT}.`,
    promptSnippet: "Grep contents",
    promptGuidelines: [
      `${TOOL_NAME_GREP}: prefer bare identifiers as patterns. Literal queries are most efficient.`,
      `${TOOL_NAME_GREP}: use path for include ('src/', '*.ts') and exclude for noise ('test/,*.min.js').`,
      `${TOOL_NAME_GREP}: caseSensitive: true when you need exact case (smart-case otherwise).`,
      `${TOOL_NAME_GREP}: after 1-2 greps, read the top match instead of more greps.`,
    ],
    parameters: grepSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const pattern = params.pattern;
      const aux = await resolveFinderForPath(params.path, pattern, params.exclude);

      const picker = aux ? aux.finder : await ensureFinder(activeCwd);
      const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      // pageSize caps TOTAL matches across all files; maxMatchesPerFile alone
      // only caps per-file, so limit=5 could still return a full SDK page.
      const pageSize = Math.min(effectiveLimit, GREP_PAGE_SIZE_MAX);
      const context = clampContext(params.context);
      const query = aux
        ? aux.query
        : buildQuery(params.path, pattern, params.exclude, activeCwd);

      // Auto-detect: regex if the pattern has regex metacharacters AND parses
      // as a valid regex, otherwise plain literal. The fuzzy fallback below
      // only kicks in for plain mode — regex queries are intentional.
      const hasRegexSyntax = pattern !== pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      let mode: GrepMode = hasRegexSyntax ? "regex" : "plain";
      if (mode === "regex") {
        try {
          new RegExp(pattern);
        } catch {
          mode = "plain";
        }
      }

      // Guard: the agent keeps calling grep with '.*' or similar wildcard-only regex
      // to try to read a whole file. That's not what grep is for — return a terse error
      // steering them to a real pattern, preventing dozens of wasted retries.
      const p = pattern.trim();
      const isWildcardOnly =
        hasRegexSyntax &&
        /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(
          p,
        );

      if (isWildcardOnly) {
        return {
          content: [
            {
              type: "text",
              text: `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier. Example: \`pattern: 'MyClass'\` or \`pattern: 'export function'\`.`,
            },
          ],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      // caseSensitive override flips smartCase off; omitting it keeps smart-case
      // (case-insensitive when pattern is all lowercase).
      const smartCase = params.caseSensitive !== true;

      const grepResult = picker.grep(query, {
        mode,
        smartCase,
        maxMatchesPerFile: pageSize,
        pageSize,
        cursor: (params.cursor ? getCursor(params.cursor) : null) ?? null,
        beforeContext: context,
        afterContext: context,
        classifyDefinitions: true,
        timeBudgetMs: GREP_TIME_BUDGET_MS,
      });

      if (!grepResult.ok) throw new Error(grepResult.error);

      let result = grepResult.value;
      let fuzzyNotice: string | null = null;

      // if we hit the timeout do not run the fuzzy fallback
      // cause it will only consumer more time
      if (
        result.items.length === 0 &&
        !result.nextCursor &&
        !params.cursor &&
        mode !== "regex"
      ) {
        // When the caller pinned a specific file (path has an extension), the
        // fuzzy fallback broadens across the whole picker — the file may just
        // be misnamed. For directory constraints (or no path), we keep the
        // constrained query so the fallback does not leak matches from
        // excluded / out-of-scope directories.
        const lastSeg = params.path?.split(/[\\/]/).pop() ?? "";
        const pathTargetsFile = /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSeg);
        const fuzzyQuery = pathTargetsFile ? pattern : query;
        const fuzzy = picker.grep(fuzzyQuery, {
          mode: "fuzzy",
          smartCase,
          maxMatchesPerFile: pageSize,
          pageSize,
          cursor: null,
          beforeContext: 0,
          afterContext: 0,
          classifyDefinitions: true,
          timeBudgetMs: GREP_TIME_BUDGET_MS,
        });

        if (fuzzy.ok && fuzzy.value.items.length > 0) {
          fuzzyNotice = `0 exact matches. Maybe you meant this?`;
          result = fuzzy.value;
        }
      }

      let output = formatGrepOutput(result);
      const notices: string[] = [];
      if (result.regexFallbackError) {
        notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
      }
      if (result.nextCursor) {
        notices.push(`Continue with cursor="${storeCursor(result.nextCursor)}"`);
      }

      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

      return {
        content: [{ type: "text", text: output }],
        details: {
          totalMatched: result.totalMatched,
          totalFiles: result.totalFiles,
        },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const pattern = args?.pattern ?? "";
      const path = args?.path ?? ".";
      let content =
        theme.fg("toolTitle", theme.bold(TOOL_NAME_GREP)) +
        " " +
        theme.fg("accent", `/${pattern}/`) +
        theme.fg("toolOutput", ` in ${path}`);
      if (args?.limit !== undefined)
        content += theme.fg("toolOutput", ` limit ${args.limit}`);
      if (args?.cursor) content += theme.fg("muted", ` (page)`);
      text.setText(content);
      return text;
    },

    renderResult(result, options, theme, context) {
      return renderTextResult(result, options, theme, context, 15);
    },
  });

  // --- find tool ---

  const findSchema = Type.Object({
    pattern: Type.String({
      description:
        "Fuzzy filename search and glob search. Frecency-ranked, git-aware. Multi-word = narrower (AND) not bound to order, use for multi word related concept search. Prefer this over ls/find/bash as the first exploration step whenever the user names a concept, feature, or symbol — it surfaces the relevant files in one call. Only use ls/read on a directory when you specifically need the alphabetical layout of an unknown repo, or when a concept search returned nothing.",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path. Absolute, ~/, and ../ paths outside the workspace are also supported and searched with a separate index.",
      }),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `Max results per page (default ${DEFAULT_FIND_LIMIT})`,
      }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Pagination cursor from previous result" }),
    ),
  });

  queueTool(TOOL_NAME_FIND, {
    description: `Fuzzy path search and glob search. Matches against the whole repo-relative path, not just the filename. Frecency-ranked, git-aware. Multi-word = narrower (AND). Default limit ${DEFAULT_FIND_LIMIT}.`,
    promptSnippet: "Find files by path or glob",
    promptGuidelines: [
      `${TOOL_NAME_FIND}: matches the WHOLE path, not just the filename — \`profile\` hits \`chrome/browser/profiles/x.cc\` too.`,
      `${TOOL_NAME_FIND}: keep queries to 1-2 terms; extra words narrow.`,
      `${TOOL_NAME_FIND}: use for paths, not content. Use ${TOOL_NAME_GREP} for content.`,
      `${TOOL_NAME_FIND}: for exact path matches use a glob in \`path\` — e.g. path: '**/profile.h' for exact filename, or path: 'src/**/profile.h' scoped to a subtree. Bare patterns are fuzzy.`,
      `${TOOL_NAME_FIND}: to list everything inside a directory, pass path: 'dir/**' with an empty or wildcard pattern instead of using pattern alone.`,
      `${TOOL_NAME_FIND}: use exclude: 'test/,*.min.js' to cut noise in large repos.`,
    ],
    parameters: findSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

      // if resumed we use the same picker as before
      const resumed = params.cursor ? getFindCursor(params.cursor) : undefined;
      const pool = auxPool;
      if (!pool) throw new Error("FFF auxiliary finder pool is not initialized");
      const aux = resumed
        ? resumed.auxRoot
          ? {
              finder: (await pool.acquire(resumed.auxRoot, { exact: true })).finder,
              root: resumed.auxRoot,
            }
          : null
        : await resolveFinderForPath(params.path, params.pattern, params.exclude);

      const picker = aux ? aux.finder : await ensureFinder(activeCwd);
      const effectiveLimit = resumed
        ? resumed.pageSize
        : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);

      const query = resumed
        ? resumed.query
        : aux && "query" in aux
          ? (aux as { query: string }).query
          : buildQuery(params.path, params.pattern, params.exclude, activeCwd);

      const pattern = resumed ? resumed.pattern : params.pattern;
      const pageIndex = resumed?.nextPageIndex ?? 0;
      const auxRoot = resumed?.auxRoot ?? aux?.root;

      const searchResult = picker.fileSearch(query, {
        pageIndex,
        pageSize: effectiveLimit,
      });
      if (!searchResult.ok) throw new Error(searchResult.error);

      const result = searchResult.value;
      const formatted = formatFindOutput(result, effectiveLimit, pattern);
      let output = formatted.output;

      // Infer hasMore: native fileSearch fills pageSize when more results
      // exist, so if we got a full page AND totalMatched exceeds what we've
      // shown so far there's another page to fetch.
      const shownSoFar = pageIndex * effectiveLimit + result.items.length;
      const hasMore =
        result.items.length >= effectiveLimit && result.totalMatched > shownSoFar;

      const notices: string[] = [];
      if (formatted.weak && formatted.shownCount > 0)
        notices.push(
          `Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`,
        );

      if (!formatted.weak && hasMore) {
        const remaining = result.totalMatched - shownSoFar;
        const cursorId = storeFindCursor({
          query,
          pattern,
          pageSize: effectiveLimit,
          nextPageIndex: pageIndex + 1,
          auxRoot,
        });
        notices.push(
          `${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`,
        );
      }

      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return {
        content: [{ type: "text", text: output }],
        details: {
          totalMatched: result.totalMatched,
          totalFiles: result.totalFiles,
          pageIndex,
          hasMore,
        },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const pattern = args?.pattern ?? "";
      const path = args?.path ?? ".";
      let content =
        theme.fg("toolTitle", theme.bold(TOOL_NAME_FIND)) +
        " " +
        theme.fg("accent", pattern) +
        theme.fg("toolOutput", ` in ${path}`);
      if (args?.limit !== undefined)
        content += theme.fg("toolOutput", ` (limit ${args.limit})`);
      if (args?.cursor) content += theme.fg("muted", ` (page)`);
      text.setText(content);
      return text;
    },

    renderResult(result, options, theme, context) {
      return renderTextResult(result, options, theme, context, 20);
    },
  });
}