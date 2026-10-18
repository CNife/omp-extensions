/**
 * loop-reflection 纯逻辑测试。
 *
 * 只断言模块的外部行为：给定配置与事件序列，得到什么（是否触发、计数如何变化、
 * 门控是否命中）。不断言内部字段名，也不触碰 omp 运行时。
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import {
	DEFAULT_CONFIG,
	DEFAULT_REMINDER_TEXT,
	formatToast,
	initialState,
	type LoopReflectionConfig,
	type LoopReflectionEvent,
	type LoopReflectionState,
	matchesModelGate,
	modelKeyOf,
	nextState,
	parseConfig,
	renderReminderText,
} from "../extensions/loop-reflection-logic.ts";

// ============================================================================
// Fixtures
// ============================================================================

const MODEL = { provider: "p", id: "m" };

function configWith(overrides: Partial<LoopReflectionConfig> = {}): LoopReflectionConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

function turn(model: { provider: string; id: string } | undefined, isToolUse = true): LoopReflectionEvent {
	return { kind: "turn", model, isToolUse };
}

/** 连续喂入事件，返回最终状态与每次是否触发。 */
function run(
	config: LoopReflectionConfig,
	events: LoopReflectionEvent[],
	start?: LoopReflectionState,
): { state: LoopReflectionState; fired: boolean[] } {
	let state = start ?? initialState(config.intervalTurns);
	const fired: boolean[] = [];
	for (const event of events) {
		const result = nextState(state, event, config);
		state = result.state;
		fired.push(result.reminder !== undefined);
	}
	return { state, fired };
}

// ============================================================================
// parseConfig
// ============================================================================

test("parseConfig: 合法配置原样返回", () => {
	const parsed = {
		enabled: false,
		intervalTurns: 5,
		models: { include: ["*deepseek*"], exclude: ["*:free"] },
		reminderText: "自定义 {turns}",
	};
	const { config, warning } = parseConfig(parsed);
	deepStrictEqual(config, parsed);
	strictEqual(warning, undefined);
});

test("parseConfig: 空对象补默认值", () => {
	const { config, warning } = parseConfig({});
	deepStrictEqual(config, DEFAULT_CONFIG);
	strictEqual(warning, undefined);
});

test("parseConfig: 缺省字段逐个回填默认值", () => {
	const { config } = parseConfig({ intervalTurns: 3, models: { include: ["a"] } });
	strictEqual(config.enabled, DEFAULT_CONFIG.enabled);
	strictEqual(config.intervalTurns, 3);
	deepStrictEqual(config.models, { include: ["a"], exclude: [] });
	strictEqual(config.reminderText, DEFAULT_REMINDER_TEXT);
});

test("parseConfig: null / 数组 / 标量整体回退默认", () => {
	for (const bad of [null, [], "text", 42]) {
		const { config, warning } = parseConfig(bad);
		deepStrictEqual(config, DEFAULT_CONFIG);
		ok(warning);
	}
});

test("parseConfig: enabled 非布尔整体回退", () => {
	const { config, warning } = parseConfig({ enabled: "yes", intervalTurns: 5 });
	deepStrictEqual(config, DEFAULT_CONFIG);
	ok(warning);
});

test("parseConfig: intervalTurns 非正整数整体回退", () => {
	for (const bad of [0, -1, 2.5, "15", null]) {
		const { config, warning } = parseConfig({ intervalTurns: bad });
		deepStrictEqual(config, DEFAULT_CONFIG);
		ok(warning);
	}
});

test("parseConfig: models 非对象或列表非数组整体回退", () => {
	for (const bad of [{ models: [] }, { models: "x" }, { models: { include: "a" } }, { models: { exclude: 3 } }]) {
		const { config, warning } = parseConfig(bad);
		deepStrictEqual(config, DEFAULT_CONFIG);
		ok(warning);
	}
});

test("parseConfig: 列表含非字符串整体回退（不做逐字段降级）", () => {
	const { config, warning } = parseConfig({ models: { include: ["ok", 7] } });
	deepStrictEqual(config, DEFAULT_CONFIG);
	ok(warning);
});

test("parseConfig: reminderText 非字符串或空串整体回退", () => {
	for (const bad of ["", "   ", 3, null]) {
		const { config, warning } = parseConfig({ reminderText: bad });
		deepStrictEqual(config, DEFAULT_CONFIG);
		ok(warning);
	}
});

test("parseConfig: 未知字段忽略", () => {
	const { config } = parseConfig({ intervalTurns: 4, unknown: true });
	strictEqual(config.intervalTurns, 4);
	strictEqual("unknown" in config, false);
});

// ============================================================================
// matchesModelGate
// ============================================================================

test("matchesModelGate: 两侧都空 -> 全部启用", () => {
	ok(matchesModelGate(MODEL, { include: [], exclude: [] }));
});

test("matchesModelGate: include 命中 provider/id", () => {
	ok(matchesModelGate(MODEL, { include: ["p/m"], exclude: [] }));
});

test("matchesModelGate: include 未命中 -> 关闭", () => {
	strictEqual(matchesModelGate(MODEL, { include: ["anthropic/*"], exclude: [] }), false);
});

test("matchesModelGate: exclude 优先于 include", () => {
	strictEqual(matchesModelGate(MODEL, { include: ["*m"], exclude: ["p/*"] }), false);
});

test("matchesModelGate: 只写裸 id 也能命中（先试 provider/id，再退化试 id）", () => {
	ok(matchesModelGate(MODEL, { include: ["m"], exclude: [] }));
	ok(matchesModelGate(MODEL, { include: ["p*"], exclude: [] }));
});

test("matchesModelGate: 大小写不敏感", () => {
	const model = { provider: "OpenRouter", id: "DeepSeek-V4" };
	ok(matchesModelGate(model, { include: ["openrouter/deepseek-*"], exclude: [] }));
});

test("matchesModelGate: * 跨越 /", () => {
	ok(matchesModelGate(MODEL, { include: ["*m*"], exclude: [] }));
	ok(matchesModelGate(MODEL, { include: ["p*"], exclude: [] }));
});

test("matchesModelGate: 正则元字符按字面处理", () => {
	const model = { provider: "local", id: "qwen3.5:72b" };
	ok(matchesModelGate(model, { include: ["local/qwen3.5:72b"], exclude: [] }));
	strictEqual(matchesModelGate(model, { include: ["local/qwen3X5:72b"], exclude: [] }), false);
});

test("matchesModelGate: 空白 pattern 不匹配", () => {
	strictEqual(matchesModelGate(MODEL, { include: ["  "], exclude: [] }), false);
});

test("matchesModelGate: 模型未知 -> 不匹配", () => {
	ok(!matchesModelGate(undefined, { include: [], exclude: [] }));
});

test("matchesModelGate: exclude 命中裸 id 也生效", () => {
	strictEqual(matchesModelGate(MODEL, { include: [], exclude: ["m"] }), false);
});

// ============================================================================
// nextState —— 计数归约
// ============================================================================

test("nextState: 门控匹配的 turn 递减计数", () => {
	const config = configWith({ intervalTurns: 3 });
	const { state } = run(config, [turn(MODEL, false)]);
	strictEqual(state.turnsUntilNextReminder, 2);
});

test("nextState: 非 toolUse 回合递减但不触发", () => {
	const config = configWith({ intervalTurns: 3 });
	const { fired, state } = run(config, [turn(MODEL, false), turn(MODEL, false), turn(MODEL, false)]);
	deepStrictEqual(fired, [false, false, false]);
	strictEqual(state.turnsUntilNextReminder, 0);
});

test("nextState: 计数归零的 toolUse 回合触发", () => {
	const config = configWith({ intervalTurns: 3 });
	const { fired } = run(config, [turn(MODEL), turn(MODEL), turn(MODEL)]);
	deepStrictEqual(fired, [false, false, true]);
});

test("nextState: 触发后复位为 intervalTurns", () => {
	const config = configWith({ intervalTurns: 2 });
	let state = initialState(config.intervalTurns);
	const first = nextState(state, turn(MODEL), config);
	state = first.state;
	const second = nextState(state, turn(MODEL), config);
	ok(second.reminder);
	strictEqual(second.state.turnsUntilNextReminder, 2);
});

test("nextState: 提醒不封顶，按固定节奏继续触发", () => {
	const config = configWith({ intervalTurns: 2 });
	const events = Array.from({ length: 6 }, () => turn(MODEL));
	deepStrictEqual(run(config, events).fired, [false, true, false, true, false, true]);
});

test("nextState: 门控不匹配的 turn 完全不计", () => {
	const config = configWith({ intervalTurns: 2, models: { include: ["p/ok"], exclude: [] } });
	const { state } = run(config, [
		turn({ provider: "p", id: "ok" }, false),
		turn({ provider: "p", id: "other" }, false),
		turn({ provider: "p", id: "other" }, false),
	]);
	strictEqual(state.turnsUntilNextReminder, 1);
});

test("nextState: 切换模型时从满值重新倒数", () => {
	const config = configWith({ intervalTurns: 3 });
	const { state, fired } = run(config, [turn({ provider: "p", id: "a" }, false), turn({ provider: "p", id: "b" }, false)]);
	deepStrictEqual(fired, [false, false]);
	strictEqual(state.turnsUntilNextReminder, 2);
	strictEqual(state.lastModelKey, "p/b");
});

test("nextState: 首次进入匹配态也从满值倒数（不是立刻弹提醒）", () => {
	const config = configWith({ intervalTurns: 5, models: { include: ["p/*"], exclude: ["p/skip"] } });
	const { state, fired } = run(config, [turn({ provider: "p", id: "skip" }), turn({ provider: "p", id: "ok" })]);
	deepStrictEqual(fired, [false, false]);
	strictEqual(state.turnsUntilNextReminder, 4);
});

test("nextState: 绕经不匹配模型再回原模型不重置", () => {
	const config = configWith({ intervalTurns: 4, models: { include: ["p/a"], exclude: [] } });
	const { state } = run(config, [
		turn({ provider: "p", id: "a" }, false),
		turn({ provider: "p", id: "a" }, false),
		turn({ provider: "p", id: "b" }, false),
		turn({ provider: "p", id: "a" }, false),
	]);
	strictEqual(state.turnsUntilNextReminder, 1);
});

test("nextState: 模型未知时不计", () => {
	const config = configWith({ intervalTurns: 3 });
	const { state, fired } = run(config, [turn(undefined), turn(undefined)]);
	deepStrictEqual(fired, [false, false]);
	strictEqual(state.turnsUntilNextReminder, 3);
});

test("nextState: enabled=false 时完全不计", () => {
	const config = configWith({ enabled: false, intervalTurns: 2 });
	const { state, fired } = run(config, [turn(MODEL), turn(MODEL), turn(MODEL)]);
	deepStrictEqual(fired, [false, false, false]);
	strictEqual(state.turnsUntilNextReminder, 2);
});

test("nextState: reset 事件恢复到满值，并忘掉上一模型", () => {
	const config = configWith({ intervalTurns: 3 });
	let state = initialState(config.intervalTurns);
	state = nextState(state, turn(MODEL, false), config).state;
	state = nextState(state, { kind: "reset" }, config).state;
	deepStrictEqual(state, { turnsUntilNextReminder: 3, lastModelKey: undefined });
});

test("nextState: reset 后首个匹配回合仍从满值倒数", () => {
	const config = configWith({ intervalTurns: 3 });
	const afterReset = nextState(initialState(3), { kind: "reset" }, config).state;
	const { state } = nextState(afterReset, turn(MODEL, false), config);
	strictEqual(state.turnsUntilNextReminder, 2);
});

test("nextState: 触发时提醒携带模型 key", () => {
	const config = configWith({ intervalTurns: 1 });
	const result = nextState(initialState(1), turn(MODEL), config);
	strictEqual(result.reminder?.modelKey, "p/m");
});

test("nextState: 不修改传入的状态对象", () => {
	const config = configWith({ intervalTurns: 3 });
	const state = initialState(3);
	nextState(state, turn(MODEL, false), config);
	deepStrictEqual(state, { turnsUntilNextReminder: 3, lastModelKey: undefined });
});

// ============================================================================
// modelKeyOf
// ============================================================================

test("modelKeyOf: provider/id", () => {
	strictEqual(modelKeyOf(MODEL), "p/m");
});

// ============================================================================
// 文案
// ============================================================================

test("renderReminderText: 默认文案替换全部 {turns} 占位", () => {
	const text = renderReminderText(configWith({ intervalTurns: 7 }));
	ok(text.includes('<loop-reflection turns="7">'));
	ok(text.includes("已连续推进 7 个回合"));
	ok(!text.includes("{turns}"));
});

test("renderReminderText: 自定义文案同样替换占位", () => {
	const text = renderReminderText(configWith({ intervalTurns: 4, reminderText: "stop after {turns}" }));
	strictEqual(text, "stop after 4");
});

test("formatToast: 只报当下事实（turnIndex + 模型）", () => {
	strictEqual(formatToast(12, "p/m"), "Loop reflection at turn 12 (p/m)");
});
