/**
 * skills-injection 纯逻辑测试。
 *
 * 适配 omp：技能段为 <skills> 块内 `- name: description` 行；hide 对应 pi 的
 * disableModelInvocation。fixtures 贴近 omp buildSystemPrompt 的产出。
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import {
	DEFAULT_CONFIG,
	filterSkillsSection,
	formatStartupSummary,
	parseConfig,
	sortSkillItems,
	summarizeSkills,
	type SkillLike,
} from "../extensions/skills-logic.ts";

// ============================================================================
// Fixtures
// ============================================================================

function makeSkill(
	name: string,
	opts: { hide?: boolean } = {},
): SkillLike {
	return { name, hide: opts.hide ?? false };
}

/** 构造含 <skills> 段的系统提示词（贴近 omp buildSystemPrompt 产出） */
function makeSystemPrompt(skillNames: string[]): string {
	const lines = skillNames.map((n) => `- ${n}: description for ${n}`);
	return `# Skills & Rules\nSkills are specialized knowledge. If one matches your task, you MUST read \`skill://<name>\` before proceeding.\n<skills>\n${lines.join("\n")}\n</skills>\n`;
}

// ============================================================================
// parseConfig
// ============================================================================

test("parseConfig: 合法配置原样返回", () => {
	deepStrictEqual(parseConfig({ excluded: ["a", "b"] }), {
		excluded: ["a", "b"],
	});
});

test("parseConfig: 空数组", () => {
	deepStrictEqual(parseConfig({ excluded: [] }), { excluded: [] });
});

test("parseConfig: null 回退默认", () => {
	deepStrictEqual(parseConfig(null), DEFAULT_CONFIG);
});

test("parseConfig: 非对象回退默认", () => {
	deepStrictEqual(parseConfig("str"), DEFAULT_CONFIG);
	deepStrictEqual(parseConfig(42), DEFAULT_CONFIG);
});

test("parseConfig: excluded 非数组回退默认", () => {
	deepStrictEqual(parseConfig({ excluded: "x" }), DEFAULT_CONFIG);
	deepStrictEqual(parseConfig({}), DEFAULT_CONFIG);
});

test("parseConfig: 过滤非 string 元素", () => {
	deepStrictEqual(parseConfig({ excluded: ["a", 1, "b", null, true] }), {
		excluded: ["a", "b"],
	});
});

// ============================================================================
// filterSkillsSection
// ============================================================================

test("filterSkillsSection: 有命中 -> 移除被排除的技能行", () => {
	const result = filterSkillsSection(makeSystemPrompt(["a", "b", "c"]), new Set(["b"]));
	ok(result !== null);
	ok(result!.includes("- a:"));
	ok(!result!.includes("- b:"));
	ok(result!.includes("- c:"));
	ok(result!.includes("<skills>"));
	ok(result!.includes("</skills>"));
});

test("filterSkillsSection: 排除集合空 -> null", () => {
	strictEqual(filterSkillsSection(makeSystemPrompt(["a"]), new Set()), null);
});

test("filterSkillsSection: 全部排除 -> 技能段消失", () => {
	const result = filterSkillsSection(
		makeSystemPrompt(["a", "b"]),
		new Set(["a", "b"]),
	);
	ok(result !== null);
	ok(!result!.includes("<skills>"));
	ok(!result!.includes("- a:"));
	ok(!result!.includes("- b:"));
	ok(!result!.includes("Skills are specialized knowledge"));
});

test("filterSkillsSection: 正则未匹配（无 skills 段）-> null", () => {
	strictEqual(
		filterSkillsSection("no skills section here", new Set(["a"])),
		null,
	);
});

test("filterSkillsSection: 无命中 -> null", () => {
	strictEqual(
		filterSkillsSection(makeSystemPrompt(["a", "b"]), new Set(["zzz"])),
		null,
	);
});

test("filterSkillsSection: 多技能保留剩余项原序", () => {
	const result = filterSkillsSection(
		makeSystemPrompt(["a", "b", "c", "d"]),
		new Set(["b", "d"]),
	);
	ok(result !== null);
	const block = result!.match(/<skills>\n([\s\S]*?)\n<\/skills>/)?.[1];
	deepStrictEqual(block?.split("\n"), [
		"- a: description for a",
		"- c: description for c",
	]);
});

// ============================================================================
// summarizeSkills / formatStartupSummary
// ============================================================================

test("summarizeSkills: 三类分类 + 字母序", () => {
	const skills = [makeSkill("z", { hide: true }), makeSkill("b"), makeSkill("a")];
	const summary = summarizeSkills(skills, new Set(["b"]));
	deepStrictEqual(summary.injected, ["a"]);
	deepStrictEqual(summary.forbidden, ["b"]);
	deepStrictEqual(summary.nonInjectable, ["z"]);
});

test("summarizeSkills: 全部 injected", () => {
	const skills = [makeSkill("b"), makeSkill("a")];
	const summary = summarizeSkills(skills, new Set());
	deepStrictEqual(summary.injected, ["a", "b"]);
	deepStrictEqual(summary.forbidden, []);
	deepStrictEqual(summary.nonInjectable, []);
});

test("summarizeSkills: excluded 命中 hide 仍归 non-injectable", () => {
	const skills = [makeSkill("a", { hide: true })];
	const summary = summarizeSkills(skills, new Set(["a"]));
	deepStrictEqual(summary.injected, []);
	deepStrictEqual(summary.forbidden, []);
	deepStrictEqual(summary.nonInjectable, ["a"]);
});

test("formatStartupSummary: 多行英文 + 空类写 0", () => {
	strictEqual(
		formatStartupSummary({
			injected: ["a", "b"],
			forbidden: [],
			nonInjectable: ["z"],
		}),
		"Skills injection\ninjected (2): a, b\nforbidden (0): 0\nnon-injectable (1): z",
	);
});

// ============================================================================
// sortSkillItems
// ============================================================================

test("sortSkillItems: 纯字母序", () => {
	const items = [{ name: "b" }, { name: "a" }, { name: "c" }];
	deepStrictEqual(sortSkillItems(items), [
		{ name: "a" },
		{ name: "b" },
		{ name: "c" },
	]);
});

test("sortSkillItems: 不修改原数组", () => {
	const items = [{ name: "b" }, { name: "a" }];
	const sorted = sortSkillItems(items);
	deepStrictEqual(items, [{ name: "b" }, { name: "a" }]);
	deepStrictEqual(sorted, [{ name: "a" }, { name: "b" }]);
});
