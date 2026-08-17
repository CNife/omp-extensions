// @ts-nocheck
/**
 * context-cap — 进程内每个 Available model 的 Context window 封顶 200K。
 *
 * 安装即生效，静默，不可配置。session_start 时对注册表 getAll() 与当前
 * 会话模型原地施加 Context cap，并包装会重建目录的公开入口，盖住刷新、
 * 登录、其他扩展后才出现的模型。
 */

import { applyContextCap } from "./cap.ts";

const WRAPPED = Symbol.for("omp-extensions.context-cap.wrapped");

const REBUILD_METHODS = [
	"refresh",
	"refreshProvider",
	"refreshRuntimeProviders",
	"refreshSelectedModelMetadata",
	"registerProvider",
	"unregisterProvider",
	"clearSourceRegistrations",
];

function applyRegistry(registry: any): void {
	const models = registry?.getAll?.();
	if (models != null && typeof models[Symbol.iterator] === "function") {
		applyContextCap(models);
	}
}

function wrapRebuildEntries(registry: any): void {
	if (!registry || registry[WRAPPED]) return;
	registry[WRAPPED] = true;

	for (const name of REBUILD_METHODS) {
		const original = registry[name];
		if (typeof original !== "function") continue;
		registry[name] = function (...args: unknown[]) {
			const result = original.apply(this, args);
			if (result != null && typeof result.then === "function") {
				return result.then((value: unknown) => {
					applyRegistry(registry);
					return value;
				});
			}
			applyRegistry(registry);
			return result;
		};
	}
}

export default function (pi: any) {
	pi.on("session_start", (_event: any, ctx: any) => {
		const registry = ctx.modelRegistry;
		wrapRebuildEntries(registry);
		applyRegistry(registry);
		if (ctx.model) applyContextCap([ctx.model]);
	});
}
