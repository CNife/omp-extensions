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
	mode?: string;
	hasUI?: boolean;
	modelRegistry?: { getAvailable(): ModelLike[] };
	ui?: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
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

			const ui = ctx.ui;
			if (ui === undefined || typeof ui.select !== "function") {
				process.stderr.write("ask-consultants: 需要 omp 19.2+（宿主未提供 ctx.ui.select）。\n");
				return;
			}
			let focus: string | undefined;
			for (;;) {
				const menu = buildModelMenuItems(models, selected);
				const labels = menu.map((it) => it.label);
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
				if (index < 0) return;
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
