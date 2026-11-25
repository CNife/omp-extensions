/**
 * skills-injection - OMP extension
 *
 * 交互式控制哪些技能被注入到 omp 的系统提示词（<skills> 段），持久化配置。
 *
 * - /inject-skills 命令：ctx.ui.select 勾选列表切换 enabled/disabled，即时持久化
 * - before_agent_start：按配置过滤系统提示词 <skills> 段中被排除的技能
 * - session_start：英文通知本会话 injected / forbidden / non-injectable 技能
 *
 * 纯逻辑（parseConfig / filterSkillsSection / summarizeSkills / buildMenuItems / formatSkillLabel）
 * 在 ./skills-logic.ts，独立可测。本文件只做编排（event hooks、命令、配置 IO）。
 *
 * 配置：~/.omp/agent/cnife-skills-injection.json，{ "excluded": ["name", ...] }
 * 生效：下一条消息即生效（before_agent_start 每 turn 读配置），无需 reload
 *
 * 从 @cnife/pi-skills-injection 移植；适配 omp 的技能段格式与 API：
 *   - omp 技能段是 <skills> 块内 `- name: description` 行（非 pi 的 <available_skills>）
 *   - omp 把 disable-model-invocation 归一化为 Skill.hide，loadSkills 已含该标志
 *   - 改用 @oh-my-pi/* 作用域（omp 原生），pi/ctx 按 omp 约定用 any
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, loadSkills } from "@oh-my-pi/pi-coding-agent";
import {
	buildMenuItems,
	DEFAULT_CONFIG,
	filterSkillsSection,
	formatSkillLabel,
	formatStartupSummary,
	parseConfig,
	type SkillLike,
	type SkillsInjectionConfig,
	summarizeSkills,
} from "./skills-logic.ts";

// ──── Config IO ─────────────────────────────────────────────────

const CONFIG_PATH = join(getAgentDir(), "cnife-skills-injection.json");

function saveConfig(config: SkillsInjectionConfig): void {
	const dir = dirname(CONFIG_PATH);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function loadConfig(): SkillsInjectionConfig {
	// Level 1: 文件不存在 -> 默认配置
	if (!existsSync(CONFIG_PATH)) {
		return { ...DEFAULT_CONFIG };
	}
	// Level 2: 读取 + JSON 解析
	let raw: string;
	try {
		raw = readFileSync(CONFIG_PATH, "utf-8");
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.warn(
			"[skills-injection] Invalid JSON in config file, using defaults",
		);
		return { ...DEFAULT_CONFIG };
	}
	// Level 3: 类型校验（纯函数）
	return parseConfig(parsed);
}

// ──── Skills 解析 ───────────────────────────────────────────────

/**
 * 加载当前会话技能，返回 name + hide 标志。
 *
 * omp 的 loadSkills 已从 frontmatter 归一化 disable-model-invocation -> hide，
 * 无需像 pi 版那样再读文件 frontmatter 兜底。
 */
async function resolveSkills(cwd: string): Promise<SkillLike[]> {
	const { skills } = await loadSkills({ cwd });
	return skills.map((s) => ({ name: s.name, hide: s.hide === true }));
}

// ──── Entry Point ───────────────────────────────────────────────

export default function (pi: any) {
	// 启动时英文通知本会话技能注入分类
	pi.on("session_start", async (_event: any, ctx: any) => {
		if (!ctx.hasUI) return;

		const skills = await resolveSkills(ctx.cwd);
		if (skills.length === 0) return;

		const config = loadConfig();
		const summary = summarizeSkills(skills, new Set(config.excluded));
		ctx.ui.notify(formatStartupSummary(summary), "info");
	});

	// 拦截系统提示词，过滤被排除的技能
	pi.on("before_agent_start", async (event: any) => {
		const config = loadConfig();
		if (config.excluded.length === 0) return;

		const excluded = new Set(config.excluded);
		const parts = event.systemPrompt;
		// omp 的 systemPrompt 是 string[]；逐段过滤含 <skills> 块的部分
		if (!Array.isArray(parts)) return;

		let modified = false;
		const next = parts.map((part: unknown) => {
			if (typeof part !== "string") return part;
			const replaced = filterSkillsSection(part, excluded);
			if (replaced === null) return part;
			modified = true;
			return replaced;
		});
		if (!modified) return;

		return { systemPrompt: next };
	});

	// /inject-skills 命令：omp 19.2 起 pi-tui 的 SettingsList 已移除，改用它原生的
	// ctx.ui.select 勾选列表（selectionMarker: "checkbox"）：每次 Enter 关掉再按新状态
	// 重开，勾选即注入，切换即写配置。
	pi.registerCommand("inject-skills", {
		description: "Configure which skills inject into the system prompt",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) {
				ctx.ui?.notify(
					"inject-skills requires an interactive TUI",
					"warning",
				);
				return;
			}
			const ui = ctx.ui;
			if (ui === undefined || typeof ui.select !== "function") {
				process.stderr.write("inject-skills: requires omp 19.2+ (ctx.ui.select unavailable).\n");
				return;
			}

			// 菜单行：已加载的非 hide 技能 + 配置里登记但未加载的技能（not installed）
			const allSkills = await resolveSkills(ctx.cwd);
			const excluded = new Set(loadConfig().excluded);
			if (buildMenuItems(allSkills, excluded).length === 0) {
				ctx.ui.notify("No injectable skills available", "info");
				return;
			}

			// 重开时把光标放回刚切换的那一行（按技能名，行序会因策略重排）。
			let focus: string | undefined;
			for (;;) {
				const items = buildMenuItems(allSkills, excluded);
				const labels = items.map(formatSkillLabel);
				// 勾选 = 注入；Done 行不在 markableCount 内，Esc 返回 undefined。
				const checkedIndices = items.flatMap((it, i) =>
					excluded.has(it.name) ? [] : [i],
				);
				const picked = await ctx.ui.select(
					`Skills Injection — ${checkedIndices.length} of ${items.length} injected`,
					[...labels, "Done selecting"],
					{
						outline: true,
						initialIndex: Math.max(
							0,
							items.findIndex((it) => it.name === focus),
						),
						selectionMarker: "checkbox",
						checkedIndices,
						markableCount: items.length,
					},
				);
				const index = labels.indexOf(picked);
				if (index < 0) return; // Done selecting / Esc
				const item = items[index];
				if (excluded.has(item.name)) {
					excluded.delete(item.name);
				} else {
					excluded.add(item.name);
				}
				saveConfig({ excluded: [...excluded].sort() });
				focus = item.name;
			}
		},
	});
}
