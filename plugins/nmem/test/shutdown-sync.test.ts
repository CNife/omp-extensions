/**
 * nmem 退出同步 — 经扩展入口注册的真实 session_shutdown handler 观测落盘请求。
 *
 * 两条约束来自宿主：
 * - SessionShutdownEvent 只有 type 字段（shared-events.d.ts）；带 reason 的是
 *   session_before_switch。此前这里读 event.reason，把 "session_shutdown:undefined"
 *   写进了后端 thread 的 metadata.sync_reason。
 * - 宿主给 session_shutdown handler 的预算只有 2s（runner.ts 的
 *   SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS），而正常一次请求是 8s 超时 + 2 次重试：
 *   超出窗口的部分会被静默取消，数据没落盘、也看不到报错。
 */

import { ok, strictEqual } from "node:assert";
import { test } from "node:test";

import nmem from "../extensions/nmem.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** 捕获扩展入口注册的 handler（入口只做注册，无副作用）。 */
function registeredHandlers(): Record<string, Handler | undefined> {
	const handlers: Record<string, Handler | undefined> = {};
	nmem({
		on: (name: string, handler: Handler) => {
			handlers[name] = handler;
		},
	});
	return handlers;
}

interface FakeCtx {
	ctx: unknown;
	notifications: string[];
	/** 让挂起的防抖定时器「到点」；已被 clearTimer 取消的定时器不会被触发。 */
	fireTimer: () => void;
	/** 把会话改成 `count` 条消息（user/assistant 交替），用于制造「请求在飞时又长出消息」。 */
	setMessages: (count: number) => void;
}

/** 最小会话上下文：user + assistant 两条消息即可触发同步，定时器由测试掌控。 */
function fakeCtx(sessionId: string): FakeCtx {
	const notifications: string[] = [];
	const timers = new Set<{ callback: () => void }>();
	const messages = [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "hello" },
	];
	return {
		notifications,
		setMessages: (count: number) => {
			messages.length = 0;
			for (let i = 0; i < count; i++) {
				messages.push({
					role: i % 2 === 0 ? "user" : "assistant",
					content: `${i % 2 === 0 ? "hi" : "hello"}-${i}`,
				});
			}
		},
		fireTimer: () => {
			for (const handle of [...timers]) {
				timers.delete(handle);
				handle.callback();
			}
		},
		ctx: {
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
			setTimeout: (callback: () => void) => {
				const handle = { callback };
				timers.add(handle);
				return handle;
			},
			clearTimer: (handle: unknown) => {
				if (handle === undefined || handle === null) return;
				timers.delete(handle as { callback: () => void });
			},
			sessionManager: {
				getBranch: () =>
					messages.map((message, index) => ({
						type: "message",
						id: `m${index + 1}`,
						timestamp: "2026-10-17T00:00:00.000Z",
						message,
					})),
				getSessionId: () => sessionId,
				getSessionFile: () => undefined,
				getSessionName: () => undefined,
				getCwd: () => "/tmp/demo",
			},
		},
	};
}

// ============================================================================
// Fixtures
// ============================================================================

const FAKE_API_URL = "http://nmem.test:9999";

type GlobalFetch = typeof globalThis.fetch;

interface FetchCall {
	url: string;
	init: RequestInit;
}

interface Probe {
	calls: FetchCall[];
	/** 每次请求尝试挂的超时预算（nmemRequest 每轮 doFetch 一个）。 */
	timeouts: number[];
	/** 事件时序：body-start（开始读正文）与 clear（清掉预算定时器）。 */
	events: Array<"body-start" | "clear">;
	restore: () => void;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** 从落盘请求体里取出 metadata.sync_reason；形态不对即失败。 */
function syncReasonOf(body: unknown): unknown {
	if (body === null || typeof body !== "object" || !("metadata" in body)) {
		throw new Error(`请求体里没有 metadata：${JSON.stringify(body)}`);
	}
	const { metadata } = body;
	if (metadata === null || typeof metadata !== "object" || !("sync_reason" in metadata)) {
		throw new Error(`metadata 里没有 sync_reason：${JSON.stringify(metadata)}`);
	}
	return metadata.sync_reason;
}

/**
 * 注入 fake fetch（记录每次请求）与 setTimeout 探针（记录每次尝试的超时预算），
 * 并把后端地址固定到测试域名。超时定时器仍交给原生实现：断言的是真实耗时。
 */
function probe(
	outcomes: Array<(init: RequestInit) => Response | Promise<Response>>,
	opts: { events?: Array<"body-start" | "clear"> } = {},
): Probe {
	const calls: FetchCall[] = [];
	const timeouts: number[] = [];
	// 与响应工厂共用同一 sink，才能比较「开始读正文」与「清定时器」的先后
	const events = opts.events ?? [];
	const originalFetch = globalThis.fetch;
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const savedApiUrl = process.env.NMEM_API_URL;

	// 类型断言：Node 与 DOM 的 setTimeout 签名不同，这里的探针只关心延迟。
	globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
		timeouts.push(delay ?? 0);
		return originalSetTimeout(callback, delay);
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle?: NodeJS.Timeout) => {
		events.push("clear");
		return originalClearTimeout(handle);
	}) as typeof clearTimeout;
	globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
		calls.push({ url: String(url), init });
		return await outcomes[Math.min(calls.length - 1, outcomes.length - 1)](init);
	}) as unknown as GlobalFetch;
	process.env.NMEM_API_URL = FAKE_API_URL;

	return {
		calls,
		timeouts,
		events,
		restore: () => {
			globalThis.fetch = originalFetch;
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
			if (savedApiUrl === undefined) delete process.env.NMEM_API_URL;
			else process.env.NMEM_API_URL = savedApiUrl;
		},
	};
}

/** 状态 200、正文一直不来的响应：只有请求被 abort 时正文才失败。
 *  开始读正文时在 `events` 里打点，用来证明预算定时器此刻还没被清掉。 */
function stalledBody(events: Array<"body-start" | "clear">) {
	return (init: RequestInit): Response => {
		const body = new ReadableStream({
			start(controller) {
				events.push("body-start");
				const fail = () => controller.error(new Error("This operation was aborted"));
				if (init.signal?.aborted) fail();
				else init.signal?.addEventListener("abort", fail, { once: true });
			},
		});
		return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
	};
}

/** 门控：在 `release()` 之前请求一直不返回，用来让请求停留在飞行中。 */
function gate(): { release: () => void; opened: Promise<void> } {
	let release = (): void => {};
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { release, opened };
}

function gatedJson(g: { opened: Promise<void> }, body: unknown) {
	return async (): Promise<Response> => {
		await g.opened;
		return jsonResponse(200, body);
	};
}

/** 等到条件成立（fetch 由微任务链驱动，不能靠同步断言）。 */
async function until(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("等待条件超时");
}

/** 只挑创建线程的请求：append 的请求体没有 metadata（sync_reason 只在 create 上）。 */
function createCalls(calls: FetchCall[]): FetchCall[] {
	return calls.filter((call) => new URL(call.url).pathname === "/threads");
}

/** 取出落盘请求体里的消息条数。 */
function messageCountOf(body: unknown): number {
	const posted: unknown = typeof body === "string" ? JSON.parse(body) : body;
	if (posted === null || typeof posted !== "object" || !("messages" in posted)) {
		throw new Error(`请求体里没有 messages：${JSON.stringify(posted)}`);
	}
	const { messages } = posted;
	if (!Array.isArray(messages)) throw new Error(`messages 不是数组：${JSON.stringify(messages)}`);
	return messages.length;
}

// ============================================================================
// reason 落点
// ============================================================================

test("session_shutdown: 落盘请求的 sync_reason 是 session_shutdown，不含 undefined", async () => {
	const p = probe([() => jsonResponse(200, { ok: true })]);
	try {
		const handler = registeredHandlers().session_shutdown;
		ok(handler, "入口应注册 session_shutdown");
		// 宿主构造的事件就只有 type 字段（runner.ts emitSessionShutdownEvent）
		const { ctx } = fakeCtx("shutdown-reason-session");
		await handler({ type: "session_shutdown" }, ctx);

		strictEqual(p.calls.length, 1);
		const serialized = String(p.calls[0].init.body);
		// JSON.parse 的返回是 any，先收到 unknown 再走守卫
		const posted: unknown = JSON.parse(serialized);
		strictEqual(syncReasonOf(posted), "session_shutdown");
		strictEqual(serialized.includes("undefined"), false, `请求体里不该出现 undefined：${serialized}`);
	} finally {
		p.restore();
	}
});

// ============================================================================
// 退出预算
// ============================================================================

test("session_shutdown: 单次尝试且总预算落在宿主 2s 的退出窗口内", async () => {
	const p = probe([() => jsonResponse(500, { detail: "boom" })]);
	try {
		const handler = registeredHandlers().session_shutdown;
		ok(handler, "入口应注册 session_shutdown");
		const { ctx } = fakeCtx("shutdown-budget-session");
		await handler({ type: "session_shutdown" }, ctx);

		// create 失败后还有一次 append 兜底 → 两次请求；重试关闭 → 每次请求只挂一个超时定时器
		strictEqual(p.calls.length, 2, "退出时最多两次请求（create + append 兜底）");
		strictEqual(p.timeouts.length, 2, "每次请求只尝试一次（不重试）");
		const worstCaseMs = p.timeouts.reduce((sum, ms) => sum + ms, 0);
		ok(worstCaseMs <= 2_000, `串行最坏耗时 ${worstCaseMs}ms 应落在宿主的 2000ms 退出窗口内`);
	} finally {
		p.restore();
	}
});

test("session_shutdown: 响应头已到、正文不来时也按预算截断", async () => {
	// 不伪造「定时器已到点」：让真实的 800ms 预算去中止悬挂的正文，
	// 这样断言的是「预算覆盖到正文读取阶段」，而不是「abort 之后如何分类」。
	const events: Array<"body-start" | "clear"> = [];
	const p = probe([stalledBody(events)], { events });
	try {
		const handler = registeredHandlers().session_shutdown;
		ok(handler, "入口应注册 session_shutdown");
		const { ctx, notifications } = fakeCtx("shutdown-stall-session");
		const started = Date.now();
		await handler({ type: "session_shutdown" }, ctx);
		const elapsed = Date.now() - started;

		// create 悬挂 → append 兜底也悬挂；两次都在预算内结束并记成 timeout
		strictEqual(p.calls.length, 2, "正文悬挂也应该结束本次尝试，进入 append 兜底");
		strictEqual(notifications.length, 1, `应报一次同步失败，实际：${JSON.stringify(notifications)}`);
		ok(
			notifications[0].includes("[timeout]"),
			`正文读取超时应映射为 timeout，实际：${notifications[0]}`,
		);
		ok(elapsed <= 2_000, `退出 handler 实际耗时 ${elapsed}ms 应落在宿主 2000ms 窗口内`);
		// 时序：先开始读正文，之后才清预算定时器（提前 clear 会让正文永久悬挂）
		const firstBody = events.indexOf("body-start");
		const firstClear = events.indexOf("clear");
		ok(firstBody !== -1 && firstClear !== -1, `缺少事件：${JSON.stringify(events)}`);
		ok(firstBody < firstClear, `清定时器发生在读正文之前：${JSON.stringify(events)}`);
	} finally {
		p.restore();
	}
});

test("session_shutdown: 退出期间到点的防抖同步不会让同一次退出多跑一轮", async () => {
	// 后端每次都 500：每次 flush 两阶段共两次请求
	const p = probe([() => jsonResponse(500, { detail: "boom" })]);
	try {
		const handlers = registeredHandlers();
		const agentEnd = handlers.agent_end;
		const shutdown = handlers.session_shutdown;
		ok(agentEnd && shutdown, "入口应注册 agent_end 与 session_shutdown");
		const { ctx, fireTimer } = fakeCtx("shutdown-debounce-session");

		// agent_end 先排了一个 750ms 后触发的防抖同步
		await agentEnd({ type: "agent_end" }, ctx);
		// 防抖还没到点，用户就退出了
		const flushing = shutdown({ type: "session_shutdown" }, ctx);
		// 退出 flush 进行中，那个定时器到点（宿主会真的执行它）
		fireTimer();
		await flushing;

		// 退出路径自己最多两次请求；被它收编的那次防抖不该再额外跑一轮
		strictEqual(p.calls.length, 2, `退出期间只应有两次请求，实际 ${p.calls.length}`);
		const worstCaseMs = p.timeouts.reduce((sum, ms) => sum + ms, 0);
		ok(worstCaseMs <= 2_000, `串行最坏耗时 ${worstCaseMs}ms 应落在宿主的 2000ms 退出窗口内`);
	} finally {
		p.restore();
	}
});


// ============================================================================
// 快照新鲜度
// ============================================================================

test("session_shutdown: 请求在飞时新到的快照被补发，而不是重发旧快照", async () => {
	const g = gate();
	const p = probe([gatedJson(g, { ok: true })]);
	try {
		const handlers = registeredHandlers();
		const agentEnd = handlers.agent_end;
		const shutdown = handlers.session_shutdown;
		ok(agentEnd && shutdown, "入口应注册 agent_end 与 session_shutdown");
		const chat = fakeCtx("shutdown-latest-snapshot-session");
		const { ctx } = chat;

		// 基线：两条消息的防抖同步起飞并挂住
		await agentEnd({ type: "agent_end" }, ctx);
		chat.fireTimer();
		await until(() => p.calls.length === 1);
		strictEqual(messageCountOf(p.calls[0].init.body), 2);

		// 请求在飞时，会话长到四条消息（用户继续说话）
		chat.setMessages(4);

		// 中途退出：退出 flush 立即快照四条消息；随后放行在飞的请求
		const flushing = shutdown({ type: "session_shutdown" }, ctx);
		g.release();
		await flushing;

		// 后续轮次必须发四条那份快照；重发两条说明排队的是旧 payload
		const counts = p.calls.map((call) => messageCountOf(call.init.body));
		ok(
			counts.includes(4),
			`退出后应补发含四条消息的快照，实际每轮条数：${JSON.stringify(counts)}`,
		);

		// 且退出这次补发走的是 append（线程已建），理由是 session_shutdown
		const creates = createCalls(p.calls);
		strictEqual(creates.length, 1, `线程只应创建一次，实际：${JSON.stringify(p.calls.map((c) => c.url))}`);
		strictEqual(syncReasonOf(JSON.parse(String(creates[0].init.body))), "agent_end");
		strictEqual(
			p.calls.length,
			2,
			`在飞一轮 + 补发一轮，实际：${JSON.stringify(p.calls.map((c) => c.url))}`,
		);
	} finally {
		g.release();
		p.restore();
	}
});

test("session_shutdown: 取消挂起的防抖不会丢掉只在防抖快照里的消息", async () => {
	// 防抖快照在到点时构建，因此退出 flush 构建的即时快照至少与它等宽。
	const p = probe([() => jsonResponse(200, { ok: true })]);
	try {
		const handlers = registeredHandlers();
		const agentEnd = handlers.agent_end;
		const shutdown = handlers.session_shutdown;
		ok(agentEnd && shutdown, "入口应注册 agent_end 与 session_shutdown");
		const chat = fakeCtx("shutdown-cancel-debounce-session");

		// agent_end 排了防抖；到点前会话又长了消息，然后退出
		await agentEnd({ type: "agent_end" }, chat.ctx);
		chat.setMessages(4);
		await shutdown({ type: "session_shutdown" }, chat.ctx);

		// 该防抖已被取消：只剩退出这一次 create
		const creates = createCalls(p.calls);
		strictEqual(creates.length, 1, `被取消的防抖不应落盘，实际请求：${JSON.stringify(p.calls.map((c) => c.url))}`);
		strictEqual(syncReasonOf(JSON.parse(String(creates[0].init.body))), "session_shutdown");
		// 退出这次携带的是四条消息（防抖被取消也没丢）
		strictEqual(messageCountOf(creates[0].init.body), 4);
	} finally {
		p.restore();
	}
});

test("agent_end 防抖: 到点时按最新会话落盘，窗口内新消息不丢", async () => {
	// 快照在定时器到点时构建。若在排定时器时就构建，750ms 窗口内追加的消息会被漏掉。
	const p = probe([() => jsonResponse(200, { ok: true })]);
	try {
		const agentEnd = registeredHandlers().agent_end;
		ok(agentEnd, "入口应注册 agent_end");
		const chat = fakeCtx("debounce-fresh-snapshot-session");

		await agentEnd({ type: "agent_end" }, chat.ctx);
		// 定时器还没到点，会话又长了两条
		chat.setMessages(4);
		chat.fireTimer();
		await until(() => p.calls.length === 1);

		strictEqual(messageCountOf(p.calls[0].init.body), 4, "防抖到点应带上窗口内新增的消息");
	} finally {
		p.restore();
	}
});
