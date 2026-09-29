/**
 * ask-consultants - 多模型顾问团面板（分发插件，非能力扩展）。
 *
 * 唯一职责：把 /ask-consultants 命令展开为「^模型标签 + 面板指引」的用户消息投递。
 * 伪名注册只发生在用户路径（expandMentions 对非 synthetic prompt 生效，
 * 见 agent-session.ts #dispatchPrompt），sendUserMessage 走 prompt
 * (expandPromptTemplates:false) 但 expandMentions 不受该旗标影响，
 * 因此本扩展投递的 ^ 标签会正常注册为 m1、m2、…。
 *
 * 为什么不用 manifest commands 键：omp 插件的 commands 声明目前是死管道
 * （resolvePluginCommandPaths 无调用方，命令发现不扫插件根），清单声明的
 * 命令文件不会被加载。
 *
 * 成员清单解析顺序：
 * 1. ~/.omp/agent/panel-members.md（个人覆盖，内容为若干行 ^provider/id）
 * 2. 内置默认成员（DEFAULT_MEMBERS）
 * 个人覆盖文件不会被 omp plugin upgrade 覆盖。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_MEMBERS = [
	"^openai-codex/gpt-6-sol",
	"^ark-coding-plan/glm-5.3-flash",
	"^opencode-go/deepseek-v4.1-flash",
];

const OVERRIDE_FILE = ".omp/agent/consultants.md";

/** 插件用到的 omp ExtensionAPI 最小面（与 @earendil-works/pi-coding-agent 对齐）。 */
export interface PiLike {
	registerCommand(
		name: string,
		opts: {
			description: string;
			handler: (args: string | undefined, ctx: CommandCtx) => void | Promise<void>;
		},
	): void;
	sendUserMessage(content: string, opts?: unknown): void;
}

export interface CommandCtx {
	/** 宿主模式；print/json 等无 UI 宿主无法承载命令触发的后续回合。 */
	mode?: string;
	hasUI?: boolean;
	ui?: {
		notify(message: string, type: "info" | "error"): void;
	};
}

/** 逐行提取 ^provider/id 标签；空行与注释行忽略。 */
export function parseMembers(text: string): string[] {
	const tags: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("<!--") || trimmed.startsWith("#")) continue;
		for (const match of trimmed.matchAll(/(^|\s)\^([^\s^]+)/g)) {
			tags.push(`^${match[2]}`);
		}
	}
	return tags;
}

export default function activate(pi: PiLike): void {
	pi.registerCommand("ask-consultants", {
		description: "召集多模型顾问团：一步注册面板成员伪名并按 ask-consultants 技能评审",
		handler: async (args, ctx) => {
			// print/json 宿主里，命令消费初始 prompt 后进程即收场，sendUserMessage
			// 起的回合会被杀掉——与其静默无输出，不如明确告知改用交互式会话。
			// 此分支只在无 UI 宿主执行（TUI 路径不会到达），stderr 直写不污染渲染。
			if (ctx.hasUI === false || ctx.mode === "print") {
				process.stderr.write(
					"ask-consultants: 需要交互式会话（TUI）。无头场景请在消息里直接用 ^provider/id 标签点名成员。\n",
				);
				return;
			}
			let tags = DEFAULT_MEMBERS;
			try {
				const override = fs.readFileSync(path.join(os.homedir(), OVERRIDE_FILE), "utf8");
				const parsed = parseMembers(override);
				if (parsed.length > 0) tags = parsed;
			} catch {
				// 无个人覆盖文件，用默认成员
			}

			const target = args?.trim() ? args.trim() : "（待补充评审对象——请先运行 /ask-consultants <评审对象>）";
			await pi.sendUserMessage(
				`${tags.join(" ")}\n\n` +
					`以上 \`^\` 标记注册的伪名（m1、m2、…）是本会话的顾问团成员。` +
					`请调用 ask-consultants 技能，对下面的评审对象执行面板评审：\n\n${target}`,
			);
		},
	});
}
