/**
 * context-cap 施加函数测试。
 *
 * 只断言外部行为：给定一组 Model 形对象，施加之后窗口和 maxTokens 是什么。
 */

import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { applyContextCap } from "../extensions/cap.ts";

test("大于 256K 的窗口被压到 256000", () => {
	const model = { contextWindow: 1_000_000 };
	applyContextCap([model]);
	strictEqual(model.contextWindow, 256_000);
});

test("小于等于 256K 的窗口保持原值", () => {
	const under = { contextWindow: 128_000 };
	const exact = { contextWindow: 256_000 };
	applyContextCap([under, exact]);
	strictEqual(under.contextWindow, 128_000);
	strictEqual(exact.contextWindow, 256_000);
});

test("maxTokens 大于封顶后窗口时被压到窗口", () => {
	const model = { contextWindow: 1_000_000, maxTokens: 512_000 };
	applyContextCap([model]);
	strictEqual(model.maxTokens, 256_000);
});

test("maxTokens 本来就更小的保持", () => {
	const model = { contextWindow: 1_000_000, maxTokens: 8_192 };
	applyContextCap([model]);
	strictEqual(model.maxTokens, 8_192);
});

test("maxTokens 大于未达上限的封顶后窗口时被压到窗口", () => {
	const model = { contextWindow: 128_000, maxTokens: 200_000 };
	applyContextCap([model]);
	strictEqual(model.contextWindow, 128_000);
	strictEqual(model.maxTokens, 128_000);
});

test("null / 0 / 负数窗口整条不动（含 maxTokens）", () => {
	const missing = { maxTokens: 512_000 };
	const nulled = { contextWindow: null, maxTokens: 512_000 };
	const zero = { contextWindow: 0, maxTokens: 512_000 };
	const negative = { contextWindow: -1, maxTokens: 512_000 };
	applyContextCap([missing, nulled, zero, negative]);
	deepStrictEqual(missing, { maxTokens: 512_000 });
	deepStrictEqual(nulled, { contextWindow: null, maxTokens: 512_000 });
	deepStrictEqual(zero, { contextWindow: 0, maxTokens: 512_000 });
	deepStrictEqual(negative, { contextWindow: -1, maxTokens: 512_000 });
});

test("同一批对象再施加一次，值不变", () => {
	const model = { contextWindow: 1_000_000, maxTokens: 512_000 };
	applyContextCap([model]);
	applyContextCap([model]);
	strictEqual(model.contextWindow, 256_000);
	strictEqual(model.maxTokens, 256_000);
});

test("先把窗口改成 256K 以上再施加，仍 ≤256K", () => {
	const model = { contextWindow: 128_000, maxTokens: 8_192 };
	applyContextCap([model]);
	model.contextWindow = 1_000_000;
	applyContextCap([model]);
	strictEqual(model.contextWindow, 256_000);
	strictEqual(model.maxTokens, 8_192);
});

test("施加改的是传入对象本身，不是另一份克隆", () => {
	const model = { contextWindow: 1_000_000, maxTokens: 512_000 };
	const models = [model];
	applyContextCap(models);
	strictEqual(models[0], model);
	strictEqual(model.contextWindow, 256_000);
	strictEqual(model.maxTokens, 256_000);
});
