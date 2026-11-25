export const SELECTOR_RE = /^[^\s/^]+(?:\/[^\s/^]+)+$/;

export const DEFAULT_MEMBERS = [
	"openai-codex/gpt-6-sol",
	"ark-coding-plan/glm-5.3-flash",
	"opencode-go/deepseek-v4.1-flash",
];

export function parseMembers(text: string): string[] {
	const config: unknown = JSON.parse(text);
	if (config === null || typeof config !== "object" || !("members" in config)) return [];
	const members: unknown = config.members;
	return Array.isArray(members) ? members.map(String) : [];
}

export function invalidMembers(members: readonly string[]): string[] {
	return members.filter((m) => !SELECTOR_RE.test(m));
}

export interface ModelLike {
	provider: string;
	id: string;
}

export interface ModelMenuItem {
	selector: string;
	label: string;
	enabled: boolean;
}

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
	return [...items.values()].sort((a, b) =>
		a.enabled === b.enabled ? a.label.localeCompare(b.label) : a.enabled ? -1 : 1,
	);
}

export function toggleSelected(
	selected: readonly string[],
	selector: string,
	on: boolean,
): string[] {
	return on
		? [...selected.filter((s) => s !== selector), selector]
		: selected.filter((s) => s !== selector);
}
