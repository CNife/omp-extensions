import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import nmem from "../extensions/nmem.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function registeredHandlers(): Record<string, Handler | undefined> {
	const handlers: Record<string, Handler | undefined> = {};
	nmem({
		on: (name: string, handler: Handler) => {
			handlers[name] = handler;
		},
	});
	return handlers;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function systemPromptOf(result: unknown): string[] {
	if (result === null || typeof result !== "object" || !("systemPrompt" in result)) {
		throw new Error(`handler 未返回 systemPrompt：${JSON.stringify(result)}`);
	}
	const { systemPrompt } = result;
	if (!isStringArray(systemPrompt)) {
		throw new Error(`systemPrompt 应是 string[] 段数组，实际：${JSON.stringify(systemPrompt)}`);
	}
	return systemPrompt;
}

test("before_agent_start: NMEM_GUIDANCE=1 时 guidance 追加为独立段，原段原样保留", async () => {
	process.env.NMEM_GUIDANCE = "1";
	try {
		const handler = registeredHandlers().before_agent_start;
		ok(handler, "NMEM_GUIDANCE=1 时应注册 before_agent_start");
		const expected = [
			"<critical>\nTool results are verification.\n</critical>",
			"<project-context>\ncwd: /tmp/demo\n</project-context>",
		];
		const input = [...expected];
		const result = await handler({ type: "before_agent_start", prompt: "hi", systemPrompt: input }, {});

		const systemPrompt = systemPromptOf(result);
		deepStrictEqual(systemPrompt.slice(0, expected.length), expected);
		deepStrictEqual(input, expected, "handler 不该原地改写传入的 systemPrompt");
		strictEqual(systemPrompt.length, expected.length + 1);
		const guidance = systemPrompt.at(-1) ?? "";
		ok(guidance.includes("## Nowledge Mem"), `末段应是 guidance，实际：${guidance}`);
		ok(
			!guidance.includes("<critical>") && !guidance.includes("<project-context>"),
			`guidance 段里不该出现旧段内容：${guidance}`,
		);
	} finally {
		delete process.env.NMEM_GUIDANCE;
	}
});

test("before_agent_start: 未设置 NMEM_GUIDANCE 时不注入", () => {
	delete process.env.NMEM_GUIDANCE;
	strictEqual(registeredHandlers().before_agent_start, undefined);
});

test("before_agent_start: NMEM_GUIDANCE 非 1（0 / 空串 / 空白）时不注入", () => {
	for (const value of ["0", "", " "]) {
		process.env.NMEM_GUIDANCE = value;
		try {
			strictEqual(
				registeredHandlers().before_agent_start,
				undefined,
				`NMEM_GUIDANCE=${JSON.stringify(value)}`,
			);
		} finally {
			delete process.env.NMEM_GUIDANCE;
		}
	}
});
