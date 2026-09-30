/**
 * ask-consultants 纯逻辑测试。
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import {
	buildModelMenuItems,
	DEFAULT_MEMBERS,
	invalidMembers,
	parseMembers,
	SELECTOR_RE,
	toggleSelected,
	type ModelLike,
} from "../extensions/consultants-logic.ts";

// ============================================================================
// Fixtures
// ============================================================================

function makeModel(provider: string, id: string): ModelLike {
	return { provider, id };
}

// ============================================================================
// SELECTOR_RE / invalidMembers
// ============================================================================

test("SELECTOR_RE: 裸 provider/id 合法，id 可含斜杠", () => {
	ok(SELECTOR_RE.test("openai-codex/gpt-6-sol"));
	ok(SELECTOR_RE.test("ark-coding-plan/glm-5.3-flash"));
	ok(SELECTOR_RE.test("openrouter/~anthropic/claude-fable-latest"));
	ok(SELECTOR_RE.test("aiand/deepseek-ai/deepseek-v4-flash"));
});

test("SELECTOR_RE: 拒绝 ^ 前缀、空白、缺斜杠、空段、尾斜杠", () => {
	ok(!SELECTOR_RE.test("^openai-codex/gpt-6-sol"));
	ok(!SELECTOR_RE.test("openai-codex /gpt-6"));
	ok(!SELECTOR_RE.test("openai-codex"));
	ok(!SELECTOR_RE.test("a//b"));
	ok(!SELECTOR_RE.test("a/b/"));
	ok(!SELECTOR_RE.test("/a/b"));
	ok(!SELECTOR_RE.test(""));
});

test("invalidMembers: 挑出旧格式与非法条目", () => {
	deepStrictEqual(
		invalidMembers(["openai-codex/gpt-6-sol", "^old/format", "no-slash"]),
		["^old/format", "no-slash"],
	);
});

// ============================================================================
// parseMembers
// ============================================================================

test("parseMembers: 合法配置原样返回", () => {
	deepStrictEqual(parseMembers('{"members": ["a/b", "c/d"]}'), ["a/b", "c/d"]);
});

test("parseMembers: members 非数组视为无成员（明确清空）", () => {
	deepStrictEqual(parseMembers('{"members": "a/b"}'), []);
	deepStrictEqual(parseMembers("{}"), []);
});

test("parseMembers: 顶层 null 视为无成员（不抛 TypeError）", () => {
	deepStrictEqual(parseMembers("null"), []);
});

test("parseMembers: 非法 JSON 抛 SyntaxError（不悄悄回退默认）", () => {
	let threw = false;
	try {
		parseMembers("{oops");
	} catch (err) {
		threw = err instanceof SyntaxError;
	}
	ok(threw);
});

// ============================================================================
// buildModelMenuItems
// ============================================================================

test("buildModelMenuItems: 全量候选 + 选中态，字母序", () => {
	const models = [makeModel("zeta", "m1"), makeModel("alpha", "m2")];
	deepStrictEqual(buildModelMenuItems(models, ["zeta/m1"]), [
		{ selector: "alpha/m2", label: "alpha/m2", enabled: false },
		{ selector: "zeta/m1", label: "zeta/m1", enabled: true },
	]);
});

test("buildModelMenuItems: 配置里登记但当前不可用的条目保留并加后缀", () => {
	const models = [makeModel("alpha", "m2")];
	deepStrictEqual(buildModelMenuItems(models, ["gone/m1"]), [
		{ selector: "alpha/m2", label: "alpha/m2", enabled: false },
		{ selector: "gone/m1", label: "gone/m1 (not available)", enabled: true },
	]);
});

// ============================================================================
// toggleSelected
// ============================================================================

test("toggleSelected: on 追加到尾部，off 移除，入参不变", () => {
	const base = ["a/b", "c/d"];
	deepStrictEqual(toggleSelected(base, "e/f", true), ["a/b", "c/d", "e/f"]);
	deepStrictEqual(toggleSelected(base, "a/b", false), ["c/d"]);
	deepStrictEqual(base, ["a/b", "c/d"]);
	// 重复 on：移到尾部，不产生重复项
	deepStrictEqual(toggleSelected(base, "a/b", true), ["c/d", "a/b"]);
});

// ============================================================================
// DEFAULT_MEMBERS
// ============================================================================

test("DEFAULT_MEMBERS: 全部是裸 selector", () => {
	deepStrictEqual(invalidMembers(DEFAULT_MEMBERS), []);
	ok(DEFAULT_MEMBERS.length > 0);
	strictEqual(DEFAULT_MEMBERS[0], "openai-codex/gpt-6-sol");
});
