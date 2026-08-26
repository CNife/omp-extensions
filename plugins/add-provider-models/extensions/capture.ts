// @ts-nocheck
/**
 * capture.ts - 抓取 omp 实际发送的请求 payload 和收到的响应，输出结构化 JSONL。
 *
 * 用途：调试 models.yml 配置（thinking.efforts / compat / 缓存 / tool 格式）。
 * 加载：omp --extension <plugin>/extensions/capture.ts --print --model <provider/model> "<task>"
 * 日志：$OMP_CAPTURE_LOG（默认 /tmp/omp-capture.jsonl），不脱敏，调试结束删除。
 *
 * 移植自 pi 技能 scripts/capture.ts，改动：
 *   - 删 before_provider_headers handler（omp 无此事件）
 *   - before_provider_request 改为自己开槽（不再依赖 headers 先开槽）
 *   - 去 ExtensionAPI import，改 // @ts-nocheck + 接口（对齐 nmem 范式）
 *   - PI_CAPTURE_LOG -> OMP_CAPTURE_LOG
 *   - slot/request 块删 headers 字段（omp 无 headers 事件，四维度 jq 不依赖）
 *
 * 输出格式：一行一个聚合 CALL 块（JSONL）。
 *   - assistant 块：{callIndex, role, startTime, request:{payload}, responses[], message:{...}}
 *   - user/toolResult 块：精简结构（callIndex=null，无 request/responses）
 * 消费：用 jq 提取四维度（见 SKILL.md step 7）。
 *
 * 事件组合（按触发顺序）：
 *   before_provider_request -> after_provider_response -> message_end
 *   （omp 无 before_provider_headers；payload 由 before_provider_request 直接捕获）
 *
 * 已知局限：
 * - 拿不到 Authorization（omp 在事件返回后才注入 auth）--调试 API key 靠"跑通与否"判断
 * - responseModel 在 omp 恒为 null（四维度 jq 不用它，无害）
 * - 日志不脱敏，含 payload 完整内容，调试完请删除
 */
import { appendFileSync, writeFileSync } from "node:fs";

// ---- 日志路径 ----
const LOG_PATH = process.env.OMP_CAPTURE_LOG ?? "/tmp/omp-capture.jsonl";

// ---- 一次 HTTP 请求的槽 ----
interface RequestSlot {
	callIndex: number;
	startTime: string;
	payload?: unknown;
	responses: Array<{ status: number; headers: Record<string, string> }>;
}

// 尚未被 assistant message_end 消费的请求槽（按顺序）。
const pendingSlots: RequestSlot[] = [];
let callCount = 0;

function newSlot(): RequestSlot {
	callCount += 1;
	return {
		callIndex: callCount,
		startTime: new Date().toISOString(),
		responses: [],
	};
}

function writeLine(obj: unknown): void {
	appendFileSync(LOG_PATH, JSON.stringify(obj) + "\n", "utf8");
}

// ---- 类型 ----
interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}
interface Message {
	role: string;
	model?: string | null;
	responseModel?: string | null;
	stopReason?: string | null;
	errorMessage?: string | null;
	usage?: Record<string, number> | null;
	content?: ContentBlock[] | string;
	toolName?: string | null;
	toolCallId?: string | null;
	isError?: boolean;
}
interface ExtApi {
	on(event: string, handler: (event: unknown, ctx: unknown) => void): void;
}

export default function (pi: ExtApi) {
	// 启动时清空旧日志：每次新 run 重新开始
	try {
		writeFileSync(LOG_PATH, "", "utf8");
	} catch (e) {
		console.error(`[capture.ts] Failed to init log at ${LOG_PATH}:`, e);
	}

	// ---- 1. 请求体（已应用 thinking.efforts/compat 的最终 payload）----
	// omp 无 before_provider_headers 事件，payload 由本事件直接捕获并开槽。
	pi.on("before_provider_request", (event: unknown) => {
		try {
			const e = event as { payload?: unknown };
			const slot = newSlot();
			slot.payload = e.payload;
			pendingSlots.push(slot);
		} catch (e) {
			console.error("[capture.ts] before_provider_request error:", e);
		}
	});

	// ---- 2. 响应状态 + 响应头（不含 body，stream consume 前触发）----
	pi.on("after_provider_response", (event: unknown) => {
		try {
			const e = event as { status: number; headers: Record<string, string> };
			const slot = pendingSlots[pendingSlots.length - 1];
			if (slot) {
				slot.responses.push({ status: e.status, headers: e.headers });
			}
		} catch (e) {
			console.error("[capture.ts] after_provider_response error:", e);
		}
	});

	// ---- 3. 最终 message（响应主来源）----
	pi.on("message_end", (event: unknown) => {
		try {
			const e = event as { message: Message };
			const msg = e.message;

			// assistant 消息：消费一个待处理请求槽，产出聚合 CALL 块
			if (msg.role === "assistant") {
				const slot = pendingSlots.shift() ?? newSlot(); // 防御性
				flushAssistantBlock(slot, msg);
				return;
			}

			// user / toolResult：没有对应 provider 请求，单独 flush 精简块
			flushNonAssistantBlock(msg);
		} catch (e) {
			console.error("[capture.ts] message_end error:", e);
		}
	});
}

// ---- 内容摘要（避免日志爆炸，仅记计数与 toolCall 元信息）----
function summarizeContent(content: ContentBlock[] | string | undefined): {
	textBlocks: number;
	textChars: number;
	thinkingBlocks: number;
	thinkingChars: number;
	toolCalls: Array<{ name: string; argKeys: string[] }>;
} {
	if (typeof content === "string" || !content) {
		return { textBlocks: 0, textChars: 0, thinkingBlocks: 0, thinkingChars: 0, toolCalls: [] };
	}
	const textBlocks = content.filter((b) => b?.type === "text");
	const thinkingBlocks = content.filter((b) => b?.type === "thinking");
	const toolCalls = content.filter((b) => b?.type === "toolCall");
	return {
		textBlocks: textBlocks.length,
		textChars: textBlocks.reduce((s, b) => s + (b.text?.length ?? 0), 0),
		thinkingBlocks: thinkingBlocks.length,
		thinkingChars: thinkingBlocks.reduce((s, b) => s + (b.thinking?.length ?? 0), 0),
		toolCalls: toolCalls.map((t) => ({
			name: t.name ?? "",
			argKeys: t.arguments ? Object.keys(t.arguments) : [],
		})),
	};
}

// ---- assistant 聚合 CALL 块 ----
function flushAssistantBlock(slot: RequestSlot, msg: Message): void {
	const content = Array.isArray(msg.content) ? msg.content : [];
	writeLine({
		callIndex: slot.callIndex,
		role: "assistant",
		startTime: slot.startTime,
		request: {
			payload: slot.payload ?? null,
		},
		responses: slot.responses,
		message: {
			model: msg.model ?? null,
			responseModel: msg.responseModel ?? null,
			stopReason: msg.stopReason ?? null,
			errorMessage: msg.errorMessage ?? null,
			usage: msg.usage ?? null,
			content: summarizeContent(content),
		},
	});
}

// ---- user / toolResult 精简块 ----
function flushNonAssistantBlock(msg: Message): void {
	const entry: Record<string, unknown> = {
		callIndex: null,
		role: msg.role,
		startTime: new Date().toISOString(),
		note: "non-assistant message_end - no provider request",
	};

	if (msg.role === "toolResult") {
		const content = Array.isArray(msg.content) ? msg.content : [];
		entry.toolName = msg.toolName ?? null;
		entry.toolCallId = msg.toolCallId ?? null;
		entry.isError = msg.isError ?? false;
		entry.textChars = summarizeContent(content).textChars;
	} else if (msg.role === "user") {
		const c = msg.content;
		entry.userPreview =
			typeof c === "string" ? c.slice(0, 200) : JSON.stringify(c).slice(0, 200);
	}

	// user/toolResult 块不计入 callCount（callCount 只数真实 LLM 调用）
	writeLine(entry);
}
