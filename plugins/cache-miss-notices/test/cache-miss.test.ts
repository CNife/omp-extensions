/**
 * cache-miss-notices 回归测试。
 *
 * 核心回归：切到从不报告 cache usage 的模型（如 ollama-cloud）后，
 * reportedCache 不得跨模型继承，否则每条 message_end 都会把全量
 * prompt 误判为 miss（复现：2026-08-24 onereason-backend-mono session，
 * openrouter -> ollama-cloud 后 183 条消息全部误报）。
 *
 * 同时保护 pi 原版语义：同模型链条内 sticky 保留，连续全量 miss
 * （如 idle 超时后 cache 重建失败）仍要逐条报告。
 *
 * entries 模拟 omp 行为：message_end 触发时当前消息已持久化，
 * 通过引用相等跳过自身。
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import {
	detectCacheMiss,
	formatNotice,
	type AssistantLike,
	type CacheMiss,
} from "../extensions/cache-miss-notices.ts";

// ============================================================================
// Helpers
// ============================================================================

interface UsageSpec {
	input: number;
	cacheRead: number;
	cacheWrite?: number;
	/** $/M tokens，用于构造真实成本比例 */
	inputPrice?: number;
	cacheReadPrice?: number;
}
function assistant(
	provider: string,
	model: string,
	timestamp: number,
	spec: UsageSpec,
): AssistantLike & { role: "assistant" } {
	const cw = spec.cacheWrite ?? 0;
	const inputPrice = spec.inputPrice ?? 1;
	const cacheReadPrice = spec.cacheReadPrice ?? 0.1;
	return {
		role: "assistant",
		provider,
		model,
		timestamp,
		usage: {
			input: spec.input,
			cacheRead: spec.cacheRead,
			cacheWrite: cw,
			cost: {
				input: (spec.input * inputPrice) / 1_000_000,
				output: 0,
				cacheRead: (spec.cacheRead * cacheReadPrice) / 1_000_000,
				cacheWrite: (cw * inputPrice * 1.25) / 1_000_000,
				total: 0,
			},
		},
	};
}

function entry(message: AssistantLike): { type: string; message: unknown } {
	return { type: "message", message };
}

/** omp 在 message_end 前已持久化当前消息：entries 含 msg 自身（同引用）。 */
function detect(entries: AssistantLike[], msg: AssistantLike): CacheMiss | undefined {
	return detectCacheMiss(entries.map(entry), msg, 0.1);
}

// ============================================================================
// 回归：切换到不报告 cache 的模型
// ============================================================================

test("切到从不报 cache 的模型：只有切换后第一条报 miss，其后静默", () => {
	const t = 1_000_000;
	// 切换前：openrouter 正常报告 cache（复现 session 数值）
	const or1 = assistant("openrouter", "deepseek-v4-flash", t, { input: 69089, cacheRead: 0 });
	const or2 = assistant("openrouter", "deepseek-v4-flash", t + 60_000, {
		input: 1077,
		cacheRead: 83200,
	});
	// 切换后：ollama-cloud 从不报告 cache usage，成本全 0
	const oc1 = assistant("ollama-cloud", "deepseek-v4-flash", t + 120_000, {
		input: 24555,
		cacheRead: 0,
		inputPrice: 0,
		cacheReadPrice: 0,
	});
	const oc2 = assistant("ollama-cloud", "deepseek-v4-flash", t + 180_000, {
		input: 26391,
		cacheRead: 0,
		inputPrice: 0,
		cacheReadPrice: 0,
	});
	const oc3 = assistant("ollama-cloud", "deepseek-v4-flash", t + 240_000, {
		input: 28684,
		cacheRead: 0,
		inputPrice: 0,
		cacheReadPrice: 0,
	});
	// 切换后第一条：报一次 "after model switch"（pi 语义：切换计入）
	const miss1 = detect([or1, or2, oc1], oc1);
	ok(miss1, "切换后第一条应报 miss");
	strictEqual(miss1.modelChanged, true);
	strictEqual(
		formatNotice(miss1),
		"Cache miss after model switch: 24.6k tokens re-billed",
	);

	// 回归断言：第二条起不再误报全量 miss
	strictEqual(detect([or1, or2, oc1, oc2], oc2), undefined);
	strictEqual(detect([or1, or2, oc1, oc2, oc3], oc3), undefined);
});

test("复现 session 长序列：仅切换首条非 undefined", () => {
	const t = 1_000_000;
	const entries: AssistantLike[] = [
		assistant("openrouter", "deepseek-v4-flash", t, { input: 67991, cacheRead: 0 }),
		assistant("openrouter", "deepseek-v4-flash", t + 60_000, { input: 1077, cacheRead: 83200 }),
	];
	const reported: number[] = [];
	for (let i = 0; i < 5; i++) {
		const m = assistant("ollama-cloud", "deepseek-v4-flash", t + 120_000 + i * 60_000, {
			input: 24555 + i * 1000,
			cacheRead: 0,
			inputPrice: 0,
			cacheReadPrice: 0,
		});
		entries.push(m);
		const miss = detect(entries, m);
		if (miss) reported.push(miss.missedTokens);
	}
	deepStrictEqual(reported, [24_555]);
});

// ============================================================================
// 保护：pi 原版语义不得回归
// ============================================================================

test("同模型连续全量 miss：逐条报告（sticky 不因修复丢失）", () => {
	const t = 1_000_000;
	const ok1 = assistant("ark-agent-plan", "glm-5.3", t, { input: 1077, cacheRead: 83200 });
	const miss1 = assistant("ark-agent-plan", "glm-5.3", t + 60_000, {
		input: 84992,
		cacheRead: 0,
	});
	const miss2 = assistant("ark-agent-plan", "glm-5.3", t + 120_000, {
		input: 90000,
		cacheRead: 0,
	});

	const m1 = detect([ok1, miss1], miss1);
	ok(m1, "同模型首条全量 miss 应报告");
	strictEqual(m1.modelChanged, false);

	const m2 = detect([ok1, miss1, miss2], miss2);
	ok(m2, "同模型连续全量 miss 仍应报告（pi sticky 语义）");
	strictEqual(m2.modelChanged, false);
});

test("正常命中不报", () => {
	const t = 1_000_000;
	const a = assistant("ark-agent-plan", "glm-5.3", t, { input: 1077, cacheRead: 83200 });
	const b = assistant("ark-agent-plan", "glm-5.3", t + 60_000, { input: 222, cacheRead: 84480 });
	strictEqual(detect([a, b], b), undefined);
});

test("切到报 cache 的新模型：首条真实 miss 报一次，其后命中静默", () => {
	const t = 1_000_000;
	const glm = assistant("ark-coding-plan", "glm-5.2", t, { input: 376, cacheRead: 22656 });
	const ds1 = assistant("opencode-go", "deepseek-v4-flash", t + 60_000, {
		input: 27474,
		cacheRead: 768,
	});
	const ds2 = assistant("opencode-go", "deepseek-v4-flash", t + 120_000, {
		input: 452,
		cacheRead: 28800,
	});

	const m1 = detect([glm, ds1], ds1);
	ok(m1, "切换后首条 cache 冷应报");
	strictEqual(m1.modelChanged, true);

	strictEqual(detect([glm, ds1, ds2], ds2), undefined);
});

test("compaction 后不报（上下文合法变化）", () => {
	const t = 1_000_000;
	const a = assistant("ark-agent-plan", "glm-5.3", t, { input: 1077, cacheRead: 83200 });
	const b = assistant("ark-agent-plan", "glm-5.3", t + 60_000, {
		input: 84992,
		cacheRead: 0,
	});
	const miss = detectCacheMiss(
		[{ type: "message", message: a }, { type: "compaction" }, { type: "message", message: b }],
		b,
		0.1,
	);
	strictEqual(miss, undefined);
});
