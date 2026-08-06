/**
 * prune-context 纯逻辑测试（omp 工具集适配）。
 *
 * 覆盖裁剪规则矩阵：
 *   - toolCall 参数裁剪（write/edit/glob/全保留）
 *   - toolResult 裁剪矩阵（成功/失败 × 工具）
 *   - 死角色移除（bashExecution/custom/fileMention/developer）
 *   - 锚点编号完整性（glob 占位不破坏编号）
 *   - format 渲染（glob 无括号、toolResultKept、edit paths）
 *   - 真实 omp session 集成
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import {
	extractHashlinePaths,
	extractFiles,
	pruneMessages,
	pruneToolCallArgs,
	shouldKeepToolResult,
	type MessageLike,
} from "../extensions/prune.ts";
import { formatSummary } from "../extensions/format.ts";

// ============================================================================
// Fixtures / helpers
// ============================================================================

function userMsg(text: string): MessageLike {
	return { role: "user", content: text };
}

function assistantText(text: string): MessageLike {
	return { role: "assistant", content: [{ type: "text", text }] };
}

/** 构造 assistant 消息，含若干 toolCall part。 */
function assistantCalls(
	...calls: Array<{ name: string; arguments: Record<string, unknown> }>
): MessageLike {
	return {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", name: c.name, arguments: c.arguments })),
	};
}

function toolResult(toolName: string, content: string, isError = false): MessageLike {
	return { role: "toolResult", toolName, content, isError };
}

const HASHLINE_SINGLE = "[src/foo.ts#A1B2]\nPUT 1.=3:\n+new content";
const HASHLINE_MULTI =
	"[src/a.ts#A1B2]\nPUT 1.=1:\n+x\n[src/b.ts#C3D4]\nPUT 5.=7:\n+y";
const HASHLINE_DEDUPE =
	"[src/foo.ts#A1B2]\nPUT 1.=1:\n+x\n[src/foo.ts#C3D4]\nPUT 5.=5:\n+z";

// ============================================================================
// extractHashlinePaths
// ============================================================================

test("extractHashlinePaths: 单 section", () => {
	deepStrictEqual(extractHashlinePaths(HASHLINE_SINGLE), ["src/foo.ts"]);
});

test("extractHashlinePaths: 多 section 多文件", () => {
	deepStrictEqual(extractHashlinePaths(HASHLINE_MULTI), ["src/a.ts", "src/b.ts"]);
});

test("extractHashlinePaths: 同文件多 section 去重", () => {
	deepStrictEqual(extractHashlinePaths(HASHLINE_DEDUPE), ["src/foo.ts"]);
});

test("extractHashlinePaths: 无 header 返回空数组", () => {
	deepStrictEqual(extractHashlinePaths("*** Begin Patch\n+foo"), []);
	deepStrictEqual(extractHashlinePaths("just some text"), []);
});

test("extractHashlinePaths: 真实 omp hashline（REM 全删）", () => {
	deepStrictEqual(
		extractHashlinePaths("[plugins/thinking-fold/README.md#3764]\nREM"),
		["plugins/thinking-fold/README.md"],
	);
});

// ============================================================================
// pruneToolCallArgs
// ============================================================================

test("pruneToolCallArgs: write 普通文件裁 content 留 path+i", () => {
	deepStrictEqual(
		pruneToolCallArgs("write", { path: "f.txt", content: "big", i: "x" }),
		{ path: "f.txt", i: "x" },
	);
});

test("pruneToolCallArgs: write xd:// 全参数保留", () => {
	const args = { path: "xd://debug", content: '{"cmd":"run"}', i: "x" };
	deepStrictEqual(pruneToolCallArgs("write", args), args);
});

test("pruneToolCallArgs: edit hashline 裁 input 提取 paths", () => {
	deepStrictEqual(
		pruneToolCallArgs("edit", { input: HASHLINE_SINGLE, i: "x" }),
		{ paths: ["src/foo.ts"] },
	);
});

test("pruneToolCallArgs: edit hashline 多文件", () => {
	deepStrictEqual(
		pruneToolCallArgs("edit", { input: HASHLINE_MULTI, i: "x" }),
		{ paths: ["src/a.ts", "src/b.ts"] },
	);
});

test("pruneToolCallArgs: edit 非 hashline（replace 模式）全参数保留", () => {
	const args = { path: "f.ts", old_string: "a", new_string: "b", i: "x" };
	deepStrictEqual(pruneToolCallArgs("edit", args), args);
});

test("pruneToolCallArgs: edit input 但无 header（apply_patch）全参数保留", () => {
	const args = { input: "*** Begin Patch\n+foo\n*** End Patch", i: "x" };
	deepStrictEqual(pruneToolCallArgs("edit", args), args);
});

test("pruneToolCallArgs: glob 空参数占位", () => {
	deepStrictEqual(pruneToolCallArgs("glob", { path: "**/*.ts", i: "x" }), {});
});

test("pruneToolCallArgs: read 全参数保留", () => {
	const args = { path: "f.ts", i: "x" };
	deepStrictEqual(pruneToolCallArgs("read", args), args);
});

test("pruneToolCallArgs: bash 全参数保留", () => {
	const args = { command: "ls -la", i: "x" };
	deepStrictEqual(pruneToolCallArgs("bash", args), args);
});

test("pruneToolCallArgs: grep 全参数保留", () => {
	const args = { pattern: "foo", path: "src/", i: "x" };
	deepStrictEqual(pruneToolCallArgs("grep", args), args);
});

test("pruneToolCallArgs: ask 全参数保留", () => {
	const args = { i: "x", questions: [{ id: "q1", question: "h?", options: [] }] };
	deepStrictEqual(pruneToolCallArgs("ask", args), args);
});

test("pruneToolCallArgs: 低频工具（task）全参数保留", () => {
	const args = { prompt: "do something", i: "x" };
	deepStrictEqual(pruneToolCallArgs("task", args), args);
});

// ============================================================================
// shouldKeepToolResult
// ============================================================================

test("shouldKeepToolResult: read 成功裁失败留", () => {
	strictEqual(shouldKeepToolResult("read", false), false);
	strictEqual(shouldKeepToolResult("read", true), true);
});

test("shouldKeepToolResult: bash 成功裁失败留", () => {
	strictEqual(shouldKeepToolResult("bash", false), false);
	strictEqual(shouldKeepToolResult("bash", true), true);
});

test("shouldKeepToolResult: write 成功裁失败留", () => {
	strictEqual(shouldKeepToolResult("write", false), false);
	strictEqual(shouldKeepToolResult("write", true), true);
});

test("shouldKeepToolResult: edit 成功裁失败留", () => {
	strictEqual(shouldKeepToolResult("edit", false), false);
	strictEqual(shouldKeepToolResult("edit", true), true);
});

test("shouldKeepToolResult: grep 成功失败都裁", () => {
	strictEqual(shouldKeepToolResult("grep", false), false);
	strictEqual(shouldKeepToolResult("grep", true), false);
});

test("shouldKeepToolResult: glob 成功失败都裁", () => {
	strictEqual(shouldKeepToolResult("glob", false), false);
	strictEqual(shouldKeepToolResult("glob", true), false);
});

test("shouldKeepToolResult: ask 成功失败都留", () => {
	strictEqual(shouldKeepToolResult("ask", false), true);
	strictEqual(shouldKeepToolResult("ask", true), true);
});

test("shouldKeepToolResult: 低频工具（task/未知）全留", () => {
	strictEqual(shouldKeepToolResult("task", false), true);
	strictEqual(shouldKeepToolResult("task", true), true);
	strictEqual(shouldKeepToolResult("lsp", false), true);
	strictEqual(shouldKeepToolResult("lsp", true), true);
});

// ============================================================================
// pruneMessages: 死角色移除
// ============================================================================

test("pruneMessages: bashExecution 角色被跳过", () => {
	const msgs: MessageLike[] = [
		assistantText("hello"),
		// bashExecution 字段已从 MessageLike 移除；default 分支忽略所有字段
		{ role: "bashExecution" },
		assistantText("world"),
	];
	const entries = pruneMessages(msgs);
	strictEqual(entries.length, 2);
	strictEqual(entries[0].kind, "text");
	strictEqual(entries[1].kind, "text");
});

test("pruneMessages: custom 角色被跳过", () => {
	const msgs: MessageLike[] = [
		assistantText("hello"),
		{ role: "custom" },
		assistantText("world"),
	];
	const entries = pruneMessages(msgs);
	strictEqual(entries.length, 2);
});

test("pruneMessages: fileMention / developer 落入 default 被跳过", () => {
	const msgs: MessageLike[] = [
		{ role: "fileMention" },
		{ role: "developer" },
		assistantText("kept"),
	];
	const entries = pruneMessages(msgs);
	strictEqual(entries.length, 1);
	strictEqual(entries[0].kind, "text");
});

// ============================================================================
// pruneMessages: toolResult 裁剪矩阵
// ============================================================================

test("pruneMessages: read 成功裁失败留", () => {
	const msgs = [
		toolResult("read", "file content", false),
		toolResult("read", "error: not found", true),
	];
	const entries = pruneMessages(msgs);
	strictEqual(entries.length, 1);
	strictEqual(entries[0].kind, "toolResultKept");
	ok(entries[0].kind === "toolResultKept" && entries[0].isError === true);
});

test("pruneMessages: ask 成功失败都留", () => {
	const msgs = [
		toolResult("ask", "user answered", false),
		toolResult("ask", "user cancelled", true),
	];
	const entries = pruneMessages(msgs);
	strictEqual(entries.length, 2);
	ok(entries.every((e) => e.kind === "toolResultKept"));
});

test("pruneMessages: grep 成功失败都裁", () => {
	const msgs = [
		toolResult("grep", "match results", false),
		toolResult("grep", "error", true),
	];
	strictEqual(pruneMessages(msgs).length, 0);
});

test("pruneMessages: glob 成功失败都裁", () => {
	const msgs = [
		toolResult("glob", "file list", false),
		toolResult("glob", "error", true),
	];
	strictEqual(pruneMessages(msgs).length, 0);
});

test("pruneMessages: 低频工具（lsp）成功失败都留", () => {
	const msgs = [
		toolResult("lsp", "diagnostics", false),
		toolResult("lsp", "error", true),
	];
	const entries = pruneMessages(msgs);
	strictEqual(entries.length, 2);
});

// ============================================================================
// pruneMessages: toolCall 参数裁剪 + 锚点编号
// ============================================================================

test("pruneMessages: write 普通文件裁 content", () => {
	const msgs = [assistantCalls({ name: "write", arguments: { path: "f.txt", content: "big", i: "x" } })];
	const entries = pruneMessages(msgs, [5]);
	strictEqual(entries.length, 1);
	ok(entries[0].kind === "toolCall");
	ok(entries[0].kind === "toolCall" && !("content" in entries[0].args));
	ok(entries[0].kind === "toolCall" && entries[0].args.path === "f.txt");
});

test("pruneMessages: edit hashline 裁 input 留 paths", () => {
	const msgs = [assistantCalls({ name: "edit", arguments: { input: HASHLINE_SINGLE, i: "x" } })];
	const entries = pruneMessages(msgs);
	strictEqual(entries.length, 1);
	ok(entries[0].kind === "toolCall" && !("input" in entries[0].args));
	deepStrictEqual(
		entries[0].kind === "toolCall" ? entries[0].args : null,
		{ paths: ["src/foo.ts"] },
	);
});

test("pruneMessages: glob 占位保持锚点编号完整", () => {
	// 3 个 toolCall: read, glob, read -> 3 个 toolCall entry，锚点 #5.1 #5.2 #5.3
	const msgs = [
		assistantCalls(
			{ name: "read", arguments: { path: "a.ts", i: "x" } },
			{ name: "glob", arguments: { path: "**/*.ts", i: "x" } },
			{ name: "read", arguments: { path: "b.ts", i: "x" } },
		),
	];
	const entries = pruneMessages(msgs, [5]);
	strictEqual(entries.length, 3);
	ok(entries[0].kind === "toolCall" && entries[0].anchor === "#5.1");
	ok(entries[1].kind === "toolCall" && entries[1].anchor === "#5.2");
	ok(entries[2].kind === "toolCall" && entries[2].anchor === "#5.3");
	// glob 参数为空
	ok(entries[1].kind === "toolCall" && Object.keys(entries[1].args).length === 0);
	// read 参数保留
	ok(entries[0].kind === "toolCall" && entries[0].args.path === "a.ts");
});

test("pruneMessages: 单 toolCall 锚点省略 .1", () => {
	const msgs = [assistantCalls({ name: "read", arguments: { path: "a.ts", i: "x" } })];
	const entries = pruneMessages(msgs, [5]);
	strictEqual(entries.length, 1);
	ok(entries[0].kind === "toolCall" && entries[0].anchor === "#5");
});

// ============================================================================
// formatSummary 渲染
// ============================================================================

test("formatSummary: glob 占位无括号", () => {
	const entries = pruneMessages(
		[assistantCalls({ name: "glob", arguments: { path: "**/*.ts", i: "x" } })],
		[5],
	);
	const summary = formatSummary(entries, 1);
	ok(summary.includes("- glob #5"), `expected glob placeholder, got:\n${summary}`);
	ok(!summary.includes("glob("), `glob should have no parens, got:\n${summary}`);
});

test("formatSummary: toolResultKept error 标注", () => {
	const entries = pruneMessages([toolResult("read", "not found", true)]);
	const summary = formatSummary(entries, 1);
	ok(summary.includes("**toolResult** (read, error):"), `got:\n${summary}`);
});

test("formatSummary: toolResultKept ok 标注", () => {
	const entries = pruneMessages([toolResult("ask", "user said yes", false)]);
	const summary = formatSummary(entries, 1);
	ok(summary.includes("**toolResult** (ask, ok):"), `got:\n${summary}`);
});

test("formatSummary: edit hashline 显示 paths", () => {
	const entries = pruneMessages([
		assistantCalls({ name: "edit", arguments: { input: HASHLINE_MULTI, i: "x" } }),
	]);
	const summary = formatSummary(entries, 1);
	ok(summary.includes('edit({"paths":["src/a.ts","src/b.ts"]}'), `got:\n${summary}`);
});

test("formatSummary: 普通 toolCall 带参数渲染", () => {
	const entries = pruneMessages([
		assistantCalls({ name: "read", arguments: { path: "f.ts", i: "x" } }),
	]);
	const summary = formatSummary(entries, 1, ["f.ts"]);
	ok(summary.includes("Files: f.ts"), `got:\n${summary}`);
	ok(summary.includes("- read("), `got:\n${summary}`);
});

test("formatSummary: header 统计行", () => {
	const summary = formatSummary([], 42, []);
	ok(summary.startsWith("Pruned 42 messages."), `got:\n${summary}`);
});

// ============================================================================
// extractFiles
// ============================================================================

test("extractFiles: 从 write/read 的 path 派生", () => {
	const msgs = [
		assistantCalls(
			{ name: "write", arguments: { path: "a.txt", content: "x", i: "x" } },
			{ name: "read", arguments: { path: "b.ts", i: "x" } },
		),
	];
	deepStrictEqual(extractFiles(msgs), ["a.txt", "b.ts"]);
});

test("extractFiles: 去重 + 保序", () => {
	const msgs = [
		assistantCalls(
			{ name: "read", arguments: { path: "a.txt", i: "x" } },
			{ name: "read", arguments: { path: "a.txt", i: "x" } },
			{ name: "read", arguments: { path: "b.ts", i: "x" } },
		),
	];
	deepStrictEqual(extractFiles(msgs), ["a.txt", "b.ts"]);
});

// ============================================================================
// 真实 omp session 集成测试
// ============================================================================

const SESSION_FILE =
	"/home/cnife/.omp/agent/sessions/-code-omp-extensions/2026-08-05T13-35-02-501Z_019fd222-7965-7000-8e85-482a80dcdee1.jsonl";

test("integration: 真实 omp session 裁剪（hashline edit + glob + grep + ask + bash）", { skip: !existsSync(SESSION_FILE) ? "环境相关：真实 session 文件不存在" : false }, () => {
	const lines = readFileSync(SESSION_FILE, "utf-8").split("\n").filter((l) => l.trim());
	const messages: MessageLike[] = [];
	for (const line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "message" && entry.message) {
			messages.push(entry.message as MessageLike);
		}
	}
	ok(messages.length > 50, `expected substantial session, got ${messages.length} messages`);

	const entries = pruneMessages(messages);
	const summary = formatSummary(entries, messages.length, extractFiles(messages));

	// 不含 bashExecution / custom 渲染产物
	ok(!summary.includes("**bash**:"), `should not render bashExecution, got bashSuccess in:\n${summary.slice(0, 200)}`);

	// edit hashline 的 input 不泄露到 summary
	ok(!summary.includes("PUT "), `hashline input body should be pruned, got PUT in summary`);

	// glob 占位无括号
	const globLines = summary.split("\n").filter((l) => l.startsWith("- glob"));
	for (const gl of globLines) {
		ok(!gl.includes("glob("), `glob should have no parens: ${gl}`);
	}

	// 至少有一个 edit toolCall 显示 paths
	const editLines = summary.split("\n").filter((l) => l.startsWith("- edit("));
	ok(editLines.length > 0, `expected edit toolCalls with paths, got none`);
	for (const el of editLines) {
		ok(el.includes('"paths"'), `edit should show paths: ${el}`);
	}

	// summary 非空且有 header
	ok(summary.startsWith("Pruned "), `expected header, got: ${summary.slice(0, 60)}`);
});

const SESSION_FILE_2 =
	"/home/cnife/.omp/agent/sessions/-code-omp-extensions/2026-08-01T13-37-40-664Z_019fbd8b-7338-7000-b11d-df618701ecb8.jsonl";

test("integration: 真实 omp session 裁剪（replace-batch edit + 六种工具）", { skip: !existsSync(SESSION_FILE_2) ? "环境相关：真实 session 文件不存在" : false }, () => {
	const lines = readFileSync(SESSION_FILE_2, "utf-8").split("\n").filter((l) => l.trim());
	const messages: MessageLike[] = [];
	for (const line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "message" && entry.message) {
			messages.push(entry.message as MessageLike);
		}
	}
	ok(messages.length > 100, `expected substantial session, got ${messages.length} messages`);

	const entries = pruneMessages(messages);
	const summary = formatSummary(entries, messages.length, extractFiles(messages));

	// replace-batch edit（无 input 字段）应保留全参数（含 edits/old_text/new_text）
	const editLines = summary.split("\n").filter((l) => l.startsWith("- edit("));
	ok(editLines.length > 0, `expected edit toolCalls, got none`);
	for (const el of editLines) {
		// 非 hashline 模式不裁剪，应保留原始参数键
		ok(!el.includes('"paths"'), `replace-batch edit should keep original args, not extract paths: ${el}`);
	}

	// 不含 bashExecution 渲染产物（**bash**: 格式）
	ok(!summary.includes("**bash**:"), `should not render bashExecution`);

	// summary 非空且有 header
	ok(summary.startsWith("Pruned "), `expected header, got: ${summary.slice(0, 60)}`);
});
