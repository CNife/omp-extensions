export interface SkillsInjectionConfig {
	excluded: string[];
}

export const DEFAULT_CONFIG: SkillsInjectionConfig = { excluded: [] };

export function parseConfig(parsed: unknown): SkillsInjectionConfig {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ...DEFAULT_CONFIG };
	}
	if (!("excluded" in parsed)) {
		return { ...DEFAULT_CONFIG };
	}
	const excluded = parsed.excluded;
	if (!Array.isArray(excluded)) {
		return { ...DEFAULT_CONFIG };
	}
	return {
		excluded: excluded.filter((s): s is string => typeof s === "string"),
	};
}

const SKILLS_BLOCK_RE = /<skills>\n([\s\S]*?)\n<\/skills>/;
const SKILLS_LEAD_RE =
	/Skills are specialized knowledge\.[^\n]*\n<skills>[\s\S]*?<\/skills>\n?/;

export function filterSkillsSection(
	systemPrompt: string,
	excluded: ReadonlySet<string>,
): string | null {
	if (excluded.size === 0) return null;

	const match = systemPrompt.match(SKILLS_BLOCK_RE);
	if (!match) return null;

	const lines = match[1].split("\n");
	const kept = lines.filter((line) => {
		const m = line.match(/^\s*-\s+([^:]+):/);
		return !m || !excluded.has(m[1].trim());
	});

	if (kept.length === lines.length) return null;

	if (kept.length === 0) {
		const withLead = systemPrompt.replace(SKILLS_LEAD_RE, "");
		if (withLead !== systemPrompt) return withLead;
		return systemPrompt.replace(SKILLS_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n");
	}

	const newBlock = `<skills>\n${kept.join("\n")}\n</skills>`;
	return systemPrompt.replace(SKILLS_BLOCK_RE, newBlock);
}

export interface SkillLike {
	name: string;
	hide?: boolean;
}

export interface SkillsSummary {
	injected: string[];
	forbidden: string[];
	nonInjectable: string[];
}

function sortedNames(names: string[]): string[] {
	return [...names].sort((a, b) => a.localeCompare(b));
}

export function summarizeSkills(
	skills: readonly SkillLike[],
	excluded: ReadonlySet<string>,
): SkillsSummary {
	const injected: string[] = [];
	const forbidden: string[] = [];
	const nonInjectable: string[] = [];
	for (const s of skills) {
		if (s.hide) {
			nonInjectable.push(s.name);
		} else if (excluded.has(s.name)) {
			forbidden.push(s.name);
		} else {
			injected.push(s.name);
		}
	}
	return {
		injected: sortedNames(injected),
		forbidden: sortedNames(forbidden),
		nonInjectable: sortedNames(nonInjectable),
	};
}

function formatCategory(label: string, names: string[]): string {
	const value = names.length > 0 ? names.join(", ") : "0";
	return `${label} (${names.length}): ${value}`;
}

export function formatStartupSummary(summary: SkillsSummary): string {
	return [
		"Skills injection",
		formatCategory("injected", summary.injected),
		formatCategory("forbidden", summary.forbidden),
		formatCategory("non-injectable", summary.nonInjectable),
	].join("\n");
}

export interface SkillItem {
	name: string;
	notInstalled: boolean;
}

export function formatSkillLabel(item: SkillItem): string {
	return item.notInstalled ? `${item.name} (not installed)` : item.name;
}

export function buildMenuItems(
	skills: readonly SkillLike[],
	excluded: ReadonlySet<string>,
): SkillItem[] {
	const installed = new Set<string>();
	const items: SkillItem[] = [];
	for (const s of skills) {
		installed.add(s.name);
		if (!s.hide) items.push({ name: s.name, notInstalled: false });
	}
	for (const name of excluded) {
		if (!installed.has(name)) items.push({ name, notInstalled: true });
	}
	return items.sort((a, b) => a.name.localeCompare(b.name));
}
