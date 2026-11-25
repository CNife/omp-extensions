export interface ModelGate {
	include: string[];
	exclude: string[];
}

export interface LoopReflectionConfig {
	enabled: boolean;
	intervalTurns: number;
	models: ModelGate;
	reminderText: string;
}

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
	warning?: string;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function fallback(reason: string): ParsedConfig {
	return { config: structuredClone(DEFAULT_CONFIG), warning: reason };
}

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

export interface ModelLike {
	provider: string;
	id: string;
}

export function modelKeyOf(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

function globToRegExp(pattern: string): RegExp {
	const body = pattern
		.trim()
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${body}$`, "i");
}

function patternMatches(pattern: string, model: ModelLike): boolean {
	if (pattern.trim() === "") return false;
	const re = globToRegExp(pattern);
	return re.test(modelKeyOf(model)) || re.test(model.id);
}

export function matchesModelGate(model: ModelLike | undefined, gate: ModelGate): boolean {
	if (model === undefined) return false;
	if (gate.exclude.some((pattern) => patternMatches(pattern, model))) return false;
	if (gate.include.length === 0) return true;
	return gate.include.some((pattern) => patternMatches(pattern, model));
}

export interface LoopReflectionState {
	turnsUntilNextReminder: number;
	lastModelKey: string | undefined;
}

export type LoopReflectionEvent =
	| { kind: "turn"; model: ModelLike | undefined; isToolUse: boolean }
	| { kind: "reset" };

export interface Reminder {
	modelKey: string;
}

export interface NextStateResult {
	state: LoopReflectionState;
	reminder?: Reminder;
}

export function initialState(intervalTurns: number): LoopReflectionState {
	return { turnsUntilNextReminder: intervalTurns, lastModelKey: undefined };
}

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

export function renderReminderText(config: LoopReflectionConfig): string {
	return config.reminderText.replaceAll("{turns}", String(config.intervalTurns));
}

export function formatToast(turnNumber: number, modelKey: string): string {
	return `Loop reflection at turn ${turnNumber} (${modelKey})`;
}
