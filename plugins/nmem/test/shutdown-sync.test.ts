import { ok, strictEqual } from "node:assert";
import { test } from "node:test";

import nmem from "../extensions/nmem.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

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
	fireTimer: () => void;
	setMessages: (count: number) => void;
}

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

const FAKE_API_URL = "http://nmem.test:9999";

type GlobalFetch = typeof globalThis.fetch;

interface FetchCall {
	url: string;
	init: RequestInit;
}

interface Probe {
	calls: FetchCall[];
	timeouts: number[];
	events: Array<"body-start" | "clear">;
	restore: () => void;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

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

function probe(
	outcomes: Array<(init: RequestInit) => Response | Promise<Response>>,
	opts: { events?: Array<"body-start" | "clear"> } = {},
): Probe {
	const calls: FetchCall[] = [];
	const timeouts: number[] = [];
	const events = opts.events ?? [];
	const originalFetch = globalThis.fetch;
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const savedApiUrl = process.env.NMEM_API_URL;

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

async function until(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("等待条件超时");
}

function createCalls(calls: FetchCall[]): FetchCall[] {
	return calls.filter((call) => new URL(call.url).pathname === "/threads");
}

function messageCountOf(body: unknown): number {
	const posted: unknown = typeof body === "string" ? JSON.parse(body) : body;
	if (posted === null || typeof posted !== "object" || !("messages" in posted)) {
		throw new Error(`请求体里没有 messages：${JSON.stringify(posted)}`);
	}
	const { messages } = posted;
	if (!Array.isArray(messages)) throw new Error(`messages 不是数组：${JSON.stringify(messages)}`);
	return messages.length;
}

test("session_shutdown: 落盘请求的 sync_reason 是 session_shutdown，不含 undefined", async () => {
	const p = probe([() => jsonResponse(200, { ok: true })]);
	try {
		const handler = registeredHandlers().session_shutdown;
		ok(handler, "入口应注册 session_shutdown");
		const { ctx } = fakeCtx("shutdown-reason-session");
		await handler({ type: "session_shutdown" }, ctx);

		strictEqual(p.calls.length, 1);
		const serialized = String(p.calls[0].init.body);
		const posted: unknown = JSON.parse(serialized);
		strictEqual(syncReasonOf(posted), "session_shutdown");
		strictEqual(serialized.includes("undefined"), false, `请求体里不该出现 undefined：${serialized}`);
	} finally {
		p.restore();
	}
});

test("session_shutdown: 单次尝试且总预算落在宿主 2s 的退出窗口内", async () => {
	const p = probe([() => jsonResponse(500, { detail: "boom" })]);
	try {
		const handler = registeredHandlers().session_shutdown;
		ok(handler, "入口应注册 session_shutdown");
		const { ctx } = fakeCtx("shutdown-budget-session");
		await handler({ type: "session_shutdown" }, ctx);

		strictEqual(p.calls.length, 2, "退出时最多两次请求（create + append 兜底）");
		strictEqual(p.timeouts.length, 2, "每次请求只尝试一次（不重试）");
		const worstCaseMs = p.timeouts.reduce((sum, ms) => sum + ms, 0);
		ok(worstCaseMs <= 2_000, `串行最坏耗时 ${worstCaseMs}ms 应落在宿主的 2000ms 退出窗口内`);
	} finally {
		p.restore();
	}
});

test("session_shutdown: 响应头已到、正文不来时也按预算截断", async () => {
	const events: Array<"body-start" | "clear"> = [];
	const p = probe([stalledBody(events)], { events });
	try {
		const handler = registeredHandlers().session_shutdown;
		ok(handler, "入口应注册 session_shutdown");
		const { ctx, notifications } = fakeCtx("shutdown-stall-session");
		const started = Date.now();
		await handler({ type: "session_shutdown" }, ctx);
		const elapsed = Date.now() - started;

		strictEqual(p.calls.length, 2, "正文悬挂也应该结束本次尝试，进入 append 兜底");
		strictEqual(notifications.length, 1, `应报一次同步失败，实际：${JSON.stringify(notifications)}`);
		ok(
			notifications[0].includes("[timeout]"),
			`正文读取超时应映射为 timeout，实际：${notifications[0]}`,
		);
		ok(elapsed <= 2_000, `退出 handler 实际耗时 ${elapsed}ms 应落在宿主 2000ms 窗口内`);
		const firstBody = events.indexOf("body-start");
		const firstClear = events.indexOf("clear");
		ok(firstBody !== -1 && firstClear !== -1, `缺少事件：${JSON.stringify(events)}`);
		ok(firstBody < firstClear, `清定时器发生在读正文之前：${JSON.stringify(events)}`);
	} finally {
		p.restore();
	}
});

test("session_shutdown: 退出期间到点的防抖同步不会让同一次退出多跑一轮", async () => {
	const p = probe([() => jsonResponse(500, { detail: "boom" })]);
	try {
		const handlers = registeredHandlers();
		const agentEnd = handlers.agent_end;
		const shutdown = handlers.session_shutdown;
		ok(agentEnd && shutdown, "入口应注册 agent_end 与 session_shutdown");
		const { ctx, fireTimer } = fakeCtx("shutdown-debounce-session");

		await agentEnd({ type: "agent_end" }, ctx);
		const flushing = shutdown({ type: "session_shutdown" }, ctx);
		fireTimer();
		await flushing;

		strictEqual(p.calls.length, 2, `退出期间只应有两次请求，实际 ${p.calls.length}`);
		const worstCaseMs = p.timeouts.reduce((sum, ms) => sum + ms, 0);
		ok(worstCaseMs <= 2_000, `串行最坏耗时 ${worstCaseMs}ms 应落在宿主的 2000ms 退出窗口内`);
	} finally {
		p.restore();
	}
});

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

		await agentEnd({ type: "agent_end" }, ctx);
		chat.fireTimer();
		await until(() => p.calls.length === 1);
		strictEqual(messageCountOf(p.calls[0].init.body), 2);

		chat.setMessages(4);

		const flushing = shutdown({ type: "session_shutdown" }, ctx);
		g.release();
		await flushing;

		const counts = p.calls.map((call) => messageCountOf(call.init.body));
		ok(
			counts.includes(4),
			`退出后应补发含四条消息的快照，实际每轮条数：${JSON.stringify(counts)}`,
		);

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
	const p = probe([() => jsonResponse(200, { ok: true })]);
	try {
		const handlers = registeredHandlers();
		const agentEnd = handlers.agent_end;
		const shutdown = handlers.session_shutdown;
		ok(agentEnd && shutdown, "入口应注册 agent_end 与 session_shutdown");
		const chat = fakeCtx("shutdown-cancel-debounce-session");

		await agentEnd({ type: "agent_end" }, chat.ctx);
		chat.setMessages(4);
		await shutdown({ type: "session_shutdown" }, chat.ctx);

		const creates = createCalls(p.calls);
		strictEqual(creates.length, 1, `被取消的防抖不应落盘，实际请求：${JSON.stringify(p.calls.map((c) => c.url))}`);
		strictEqual(syncReasonOf(JSON.parse(String(creates[0].init.body))), "session_shutdown");
		strictEqual(messageCountOf(creates[0].init.body), 4);
	} finally {
		p.restore();
	}
});

test("agent_end 防抖: 到点时按最新会话落盘，窗口内新消息不丢", async () => {
	const p = probe([() => jsonResponse(200, { ok: true })]);
	try {
		const agentEnd = registeredHandlers().agent_end;
		ok(agentEnd, "入口应注册 agent_end");
		const chat = fakeCtx("debounce-fresh-snapshot-session");

		await agentEnd({ type: "agent_end" }, chat.ctx);
		chat.setMessages(4);
		chat.fireTimer();
		await until(() => p.calls.length === 1);

		strictEqual(messageCountOf(p.calls[0].init.body), 4, "防抖到点应带上窗口内新增的消息");
	} finally {
		p.restore();
	}
});

test("session_shutdown: 排队的一轮用自己的预算，不继承前一轮的默认值", async () => {
	const g = gate();
	const p = probe([gatedJson(g, { ok: true })]);
	try {
		const handlers = registeredHandlers();
		const agentEnd = handlers.agent_end;
		const shutdown = handlers.session_shutdown;
		ok(agentEnd && shutdown, "入口应注册 agent_end 与 session_shutdown");
		const chat = fakeCtx("shutdown-queued-budget-session");

		await agentEnd({ type: "agent_end" }, chat.ctx);
		chat.fireTimer();
		await until(() => p.calls.length === 1);

		chat.setMessages(4);
		const flushing = shutdown({ type: "session_shutdown" }, chat.ctx);
		g.release();
		await flushing;

		strictEqual(p.calls.length, 2, `应有在飞一轮 + 补发一轮，实际：${JSON.stringify(p.calls.map((c) => c.url))}`);
		strictEqual(messageCountOf(p.calls[1].init.body), 4, "补发的一轮应是退出时的新快照");
		const perRequest = p.timeouts.filter((ms) => ms === 800).length;
		ok(
			perRequest >= 1,
			`退出补发应挂 800ms 预算，实际超时预算序列：${JSON.stringify(p.timeouts)}`,
		);
	} finally {
		g.release();
		p.restore();
	}
});
