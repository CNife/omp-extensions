/**
 * ask-consultants 纯逻辑（零运行时 omp 依赖），独立可测。
 *
 * 成员清单格式：裸 `provider/id` selector（0.2.0 起去掉 `^` 前缀）。
 * `^` 只在 /ask-consultants 组装用户消息时拼接，配置与 /consultants
 * 的读写一律用裸格式——伪名注册按 `provider/id` 精确匹配 selector，
 * effort 后缀（如 `:high`）从来不属于 selector，不因去 `^` 而引入。
 */

/** 裸 selector：`provider/id`，id 可含 `/`（如 openrouter 的 `~anthropic/claude-fable-latest`）；各段非空，无空白、无 `^`。 */
export const SELECTOR_RE = /^[^\s/^]+(?:\/[^\s/^]+)+$/;

export const DEFAULT_MEMBERS = [
	"openai-codex/gpt-6-sol",
	"ark-coding-plan/glm-5.3-flash",
	"opencode-go/deepseek-v4.1-flash",
];

/** 解析配置 JSON：{"members": ["provider/id", …]}；null/标量/非数组 members 均视为无成员。 */
export function parseMembers(text: string): string[] {
	const config: unknown = JSON.parse(text);
	if (config === null || typeof config !== "object" || !("members" in config)) return [];
	const members: unknown = config.members;
	return Array.isArray(members) ? members.map(String) : [];
}

/** 返回不符合裸 selector 格式的成员（含 0.1.x 的 `^` 前缀旧格式）。 */
export function invalidMembers(members: readonly string[]): string[] {
	return members.filter((m) => !SELECTOR_RE.test(m));
}

/** 选择器候选的最小模型面（omp ModelRegistry.getAvailable 的元素子集）。 */
export interface ModelLike {
	provider: string;
	id: string;
}

export interface ModelMenuItem {
	/** 裸 selector，toggle 直接读写它。 */
	selector: string;
	/** 菜单行文本；当前会话不可用的登记项加后缀。 */
	label: string;
	enabled: boolean;
}

/**
 * 构建菜单行：当前可用模型 ∪ 配置里登记但当前不可用的 selector（字母序混排）。
 * 后者必须保留在菜单里，否则 toggle 任一行整体保存时会把它悄悄丢掉。
 */
export function buildModelMenuItems(
	models: readonly ModelLike[],
	selected: readonly string[],
): ModelMenuItem[] {
	const selectedSet = new Set(selected);
	const items = new Map<string, ModelMenuItem>();
	for (const model of models) {
		const selector = `${model.provider}/${model.id}`;
		items.set(selector, {
			selector,
			label: selector,
			enabled: selectedSet.has(selector),
		});
	}
	for (const selector of selected) {
		if (!items.has(selector)) {
			items.set(selector, { selector, label: `${selector} (not available)`, enabled: true });
		}
	}
	return [...items.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** toggle 一个 selector：on 追加到尾部，off 移除；返回新数组（入参不变）。 */
export function toggleSelected(
	selected: readonly string[],
	selector: string,
	on: boolean,
): string[] {
	return on
		? [...selected.filter((s) => s !== selector), selector]
		: selected.filter((s) => s !== selector);
}
