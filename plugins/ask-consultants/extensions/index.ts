/**
 * ask-consultants - 多模型顾问团面板（分发插件，非能力扩展）。
 *
 * 唯一职责：把 /ask-consultants 命令展开为「^模型标签 + 面板指引」的用户消息投递。
 * 伪名注册只发生在用户路径（expandMentions 对非 synthetic prompt 生效，
 * 见 agent-session.ts #dispatchPrompt），sendUserMessage 走 prompt
 * (expandPromptTemplates:false) 但 expandMentions 不受该旗标影响，
 * 因此本扩展投递的 ^ 标签会正常注册为 m1、m2、…。
 *
 * 为什么不用 manifest commands 键声明命令：见 docs/adr/0004-plugin-commands-dead-pipe.md。
 *
 * 成员清单解析顺序：~/.omp/agent/cnife-ask-consultants.json（个人覆盖，
 * 结构见 README；members 为空 = 明确清空面板，不派发；仅 ENOENT 时回退
 * 内置默认成员 DEFAULT_MEMBERS）。覆盖文件不会被 omp plugin upgrade 覆盖。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_MEMBERS = [
	"^openai-codex/gpt-6-sol",
	"^ark-coding-plan/glm-5.3-flash",
	"^opencode-go/deepseek-v4.1-flash",
];

const OVERRIDE_FILE = ".omp/agent/cnife-ask-consultants.json";

/** 插件用到的 omp ExtensionAPI 最小面（与 @earendil-works/pi-coding-agent 对齐）。 */
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
}

/** 解析个人覆盖配置：{"members": ["^provider/id", …]}；非数组视为无成员。 */
export function parseMembers(text: string): string[] {
	const config = JSON.parse(text) as { members?: unknown };
	return Array.isArray(config.members) ? config.members.map(String) : [];
}

export default function activate(pi: PiLike): void {
	pi.registerCommand("ask-consultants", {
		description: "用多模型顾问团评审：注册面板成员伪名并并行征询各成员的独立意见",
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
			// 个人覆盖文件：存在即生效（members 为空 = 明确清空面板，不派发）；
			// 仅 ENOENT 视为未配置，回退默认成员；读取失败警告后回退；
			// JSON 解析失败视为配置未完成，明确不派发——不能悄悄换成默认成员。
			let tags = DEFAULT_MEMBERS;
			let override: string | undefined;
			try {
				override = fs.readFileSync(path.join(os.homedir(), OVERRIDE_FILE), "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					process.stderr.write(`ask-consultants: 读取 ${OVERRIDE_FILE} 失败，回退默认成员。\n`);
				}
			}
			if (override !== undefined) {
				try {
					tags = parseMembers(override);
				} catch {
					process.stderr.write(`ask-consultants: ${OVERRIDE_FILE} 不是有效 JSON，本次不派发成员。请修复后再试。\n`);
					return;
				}
			}
			if (tags.length === 0) {
				process.stderr.write(`ask-consultants: ${OVERRIDE_FILE} 的 members 为空，本次不派发成员。\n`);
				return;
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
