/**
 * 对 Model 形对象原地施加 Context cap。
 *
 * 正数 Context window 写成 min(原值, 256000)；
 * 若 maxTokens 非空，写成 min(原 maxTokens, 封顶后窗口)。
 */

export const CONTEXT_CAP = 256_000;

export interface ModelLike {
	contextWindow?: number | null;
	maxTokens?: number | null;
}

export function applyContextCap(models: Iterable<ModelLike>): void {
	for (const model of models) {
		const window = model.contextWindow;
		if (typeof window !== "number" || window <= 0) continue;
		const capped = Math.min(window, CONTEXT_CAP);
		model.contextWindow = capped;
		if (model.maxTokens != null) {
			model.maxTokens = Math.min(model.maxTokens, capped);
		}
	}
}
