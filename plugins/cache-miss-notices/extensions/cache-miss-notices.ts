const CACHE_TTL_MS = 5 * 60 * 1000;

const NOISE_FLOOR_TOKENS = 1024;

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
  reportedCache: boolean;
}

interface UsageLike {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { input: number; cacheRead: number; cacheWrite: number };
}

export interface AssistantLike {
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
    if (m === msg) continue;
    const modelKey = `${m.provider}/${m.model}`;
    const inheritCache = prev?.modelKey === modelKey ? prev.reportedCache : false;
    prev = asPreviousRequest(m as AssistantLike, inheritCache) ?? prev;
  }

  return detectMiss(prev, msg, cacheReadPricePerMillion);
}

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

interface MessageEndEvent {
  message: { role: string } & Partial<AssistantLike>;
}

interface MessageEndContext {
  model?: { cost?: { cacheRead?: number } };
  sessionManager: { getEntries(): readonly { type: string; message?: unknown }[] };
  ui: { notify(text: string, level: string): void };
}

export default function cacheMissNotices(pi: any) {
  pi.setLabel("Cache Miss Notices");

  pi.on("message_end", async (event: MessageEndEvent, ctx: MessageEndContext) => {
    const message = event.message;
    if (message.role !== "assistant") return;

    const msg = message as unknown as AssistantLike;
    if (!msg.usage) return;

    const model = ctx.model;
    const cacheReadPrice = model?.cost?.cacheRead ?? 0;

    const entries = ctx.sessionManager.getEntries();
    const miss = detectCacheMiss(entries, msg, cacheReadPrice);
    if (!miss) return;

    if (miss.missedTokens < NOTICE_MIN_TOKENS && miss.missedCost < NOTICE_MIN_COST) return;

    ctx.ui.notify(formatNotice(miss), "warning");
  });
}
