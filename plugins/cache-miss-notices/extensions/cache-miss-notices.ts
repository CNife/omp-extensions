// @ts-nocheck
/**
 * cache-miss-notices — 显著的 prompt-cache miss 即时通知。
 *
 * 移植自 pi 的 showCacheMissNotices（packages/coding-agent/src/core/cache-stats.ts）。
 * 每条 assistant 消息结束时检测：如果本应命中缓存的 token 被重新计费且超过阈值，
 * 弹出一条 warning toast，告知浪费的 token 数和估算费用。
 *
 * 安装即启用，无需配置。
 */

// ============================================================================
// Detection (ported from pi cache-stats.ts)
// ============================================================================

/** Prompt-cache TTL: idle gaps longer than this are worth mentioning. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-turn misses at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;

/** Significance thresholds for showing a notice. */
const NOTICE_MIN_TOKENS = 20_000;
const NOTICE_MIN_COST = 0.1;

export interface CacheMiss {
  missedTokens: number;
  missedCost: number;
  idleMs: number;
  modelChanged: boolean;
}

interface PreviousRequest {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  /**
   * Sticky, but only within the same modelKey: some earlier request on this
   * model reported cache activity. Distinguishes a total miss on a
   * cache-read-only provider from a model that never reports caching at all.
   * Unlike pi (which sticks across the whole scan), the flag does NOT survive
   * a model switch: a model that never reports cache usage would otherwise be
   * misreported as a full miss on every turn after the switch.
   */
  reportedCache: boolean;
}

interface UsageLike {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { input: number; cacheRead: number; cacheWrite: number };
}

interface AssistantLike {
  provider: string;
  model: string;
  timestamp: number;
  usage: UsageLike;
}

function detectMiss(
  prev: PreviousRequest | undefined,
  msg: AssistantLike,
  cacheReadPricePerMillion: number,
): CacheMiss | undefined {
  const usage = msg.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (
    !prev ||
    promptTokens <= 0 ||
    (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)
  ) {
    return undefined;
  }

  const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken =
    paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
  const readPerToken =
    usage.cacheRead > 0
      ? usage.cost.cacheRead / usage.cacheRead
      : cacheReadPricePerMillion / 1_000_000;

  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, msg.timestamp - prev.timestamp),
    modelChanged: `${msg.provider}/${msg.model}` !== prev.modelKey,
  };
}

function asPreviousRequest(
  msg: AssistantLike,
  reportedCache: boolean,
): PreviousRequest | undefined {
  const usage = msg.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens <= 0) return undefined;
  return {
    promptTokens,
    modelKey: `${msg.provider}/${msg.model}`,
    timestamp: msg.timestamp,
    reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
  };
}

/**
 * Scan entries to find the previous request context, then detect a miss on
 * the just-completed message.
 *
 * Unlike pi (where message_end fires before persistence), omp persists the
 * message BEFORE emitting to extensions - so `entries` already contains
 * `msg`. We skip it by reference to avoid comparing the message against
 * itself.
 *
 * `reportedCache` is inherited only along a same-model chain: crossing a
 * model boundary restarts it, so switching to a model that never reports
 * cache usage counts at most the first post-switch turn (the model switch
 * itself) instead of misreporting every turn as a full miss.
 */
export function detectCacheMiss(
  entries: readonly { type: string; message?: unknown }[],
  msg: AssistantLike,
  cacheReadPricePerMillion: number,
): CacheMiss | undefined {
  let prev: PreviousRequest | undefined;

  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      prev = undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    const m = entry.message as { role: string } & Partial<AssistantLike> | undefined;
    if (!m || m.role !== "assistant" || !m.usage) continue;
    // Skip the current message (already persisted by omp before emit).
    if (m === msg) continue;
    const modelKey = `${m.provider}/${m.model}`;
    const inheritCache = prev?.modelKey === modelKey ? prev.reportedCache : false;
    prev = asPreviousRequest(m as AssistantLike, inheritCache) ?? prev;
  }

  return detectMiss(prev, msg, cacheReadPricePerMillion);
}

// ============================================================================
// Formatting
// ============================================================================

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatNotice(miss: CacheMiss): string {
  const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
  const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
  let label = "Cache miss";
  if (miss.modelChanged) {
    label = "Cache miss after model switch";
  } else if (miss.idleMs >= CACHE_TTL_MS) {
    label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
  }
  return `${label}: ${reBilled}`;
}

// ============================================================================
// Extension entry
// ============================================================================

export default function cacheMissNotices(pi: any) {
  pi.setLabel("Cache Miss Notices");

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;

    const msg = message as unknown as AssistantLike;
    if (!msg.usage) return;

    // Fallback cacheRead price from the current model's catalog entry.
    const model = ctx.model;
    const cacheReadPrice = model?.cost?.cacheRead ?? 0;

    const entries = ctx.sessionManager.getEntries();
    const miss = detectCacheMiss(entries, msg, cacheReadPrice);
    if (!miss) return;

    if (miss.missedTokens < NOTICE_MIN_TOKENS && miss.missedCost < NOTICE_MIN_COST) return;

    ctx.ui.notify(formatNotice(miss), "warning");
  });
}
