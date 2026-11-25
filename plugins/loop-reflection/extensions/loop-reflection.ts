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

const CONFIG_PATH = join(getAgentDir(), "cnife-loop-reflection.json");
const ENTRY_TYPE = "loop-reflection";

let lastWarning: string | undefined;

function warnConfig(message: string): void {
	if (message === lastWarning) return;
	lastWarning = message;
	console.warn(`[loop-reflection] ${message}`);
}

function ensureDefaultConfig(): void {
	if (existsSync(CONFIG_PATH)) return;
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
	} catch {
		warnConfig("Failed to create default config file");
	}
}

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

export default function loopReflection(pi: ExtensionLike) {
	pi.setLabel("Loop Reflection");

	let state: LoopReflectionState = initialState(loadConfig().intervalTurns);

	const reset = (ctx: ContextLike) => {
		if (ctx.agent.kind !== "main") return;
		state = initialState(loadConfig().intervalTurns);
	};

	pi.on("session_start", (_event: unknown, ctx: ContextLike) => reset(ctx));
	pi.on("session_tree", (_event: unknown, ctx: ContextLike) => reset(ctx));
	pi.on("session_compact", (_event: unknown, ctx: ContextLike) => reset(ctx));
	pi.on("agent_start", (_event: unknown, ctx: ContextLike) => reset(ctx));
	pi.on("input", (event: InputEvent, ctx: ContextLike) => {
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

		pi.sendMessage(
			{ customType: ENTRY_TYPE, content: renderReminderText(config), display: false },
			{ deliverAs: "steer" },
		);
		ctx.ui.notify(formatToast(event.turnIndex + 1, reminder.modelKey), "info");
		pi.appendEntry(ENTRY_TYPE, { turnIndex: event.turnIndex, model: reminder.modelKey });
	});
}
