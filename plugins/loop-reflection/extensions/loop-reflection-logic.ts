/**
 * loop-reflection 的纯逻辑（零运行时 omp 依赖）。
 *
 * 三件事：配置解析、模型门控、计数归约。扩展入口只接线。
 */

// ──── Config ────────────────────────────────────────────────────

export interface ModelGate {
	/** glob 白名单；空表示不限制。 */
	include: string[];
	/** glob 黑名单；优先于 include。 */
	exclude: string[];
}

export interface LoopReflectionConfig {
	enabled: boolean;
	/** 两次收敛检查之间要推进的回合数。 */
	intervalTurns: number;
	models: ModelGate;
	/** 提醒文案；`{turns}` 会被替换为实际间隔。 */
	reminderText: string;
}

/** 默认文案：`{turns}` 为实际间隔，触发时替换。 */
export const DEFAULT_REMINDER_TEXT = `<loop-reflection turns="{turns}">
本 run 已连续推进 {turns} 个回合。停下来一次，只回答三个问题：

1. 目标是否已经达成？达成就停止验证，直接交付。
2. 下一次调用能否推翻已有结论？不能就停手交付。
3. 下一步是否在重做已完成的验证？是就停下。

方向不确定就停下来问用户，不要靠猜继续推进。判断清晰就直接继续，不要解释。
</loop-reflection>`;

export const DEFAULT_CONFIG: LoopReflectionConfig = {
	enabled: true,
	intervalTurns: 15,
	models: { include: [], exclude: [] },
	reminderText: DEFAULT_REMINDER_TEXT,
};

export interface ParsedConfig {
	config: LoopReflectionConfig;
	/** 配置不合法时的告警文本（此时 config 已是默认值）。 */
	warning?: string;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** 回退默认配置并给出告警。 */
function fallback(reason: string): ParsedConfig {
	return { config: structuredClone(DEFAULT_CONFIG), warning: reason };
}

/**
 * 解析配置 JSON（已 JSON.parse 的值）。
 *
 * 任何字段不合法都整体回退默认值并给出告警——不做逐字段降级：
 * 配置要么可信，要么回到默认。
 */
export function parseConfig(parsed: unknown): ParsedConfig {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return fallback("config is not an object");
	}
	const value = parsed as Record<string, unknown>;

	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		return fallback("enabled must be a boolean");
	}
	if (value.intervalTurns !== undefined && !isPositiveInteger(value.intervalTurns)) {
		return fallback("intervalTurns must be a positive integer");
	}
	if (value.reminderText !== undefined) {
		if (typeof value.reminderText !== "string" || value.reminderText.trim() === "") {
			return fallback("reminderText must be a non-empty string");
		}
	}

	let models: ModelGate = { include: [], exclude: [] };
	const rawModels = value.models;
	if (rawModels !== undefined) {
		if (typeof rawModels !== "object" || rawModels === null || Array.isArray(rawModels)) {
			return fallback("models must be an object");
		}
		const gate = rawModels as Record<string, unknown>;
		if (gate.include !== undefined && !isStringArray(gate.include)) {
			return fallback("models.include must be an array of strings");
		}
		if (gate.exclude !== undefined && !isStringArray(gate.exclude)) {
			return fallback("models.exclude must be an array of strings");
		}
		models = {
			include: (gate.include as string[] | undefined) ?? [],
			exclude: (gate.exclude as string[] | undefined) ?? [],
		};
	}

	return {
		config: {
			enabled: (value.enabled as boolean | undefined) ?? DEFAULT_CONFIG.enabled,
			intervalTurns: (value.intervalTurns as number | undefined) ?? DEFAULT_CONFIG.intervalTurns,
			models,
			reminderText: (value.reminderText as string | undefined) ?? DEFAULT_CONFIG.reminderText,
		},
	};
}

// ──── 模型门控 ──────────────────────────────────────────────────

export interface ModelLike {
	provider: string;
	id: string;
}

/** `provider/id`，用于 toast、会话条目与同模型判定。 */
export function modelKeyOf(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

/** 单条 glob 转正则：`*` 匹配任意字符（含 `/`），其余字符按字面处理。 */
function globToRegExp(pattern: string): RegExp {
	const body = pattern
		.trim()
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${body}$`, "i");
}

/** pattern 是否命中模型：先试 `provider/id`，再退化试裸 `id`。 */
function patternMatches(pattern: string, model: ModelLike): boolean {
	if (pattern.trim() === "") return false;
	const re = globToRegExp(pattern);
	return re.test(modelKeyOf(model)) || re.test(model.id);
}

/**
 * 模型门控：exclude 优先于 include；两侧都空 = 全启用。
 * 模型未知时不命中（无从判断，按「不计」处理）。
 */
export function matchesModelGate(model: ModelLike | undefined, gate: ModelGate): boolean {
	if (model === undefined) return false;
	if (gate.exclude.some((pattern) => patternMatches(pattern, model))) return false;
	if (gate.include.length === 0) return true;
	return gate.include.some((pattern) => patternMatches(pattern, model));
}

// ──── 计数归约 ──────────────────────────────────────────────────

export interface LoopReflectionState {
	/** 还差几个回合触发下一次收敛检查。 */
	turnsUntilNextReminder: number;
	/** 上一回合计数时所处的模型（`provider/id`），用于识别切换。 */
	lastModelKey: string | undefined;
}

export type LoopReflectionEvent =
	| { kind: "turn"; model: ModelLike | undefined; isToolUse: boolean }
	| { kind: "reset" };

export interface Reminder {
	/** 触发时所处的模型（`provider/id`），供 toast 与会话条目使用。 */
	modelKey: string;
}

export interface NextStateResult {
	state: LoopReflectionState;
	reminder?: Reminder;
}

export function initialState(intervalTurns: number): LoopReflectionState {
	return { turnsUntilNextReminder: intervalTurns, lastModelKey: undefined };
}

/**
 * 单步归约。
 *
 * - reset：回到满值并忘掉上一模型
 * - 门控不匹配（或插件关闭、模型未知）：完全不计
 * - 门控匹配：模型与上一回合不同（含首次进入匹配态）时先重置为满值
 * - 递减后，仅当该回合还会继续（`toolUse`）且计数 `<= 0` 才触发
 * - 触发后复位为满值
 */
export function nextState(
	state: LoopReflectionState,
	event: LoopReflectionEvent,
	config: LoopReflectionConfig,
): NextStateResult {
	if (event.kind === "reset") {
		return { state: initialState(config.intervalTurns) };
	}

	if (!config.enabled) return { state };
	const { model } = event;
	if (model === undefined || !matchesModelGate(model, config.models)) return { state };

	const modelKey = modelKeyOf(model);
	const base =
		state.lastModelKey === modelKey ? state.turnsUntilNextReminder : config.intervalTurns;
	const remaining = base - 1;

	if (event.isToolUse && remaining <= 0) {
		return {
			state: { turnsUntilNextReminder: config.intervalTurns, lastModelKey: modelKey },
			reminder: { modelKey },
		};
	}

	return { state: { turnsUntilNextReminder: remaining, lastModelKey: modelKey } };
}

// ──── 文案 ──────────────────────────────────────────────────────

/** 把配置文案里的 `{turns}` 全部替换为实际间隔。 */
export function renderReminderText(config: LoopReflectionConfig): string {
	return config.reminderText.replaceAll("{turns}", String(config.intervalTurns));
}

/** toast 文案：只报当下事实，不带累计序号；`turnNumber` 为从 1 起的人类回合数。 */
export function formatToast(turnNumber: number, modelKey: string): string {
	return `Loop reflection at turn ${turnNumber} (${modelKey})`;
}
