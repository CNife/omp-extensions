/**
 * loop-reflection — 主循环周期收敛检查。
 *
 * 主循环连续推进 N 个回合后，以一条隐藏 custom 消息插入一次收敛检查：
 * 它要求模型停下来只回答三个问题（目标是否达成、证据是否足够、下一步是否
 * 仍是最小有效动作），并明确禁止「先解释再继续」。
 *
 * 通道选择见 docs/adr/0006-reflection-developer-channel.md：custom 消息在
 * provider 侧落成 developer 角色，不会被包成「用户在工作途中打断」。
 * 触发事实由 toast 与会话条目承担（后者不进 LLM）。
 *
 * 纯逻辑（配置解析、模型门控、计数归约、文案）在 ./loop-reflection-logic.ts，
 * 本文件只接线：读配置、订阅事件、调宿主 API。
 *
 * 配置：~/.omp/agent/cnife-loop-reflection.json；文件不存在时写出默认配置。
 * 移植自 pi 的 agent-loop-reflection，三处刻意偏离见 README。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	formatToast,
	initialState,
	type LoopReflectionConfig,
	type LoopReflectionState,
	nextState,
	parseConfig,
	renderReminderText,
} from "./loop-reflection-logic.ts";

// ──── Config IO ─────────────────────────────────────────────────

const CONFIG_PATH = join(getAgentDir(), "cnife-loop-reflection.json");
const ENTRY_TYPE = "loop-reflection";

/** 同一告警只打一次，避免每回合刷屏。 */
let lastWarning: string | undefined;

function warnConfig(message: string): void {
	if (message === lastWarning) return;
	lastWarning = message;
	console.warn(`[loop-reflection] ${message}`);
}

/** 文件不存在时写出默认配置；写失败只告警，不阻塞插件。 */
function ensureDefaultConfig(): void {
	if (existsSync(CONFIG_PATH)) return;
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
	} catch {
		warnConfig("Failed to create default config file");
	}
}

/** 每次现读：`enabled` 等开关改动无需重启即可生效。 */
function loadConfig(): LoopReflectionConfig {
	if (!existsSync(CONFIG_PATH)) {
		ensureDefaultConfig();
		return structuredClone(DEFAULT_CONFIG);
	}

	let raw: string;
	try {
		raw = readFileSync(CONFIG_PATH, "utf-8");
	} catch {
		warnConfig("Failed to read config file, using defaults");
		return structuredClone(DEFAULT_CONFIG);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		warnConfig("Invalid JSON in config file, using defaults");
		return structuredClone(DEFAULT_CONFIG);
	}

	const { config, warning } = parseConfig(parsed);
	if (warning !== undefined) warnConfig(`${warning}, using defaults`);
	return config;
}

// ──── 宿主面（只声明本插件用到的字段）────────────────────────────

interface ModelRef {
	provider: string;
	id: string;
}

interface TurnEndEvent {
	turnIndex: number;
	message: { role: string; stopReason?: string };
}

interface InputEvent {
	source: "interactive" | "rpc" | "extension";
}

interface ContextLike {
	agent: { kind: "main" | "sub" };
	model: ModelRef | undefined;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

/** 宿主扩展 API 中本插件用到的部分（omp 未把该类型打进本仓的检查面）。 */
interface ExtensionEvents {
	session_start: unknown;
	session_tree: unknown;
	session_compact: unknown;
	agent_start: unknown;
	input: InputEvent;
	turn_end: TurnEndEvent;
}

interface ExtensionLike {
	setLabel(label: string): void;
	on<E extends keyof ExtensionEvents>(
		event: E,
		handler: (event: ExtensionEvents[E], ctx: ContextLike) => void,
	): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { deliverAs?: "steer" },
	): void;
	appendEntry(customType: string, data?: unknown): void;
}

// ──── Entry Point ───────────────────────────────────────────────

export default function loopReflection(pi: ExtensionLike) {
	pi.setLabel("Loop Reflection");

	let state: LoopReflectionState = initialState(loadConfig().intervalTurns);

	const reset = (ctx: ContextLike) => {
		if (ctx.agent.kind !== "main") return;
		state = initialState(loadConfig().intervalTurns);
	};

	// 重置点：会话/分支/压缩/agent 起点，以及任何用户侧输入。
	pi.on("session_start", (_event: unknown, ctx: ContextLike) => reset(ctx));
	pi.on("session_tree", (_event: unknown, ctx: ContextLike) => reset(ctx));
	pi.on("session_compact", (_event: unknown, ctx: ContextLike) => reset(ctx));
	pi.on("agent_start", (_event: unknown, ctx: ContextLike) => reset(ctx));
	pi.on("input", (event: InputEvent, ctx: ContextLike) => {
		// 排除扩展来源的输入：插件注入若走 input 通道，重置自己会把计数永远压在满值。
		// 当前宿主对 sendMessage 注入不派发 input，这条 guard 是防御性的。
		if (event.source === "extension") return;
		reset(ctx);
	});

	pi.on("turn_end", (event: TurnEndEvent, ctx: ContextLike) => {
		if (ctx.agent.kind !== "main") return;
		if (event.message.role !== "assistant") return;

		const config = loadConfig();
		const { state: next, reminder } = nextState(
			state,
			{
				kind: "turn",
				model: ctx.model,
				isToolUse: event.message.stopReason === "toolUse",
			},
			config,
		);
		state = next;
		if (reminder === undefined) return;

		// 隐藏 custom 消息：provider 侧落成 developer 角色，transcript 不渲染。
		pi.sendMessage(
			{ customType: ENTRY_TYPE, content: renderReminderText(config), display: false },
			{ deliverAs: "steer" },
		);
		// omp 的 turnIndex 是零基；toast 展示从 1 起的人类回合数，条目保留宿主原值。
		ctx.ui.notify(formatToast(event.turnIndex + 1, reminder.modelKey), "info");
		pi.appendEntry(ENTRY_TYPE, { turnIndex: event.turnIndex, model: reminder.modelKey });
	});
}
