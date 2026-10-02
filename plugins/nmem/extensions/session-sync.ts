// @ts-nocheck
/**
 * nmem 会话同步 — 把 OMP 会话同步为 Nowledge Mem 线程。
 *
 * Ported from @cnife/pi-nmem (packages/nmem/ambient.ts — sync half only)。
 * 文本归一化、payload 构造、两阶段 create/append 状态机、线程重建、
 * inFlight/pending 去重、通知去重都是 implementation；
 * 对外只有 flush(ctx, reason) / scheduleFlush(ctx, reason)。
 */

import { basename } from "node:path";

import { NmemError, nmemRequest } from "./rest.ts";

type JsonObject = Record<string, unknown>;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

// ============================================================================
// Ambient sync (ported from ambient.ts — sync half only)
// ============================================================================

const MAX_MESSAGE_CHARS = 20_000;
const FLUSH_DELAY_MS = 750;
const DEFAULT_PLUGIN_VERSION = "omp-nmem/0.2.0";

// --- Source identity ---

function sourceApp(): string {
  // "omp" keeps thread_id prefix (omp-) stable with the official plugin
  // for data continuity. Env override available for advanced use.
  return process.env.NMEM_PLUGIN_SOURCE_APP?.trim() || "omp";
}

function hostLabel(): string {
  return process.env.NMEM_PLUGIN_HOST_LABEL?.trim() || "OMP";
}

function pluginVersion(): string {
  return process.env.NMEM_PLUGIN_VERSION?.trim() || DEFAULT_PLUGIN_VERSION;
}

// --- Types ---

interface ThreadMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

interface SyncState {
  created?: boolean;
  lastSyncedCount?: number;
  lastError?: string;
  inFlight?: Promise<void>;
  pending?: boolean;
  timer?: unknown;
}

interface SyncPayload {
  threadId: string;
  sessionId: string;
  messages: ThreadMessage[];
  body: JsonObject;
}

interface SessionManagerLike {
  getBranch?: () => JsonObject[];
  getEntries?: () => JsonObject[];
  getSessionId?: () => string;
  getSessionFile?: () => string | undefined;
  getSessionName?: () => string | undefined;
  getCwd?: () => string;
}

// --- Module state ---

const syncStates = new Map<string, SyncState>();
const syncNotifyWarnings = new Set<string>();

// --- Text helpers ---

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CHARS)}\n\n[${hostLabel()} message truncated by nmem sync]`;
}

function partToText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const value = part as JsonObject;
  const type = stringValue(value.type) || "part";
  if (type === "text") {
    return stringValue(value.text) || stringValue(value.content) || "";
  }
  if (type === "image") return "[Image]";
  if (type === "toolUse" || type === "tool" || type === "toolCall") {
    const name = stringValue(value.name) || stringValue(value.tool) || "tool";
    return `[Tool: ${name}]`;
  }
  if (type === "file") {
    const label = stringValue(value.filename) || stringValue(value.path) || "attachment";
    return `[File: ${label}]`;
  }
  const text = stringValue(value.text) || stringValue(value.content);
  return text || `[${type}]`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partToText).filter(Boolean).join("\n");
  if (content && typeof content === "object") return partToText(content);
  return "";
}

function messageToText(message: JsonObject): string {
  const role = stringValue(message.role);
  if (role === "bashExecution") {
    const command = stringValue(message.command) || "";
    const output = stringValue(message.output) || "(no output)";
    const exitCode = message.exitCode;
    const suffix =
      typeof exitCode === "number" && exitCode !== 0
        ? `\n\nCommand exited with code ${exitCode}`
        : "";
    return `Ran \`${command}\`\n\`\`\`\n${output}\n\`\`\`${suffix}`;
  }
  if (role === "branchSummary") {
    return `${hostLabel()} branch summary:\n${stringValue(message.summary) || ""}`;
  }
  if (role === "compactionSummary") {
    return `${hostLabel()} compaction summary:\n${stringValue(message.summary) || ""}`;
  }
  return contentToText(message.content);
}

function normalizeRole(role: unknown): "user" | "assistant" | "system" | undefined {
  if (role === "user" || role === "bashExecution") return "user";
  if (
    role === "assistant" ||
    role === "toolResult" ||
    role === "branchSummary" ||
    role === "compactionSummary"
  ) {
    return "assistant";
  }
  return undefined;
}

function buildEntryMetadata(entry: JsonObject, index: number, ambient: JsonObject): JsonObject {
  return {
    external_id: `${sourceApp()}-entry-${stringValue(entry.id) || index}`,
    pi_entry_id: stringValue(entry.id),
    pi_entry_type: entry.type,
    ...ambient,
  };
}

function entryToMessage(entry: JsonObject, index: number, ambient: JsonObject): ThreadMessage | undefined {
  if (entry.type === "message") {
    const message = entry.message;
    if (!message || typeof message !== "object") return undefined;
    const msg = message as JsonObject;
    if (msg.role === "custom") return undefined;
    const role = normalizeRole(msg.role);
    if (!role) return undefined;
    const content = truncate(messageToText(msg).trim());
    if (!content) return undefined;
    return {
      role,
      content,
      timestamp: stringValue(entry.timestamp),
      metadata: {
        ...buildEntryMetadata(entry, index, ambient),
        pi_message_role: stringValue(msg.role),
      },
    };
  }

  if (entry.type === "custom_message") {
    const content = truncate(contentToText(entry.content).trim());
    if (!content) return undefined;
    return {
      role: "user",
      content: `${hostLabel()} custom context${stringValue(entry.customType) ? ` (${stringValue(entry.customType)})` : ""}:\n${content}`,
      timestamp: stringValue(entry.timestamp),
      metadata: {
        ...buildEntryMetadata(entry, index, ambient),
        pi_custom_type: stringValue(entry.customType),
        pi_custom_display: typeof entry.display === "boolean" ? entry.display : undefined,
      },
    };
  }

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    const label =
      entry.type === "compaction"
        ? `${hostLabel()} compaction summary`
        : `${hostLabel()} branch summary`;
    const content = truncate(`${label}:\n${stringValue(entry.summary) || ""}`.trim());
    if (!content) return undefined;
    return {
      role: "assistant",
      content,
      timestamp: stringValue(entry.timestamp),
      metadata: buildEntryMetadata(entry, index, ambient),
    };
  }

  return undefined;
}

function buildMessages(ctx: any): ThreadMessage[] {
  const ambient: JsonObject = { source_app: sourceApp() };
  const manager = ctx.sessionManager as unknown as SessionManagerLike;
  const entries =
    typeof manager.getBranch === "function"
      ? manager.getBranch()
      : manager.getEntries?.() || [];
  return entries
    .map((entry, index) => entryToMessage(entry, index, ambient))
    .filter((msg): msg is ThreadMessage => !!msg);
}

function sessionId(ctx: any): string {
  const manager = ctx.sessionManager as unknown as SessionManagerLike;
  const id = manager.getSessionId?.();
  if (id) return id;
  const file = manager.getSessionFile?.();
  if (file) return basename(file).replace(/\.jsonl$/i, "");
  return "unknown";
}

function threadIdFor(ctx: any): string {
  return `${sourceApp()}-${sessionId(ctx)}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
}

function buildTitle(ctx: any, messages: ThreadMessage[]): string {
  const manager = ctx.sessionManager as unknown as SessionManagerLike;
  const name = manager.getSessionName?.()?.trim();
  if (name) return name;
  const firstUser = messages.find((msg) => msg.role === "user")?.content.trim();
  if (firstUser) return firstUser.slice(0, 120);
  const cwd = manager.getCwd?.();
  return cwd ? `${hostLabel()} session - ${basename(cwd)}` : `${hostLabel()} session`;
}

function shouldSync(messages: ThreadMessage[]): boolean {
  return (
    messages.some((msg) => msg.role === "user") &&
    messages.some((msg) => msg.role === "assistant")
  );
}

// --- Sync helpers ---

/** Non-throwing POST: delegates to nmemRequest (retries transient faults)
 *  and flattens any NmemError into {ok:false} so the caller never sees a throw. */
async function postJson(
  path: string,
  body: JsonObject,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const data = await nmemRequest("POST", path, body);
    return { ok: true, status: 200, data };
  } catch (error) {
    if (error instanceof NmemError) {
      return { ok: false, status: error.status ?? 0, data: { detail: error.message } };
    }
    return {
      ok: false,
      status: 0,
      data: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function isThreadNotFound(result: { status: number; data: unknown }): boolean {
  if (result.status === 404) return true;
  const text = JSON.stringify(result.data).toLowerCase();
  return text.includes("thread not found");
}

function notifySyncError(ctx: any, message: string): void {
  if (syncNotifyWarnings.has(message)) return;
  syncNotifyWarnings.add(message);
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
  } else {
    console.warn(message);
  }
}

function buildSyncPayload(ctx: any, reason: string): SyncPayload | undefined {
  const messages = buildMessages(ctx);
  if (!shouldSync(messages)) return undefined;

  const threadId = threadIdFor(ctx);
  const id = sessionId(ctx);
  const manager = ctx.sessionManager as unknown as SessionManagerLike;
  const body: JsonObject = {
    thread_id: threadId,
    title: buildTitle(ctx, messages),
    messages,
    source: sourceApp(),
    project: manager.getCwd?.(),
    tool_version: pluginVersion(),
    metadata: {
      pi_session_id: id,
      pi_session_file: manager.getSessionFile?.(),
      sync_reason: reason,
    },
  };
  return { threadId, sessionId: id, messages, body };
}

async function flushOnce(ctx: any, payload: SyncPayload, state: SyncState): Promise<void> {
  let result = state.created
    ? { ok: false, status: 409, data: { detail: "append existing thread" } }
    : await postJson("/threads", payload.body);
  if (result.ok) {
    state.created = true;
    state.lastSyncedCount = payload.messages.length;
    state.lastError = undefined;
    return;
  }

  // Two-phase: POST /threads creates; on 2nd+ sync, append with dedup.
  result = await postJson(
    `/threads/${encodeURIComponent(payload.threadId)}/append`,
    {
      messages: payload.messages,
      deduplicate: true,
      idempotency_key: `${sourceApp()}:${payload.sessionId}:${payload.messages.length}`,
    },
  );
  if (!result.ok && state.created && isThreadNotFound(result)) {
    // Thread was deleted out-of-band; recreate.
    state.created = false;
    result = await postJson("/threads", payload.body);
  }
  if (!result.ok) {
    const detail = JSON.stringify(result.data);
    state.lastError = `${hostLabel()} thread sync failed (${result.status}): ${detail}`;
    notifySyncError(ctx, state.lastError);
    return;
  }
  state.created = true;
  state.lastSyncedCount = payload.messages.length;
  state.lastError = undefined;
}

async function flushPayload(ctx: any, payload: SyncPayload): Promise<void> {
  const key = payload.threadId;
  const state = syncStates.get(key) || {};
  syncStates.set(key, state);
  if (state.inFlight) {
    state.pending = true;
    await state.inFlight;
    return;
  }
  do {
    state.pending = false;
    state.inFlight = flushOnce(ctx, payload, state).finally(() => {
      state.inFlight = undefined;
    });
    await state.inFlight;
  } while (state.pending);
}

export async function flush(ctx: any, reason: string): Promise<void> {
  const payload = buildSyncPayload(ctx, reason);
  if (!payload) return;
  await flushPayload(ctx, payload);
}

/** Debounced flush — uses ctx.setTimeout for OMP isolation safety. */
export function scheduleFlush(ctx: any, reason: string): void {
  const payload = buildSyncPayload(ctx, reason);
  if (!payload) return;
  const key = payload.threadId;
  const state = syncStates.get(key) || {};
  syncStates.set(key, state);
  if (state.timer) ctx.clearTimer(state.timer);
  state.timer = ctx.setTimeout(() => {
    state.timer = undefined;
    void flushPayload(ctx, payload).catch(() => {});
  }, FLUSH_DELAY_MS);
}
