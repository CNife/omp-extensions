/**
 * ask-consultants - 多模型顾问团面板（分发插件，非能力扩展）。
 *
 * 两条命令：
 * - /consultants：SettingsList 交互式选择面板成员（对齐 /inject-skills），
 *   候选取 ctx.modelRegistry.getAvailable()，切换即时写入成员配置。
 * - /ask-consultants <评审对象>：把成员清单展开为「^模型标签 + 面板指引」
 *   的用户消息投递。伪名注册只发生在用户路径（expandMentions 对非
 *   synthetic prompt 生效，见 agent-session.ts #dispatchPrompt），sendUserMessage
 *   走 prompt (expandPromptTemplates:false) 但 expandMentions 不受该旗标影响，
 *   因此投递的 ^ 标签会正常注册为 m1、m2、…。
 *
 * 为什么不用 manifest commands 键声明命令：见 docs/adr/0004-plugin-commands-dead-pipe.md。
 *
 * 成员配置 ~/.omp/agent/cnife-ask-consultants.json（不会被 omp plugin upgrade
 * 覆盖）：裸 `provider/id` selector，结构见 README。存在即生效——members 为空 =
 * 明确清空面板、不派发；仅 ENOENT 时回退内置默认成员 DEFAULT_MEMBERS；
 * JSON 写错时明确报错不派发（不会悄悄换成默认成员）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DynamicBorder,
	getAgentDir,
	getSettingsListTheme,
} from "@oh-my-pi/pi-coding-agent";
import {
	Container,
	type SettingItem,
	type SettingsListTheme,
	SettingsList,
	Text,
} from "@oh-my-pi/pi-tui";
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
		notify(message: string, level?: string): void;
		custom(render: (tui: { requestRender(): void }, theme: UiTheme, kb: unknown, done: (v?: unknown) => void) => unknown): Promise<unknown>;
	};
}

/** 插件用到的 SettingsList 主题最小面（omp 传入的完整主题的结构子集）。 */
export interface UiTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/**
 * 包装 SettingsList 主题：启用中的条目 label 用 success 色高亮，其余走默认主题。
 * `enabled` 按 label 文本记录（渲染时主题 label 函数查询它），toggle 时由 onChange
 * 增删，面板每次输入都 requestRender，所以高亮即时跟随状态。
 */
function withEnabledHighlight(
	base: SettingsListTheme,
	ui: UiTheme,
	enabled: ReadonlySet<string>,
): SettingsListTheme {
	return {
		...base,
		label: (text, selected, changed) =>
			enabled.has(text) ? ui.fg("success", text) : base.label(text, selected, changed),
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
		description: "选择顾问团面板成员模型（切换即时保存）",
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

			const items = buildModelMenuItems(models, selected);
			await ctx.ui?.custom((tui, theme, _kb, done) => {
				const settingItems: SettingItem[] = items.map((it) => ({
					id: it.selector,
					label: it.label,
					currentValue: it.enabled ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));
				// 启用条目的 label 集合：渲染时主题函数查它来高亮，toggle 时同步增删。
				const enabledLabels = new Set(items.filter((it) => it.enabled).map((it) => it.label));
				const labelBySelector = new Map(items.map((it) => [it.selector, it.label] as const));

				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Consultants Panel")), 1, 0));

				const settingsList = new SettingsList(
					settingItems,
					Math.min(settingItems.length + 2, 15),
					withEnabledHighlight(getSettingsListTheme(), theme, enabledLabels),
					(id: string, newValue: string) => {
						selected = toggleSelected(selected, id, newValue === "enabled");
						saveMembers(selected);
						const label = labelBySelector.get(id);
						if (label !== undefined) {
							if (newValue === "enabled") enabledLabels.add(label);
							else enabledLabels.delete(label);
						}
					},
					() => {
						done(undefined);
					},
					{ enableSearch: true },
				);

				container.addChild(settingsList);
				container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	pi.registerCommand("ask-consultants", {
		description: "用多模型顾问团评审：注册面板成员伪名并并行征询各成员的独立意见",
		handler: async (args, ctx) => {
			if (!requireTui(ctx)) return;

			// 个人覆盖文件：存在即生效（members 为空 = 明确清空面板，不派发）；
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
					`以上 \`^\` 标记注册的伪名（m1、m2、…）是本会话的顾问团成员。` +
					`请调用 ask-consultants 技能，对下面的评审对象执行面板评审：\n\n${target}`,
			);
		},
	});
}
