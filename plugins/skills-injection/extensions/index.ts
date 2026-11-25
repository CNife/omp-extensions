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

const CONFIG_PATH = join(getAgentDir(), "cnife-skills-injection.json");

function saveConfig(config: SkillsInjectionConfig): void {
	const dir = dirname(CONFIG_PATH);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function loadConfig(): SkillsInjectionConfig {
	if (!existsSync(CONFIG_PATH)) {
		return { ...DEFAULT_CONFIG };
	}
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
	return parseConfig(parsed);
}

async function resolveSkills(cwd: string): Promise<SkillLike[]> {
	const { skills } = await loadSkills({ cwd });
	return skills.map((s) => ({ name: s.name, hide: s.hide === true }));
}

export default function (pi: any) {
	pi.on("session_start", async (_event: any, ctx: any) => {
		if (!ctx.hasUI) return;

		const skills = await resolveSkills(ctx.cwd);
		if (skills.length === 0) return;

		const config = loadConfig();
		const summary = summarizeSkills(skills, new Set(config.excluded));
		ctx.ui.notify(formatStartupSummary(summary), "info");
	});

	pi.on("before_agent_start", async (event: any) => {
		const config = loadConfig();
		if (config.excluded.length === 0) return;

		const excluded = new Set(config.excluded);
		const parts = event.systemPrompt;
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

			const allSkills = await resolveSkills(ctx.cwd);
			const excluded = new Set(loadConfig().excluded);
			if (buildMenuItems(allSkills, excluded).length === 0) {
				ctx.ui.notify("No injectable skills available", "info");
				return;
			}

			let focus: string | undefined;
			for (;;) {
				const items = buildMenuItems(allSkills, excluded);
				const labels = items.map(formatSkillLabel);
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
				if (index < 0) return;
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
