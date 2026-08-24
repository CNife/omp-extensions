/**
 * skills-injection 的纯逻辑（零运行时 omp 依赖）。
 *
 * 适配 omp 与原 pi 版本的差异：
 * - omp 的系统提示词技能段是 `<skills>` 块内 `- name: description` 行
 *   （见 omp `prompts/system/system-prompt.md`），而非 pi 的 `<available_skills>` XML。
 * - omp 把 frontmatter `disable-model-invocation` 归一化为 `Skill.hide`，
 *   并在 `buildSystemPrompt` 里 `skills.filter(s => s.hide !== true)` 过滤后才渲染。
 *   故 `non-injectable` 类对应 `hide === true`。
 */

// ──── Config ────────────────────────────────────────────────────

export interface SkillsInjectionConfig {
	excluded: string[];
}

export const DEFAULT_CONFIG: SkillsInjectionConfig = { excluded: [] };

/**
 * 校验并解析配置 JSON。三层校验：对象 -> excluded 是数组 -> 元素是 string。
 * 任何不合法都回退默认配置。
 */
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

// ──── Skills 段过滤 ─────────────────────────────────────────────

// omp 渲染的技能段：<skills>\n- name: description\n</skills>
const SKILLS_BLOCK_RE = /<skills>\n([\s\S]*?)\n<\/skills>/;
// 技能段前导说明行（omp system-prompt.md 在 <skills> 块前固定输出此行）。
const SKILLS_LEAD_RE =
	/Skills are specialized knowledge\.[^\n]*\n<skills>[\s\S]*?<\/skills>\n?/;

/**
 * 从系统提示词的 `<skills>` 块中删除被排除技能的条目。
 *
 * - 命中且删完后仍有技能 -> 返回移除后的系统提示词
 * - 块内所有技能都被排除 -> 移除整个技能段（说明行 + `<skills>` 块）
 * - 无 `<skills>` 块 / 排除集合为空 / 无命中 -> `null`（不修改）
 *
 * 不需要技能对象本身：omp 的 `<skills>` 段已含技能名，按名匹配删除即可。
 */
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
		// 非技能行（空行等）保留；技能行按名过滤
		return !m || !excluded.has(m[1].trim());
	});

	// 无命中：没删任何技能行
	if (kept.length === lines.length) return null;

	if (kept.length === 0) {
		// 全部排除：优先连同前导说明行一起删；不紧邻时仅删 <skills> 块
		const withLead = systemPrompt.replace(SKILLS_LEAD_RE, "");
		if (withLead !== systemPrompt) return withLead;
		return systemPrompt.replace(SKILLS_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n");
	}

	// 部分删除：重渲染块
	const newBlock = `<skills>\n${kept.join("\n")}\n</skills>`;
	return systemPrompt.replace(SKILLS_BLOCK_RE, newBlock);
}

// ──── session_start 通知 ───────────────────────────────────────

export interface SkillLike {
	name: string;
	/** omp 归一化自 frontmatter `disable-model-invocation`；为真则不进系统提示词。 */
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

/**
 * 把技能分成三类：injected / forbidden / non-injectable。每类按名字母序。
 *
 * - `hide` 为真的技能本就不注入系统提示词，归 non-injectable
 *   （即使同时被 excluded 也仍归 non-injectable，排除它无意义）。
 * - 其余按配置分 injected / forbidden。
 */
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

/** 把一个分类格式化为一行：`label (count): names`，空类 names 位写 0。 */
function formatCategory(label: string, names: string[]): string {
	const value = names.length > 0 ? names.join(", ") : "0";
	return `${label} (${names.length}): ${value}`;
}

/** 英文启动说明：三类技能名 + 数量（多行一条 notify）。空类列表位写 0。 */
export function formatStartupSummary(summary: SkillsSummary): string {
	return [
		"Skills injection",
		formatCategory("injected", summary.injected),
		formatCategory("forbidden", summary.forbidden),
		formatCategory("non-injectable", summary.nonInjectable),
	].join("\n");
}

// ──── /inject-skills 命令排序 ───────────────────────────────────

export interface SkillItem {
	name: string;
}

/**
 * 按名字字母序排序。返回新数组，不修改原数组。
 */
export function sortSkillItems(items: SkillItem[]): SkillItem[] {
	return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
