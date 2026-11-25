/**
 * ask-consultants - 多模型顾问团（分发插件，非能力扩展）。
 *
 * 两条命令：
 * - /consultants：ctx.ui.select 勾选列表选择成员（对齐 /inject-skills），
 *   候选取 ctx.modelRegistry.getAvailable()，切换即时写入成员配置。
 * - /ask-consultants <评审对象>：把成员清单展开为「^模型标签 + 顾问团指引」
 *   的用户消息投递。代号注册只发生在用户路径（expandMentions 对非
 *   synthetic prompt 生效，见 agent-session.ts #dispatchPrompt），sendUserMessage
 *   走 prompt (expandPromptTemplates:false) 但 expandMentions 不受该旗标影响，
 *   因此投递的 ^ 标签会正常注册为 m1、m2、…。
 *
 * 为什么不用 manifest commands 键声明命令：见 docs/adr/0004-plugin-commands-dead-pipe.md。
 *
 * 成员配置 ~/.omp/agent/cnife-ask-consultants.json（不会被 omp plugin upgrade
 * 覆盖）：裸 `provider/id` selector，结构见 README。存在即生效——members 为空 =
 * 明确清空成员清单、不派发；仅 ENOENT 时回退内置默认成员 DEFAULT_MEMBERS；
 * JSON 写错时明确报错不派发（不会悄悄换成默认成员）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import {
	buildModelMenuItems,
	type ModelLike,
	parseMembers,
	toggleSelected,
	invalidMembers,
	DEFAULT_MEMBERS,
} from "./consultants-logic.ts";

const CONFIG_PATH = join(getAgentDir(), "cnife-ask-consultants.json");

/** 插件用到的 omp ExtensionAPI 最小面。 */
export interface PiLike {
	registerCommand(
		name: string,
		opts: {
			description: string;
			handler: (args: string | undefined, ctx: CommandCtx) => void | Promise<void>;
		},
	): void;
	sendUserMessage(content: string): void;
}

export interface CommandCtx {
	/** 宿主模式；print/json 等无 UI 宿主无法承载命令触发的后续回合。 */
	mode?: string;
	hasUI?: boolean;
	/** 命令上下文的模型注册表（/consultants 的候选来源）。 */
	modelRegistry?: { getAvailable(): ModelLike[] };
	ui?: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		/** 勾选列表：checkedIndices 为已勾选行，返回被选行的 label（Esc 为 undefined）。 */
		select(
			title: string,
			options: readonly string[],
			dialogOptions?: {
				initialIndex?: number;
				outline?: boolean;
				selectionMarker?: "radio" | "checkbox";
				checkedIndices?: readonly number[];
				markableCount?: number;
			},
		): Promise<string | undefined>;
	};
}

function saveMembers(members: string[]): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ members }, null, 2)}\n`, "utf8");
}

/**
 * 读取成员配置。返回 undefined = 文件不存在（调用方回退默认成员）；
 * JSON 非法时抛 SyntaxError（由调用方明确报错，不悄悄回退）。
 */
function loadMembersFile(): string[] | undefined {
	let raw: string;
	try {
		raw = readFileSync(CONFIG_PATH, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	return parseMembers(raw);
}

/** 无 UI 宿主共用守卫：print/json 里命令触发的交互/回合无法存活，stderr 明确告知。 */
function requireTui(ctx: CommandCtx): boolean {
	if (ctx.hasUI === false || ctx.mode === "print") {
		process.stderr.write("ask-consultants: 需要交互式会话（TUI）。\n");
		return false;
	}
	return true;
}

export default function activate(pi: PiLike): void {
	pi.registerCommand("consultants", {
		description: "选择顾问团成员模型（切换即时保存）",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;

			const models = ctx.modelRegistry?.getAvailable() ?? [];
			if (models.length === 0) {
				ctx.ui?.notify("无可用模型：当前没有任何已认证的 provider", "warning");
				return;
			}

			let selected: string[];
			try {
				selected = loadMembersFile() ?? DEFAULT_MEMBERS;
			} catch {
				ctx.ui?.notify("cnife-ask-consultants.json 读取失败或不是有效 JSON，请修复后再试", "error");
				return;
			}

			// omp 19.2 起 pi-tui 的 SettingsList 已移除，改用它原生的 ctx.ui.select 勾选列表
			// （selectionMarker: "checkbox"）：每次 Enter 关掉再按新状态重开，切换即写配置。
			const ui = ctx.ui;
			if (ui === undefined) return;
			// 重开时把光标放回刚切换的那一行（按 selector，已启用行会排到前面）。
			let focus: string | undefined;
			for (;;) {
				const menu = buildModelMenuItems(models, selected);
				const labels = menu.map((it) => it.label);
				// 勾选 = 在顾问团成员清单里；Done 行不在 markableCount 内，Esc 返回 undefined。
				const checkedIndices = menu.flatMap((it, i) => (it.enabled ? [i] : []));
				const picked = await ui.select(
					`Consultants Panel — ${checkedIndices.length} of ${menu.length} selected`,
					[...labels, "Done selecting"],
					{
						outline: true,
						initialIndex: Math.max(
							0,
							menu.findIndex((it) => it.selector === focus),
						),
						selectionMarker: "checkbox",
						checkedIndices,
						markableCount: menu.length,
					},
				);
				const index = picked === undefined ? -1 : labels.indexOf(picked);
				if (index < 0) return; // Done selecting / Esc
				const item = menu[index]!;
				selected = toggleSelected(selected, item.selector, !item.enabled);
				saveMembers(selected);
				focus = item.selector;
			}
		},
	});

	pi.registerCommand("ask-consultants", {
		description: "用多模型顾问团评审：注册成员代号并并行征询各成员的独立意见",
		handler: async (args, ctx) => {
			if (!requireTui(ctx)) return;

			// 个人覆盖文件：存在即生效（members 为空 = 明确清空成员清单，不派发）；
			// 仅 ENOENT 视为未配置，回退默认成员；读取失败警告后回退；
			// JSON 解析失败视为配置未完成，明确不派发——不能悄悄换成默认成员。
			let configured: string[] | undefined;
			try {
				configured = loadMembersFile();
			} catch (err) {
				if (err instanceof SyntaxError) {
					process.stderr.write(`ask-consultants: ${CONFIG_PATH} 不是有效 JSON，本次不派发成员。请修复后再试。\n`);
					return;
				}
				process.stderr.write(`ask-consultants: 读取 ${CONFIG_PATH} 失败，回退默认成员。\n`);
			}
			const tags = configured ?? DEFAULT_MEMBERS;

			// 硬切换：0.1.x 的 ^ 前缀旧格式不再兼容，明确报错引导迁移。
			const bad = invalidMembers(tags);
			if (bad.length > 0) {
				process.stderr.write(
					`ask-consultants: 配置含非法成员 ${bad.join("、")}。` +
						`成员须为裸 provider/id（0.2.0 起去掉 ^ 前缀），可用 /consultants 重新选择。\n`,
				);
				return;
			}
			if (tags.length === 0) {
				process.stderr.write(`ask-consultants: 成员清单为空，本次不派发成员。可用 /consultants 选择成员。\n`);
				return;
			}

			const target = args?.trim() ? args.trim() : "（待补充评审对象——请先运行 /ask-consultants <评审对象>）";
			await pi.sendUserMessage(
				`${tags.map((tag) => `^${tag}`).join(" ")}\n\n` +
					`以上模型标签对应的代号（m1、m2、…）是本会话的顾问团成员。` +
					`请调用 ask-consultants 技能，对下面的评审对象执行顾问团评审：\n\n${target}`,
			);
		},
	});
}
