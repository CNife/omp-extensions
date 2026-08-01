/**
 * simple-plannotator 三斜杠命令行为测试。
 *
 * 用 stub CLI（test/fixtures/plannotator，环境契约见 stub 头注释）替换真实
 * plannotator 二进制，验证：
 *   /pnr 参数构造与通知、/pna 路径归一化与空参、/pnl 临时文件生命周期、
 *   stdout 反馈 -> sendUserMessage(followUp)、无反馈 / CLI 报错 / 二进制缺失通知。
 * 断言文案与 extensions/index.ts 逐字一致。
 *
 * 运行：cd plugins/simple-plannotator && bun test
 *
 * 机制说明：Bun.spawn 不带 env 选项时使用进程启动时的环境快照（运行期改
 * process.env 对子进程不可见）。因此这里包装 Bun.spawn，注入当前 process.env，
 * 使逐测试的 PLANNO_STUB_* 与 PATH 前缀能送达子进程（扩展源码不改）。
 */

import { deepStrictEqual, equal, ok, strictEqual } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import simplePlannotator from "../extensions/index.ts";

// ── Bun.spawn 包装：注入当前 process.env（见文件头机制说明）──────────────
const realSpawn = Bun.spawn.bind(Bun);
Bun.spawn = ((cmd: string[], opts: Record<string, unknown> = {}) =>
	realSpawn(cmd, { ...opts, env: { ...process.env } })) as typeof Bun.spawn;

// ============================================================================
// Fixtures
// ============================================================================

function makePi() {
	return {
		commands: new Map(),
		sent: [] as { content: string; opts: unknown }[],
		registerCommand(name: string, opts: { description?: string; handler: (args: unknown, ctx: unknown) => void }) {
			this.commands.set(name, opts);
		},
		sendUserMessage(content: string, opts: unknown) {
			this.sent.push({ content, opts });
		},
	};
}

function makeCtx(
	cwd: string,
	entries: unknown[],
	notified: { msg: string; type: string }[],
) {
	return {
		cwd,
		ui: { notify: (msg: string, type: string) => notified.push({ msg, type }) },
		sessionManager: { getBranch: () => entries },
	};
}

/** 无 getBranch 时走 getEntries 兜底分支的 ctx */
function makeCtxNoBranch(
	cwd: string,
	entries: unknown[],
	notified: { msg: string; type: string }[],
) {
	return {
		cwd,
		ui: { notify: (msg: string, type: string) => notified.push({ msg, type }) },
		sessionManager: { getEntries: () => entries },
	};
}

function msg(role: string, content: unknown) {
	return { type: "message", message: { role, content } };
}

async function waitFor(
	fn: () => boolean | Promise<boolean>,
	timeoutMs = 3000,
	intervalMs = 25,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor 超时 (${timeoutMs}ms)`);
}

// bun 的 os.tmpdir() 每次重读 TMPDIR（不缓存），故所有 scratch 挂在同一个
// 扁平基目录下，避免上一个测试设置的 TMPDIR 导致 mkdtemp 嵌套。
let suiteBase: string;
function setupScratch() {
	suiteBase ??= mkdtempSync(join(tmpdir(), "pn-suite-"));
	const scratch = mkdtempSync(join(suiteBase, "t-"));
	const stubLog = join(scratch, "stub.log");
	process.env.TMPDIR = scratch;
	process.env.HOME = join(scratch, "home");
	Bun.env.HOME = process.env.HOME;
	// PATH 前缀让子进程（经包装注入的 env）解析到 fixtures 里的 stub。
	process.env.PATH = `${join(import.meta.dir, "fixtures")}:${process.env.PATH}`;
	process.env.PLANNO_STUB_LOG = stubLog;
	delete process.env.PLANNO_STUB_STDOUT;
	delete process.env.PLANNO_STUB_STDERR;
	delete process.env.PLANNO_STUB_EXIT;
	delete process.env.PLANNO_STUB_SLEEP;
	return { scratch, stubLog };
}

function lastFiles(dir: string) {
	return readdirSync(dir).filter((n) => /^plannotator-last-.*\.md$/.test(n));
}

function assertStubLog(log: string, ...fragments: string[]) {
	for (const f of fragments) ok(log.includes(f), `stub.log 应包含 ${f}`);
}

// ============================================================================
// 用例 1: 工厂注册
// ============================================================================

test("注册: 恰好 pnr/pna/pnl 三个命令，description 与源码一致", () => {
	const pi = makePi();
	simplePlannotator(pi);
	deepStrictEqual([...pi.commands.keys()], ["pnr", "pna", "pnl"]);
	strictEqual(
		pi.commands.get("pnr").description,
		"Open Plannotator code review for local git changes or a PR/MR URL",
	);
	strictEqual(
		pi.commands.get("pna").description,
		"Open Plannotator annotation UI for a markdown file, folder, or URL",
	);
	strictEqual(
		pi.commands.get("pnl").description,
		"Annotate the last assistant message in Plannotator",
	);
});

// ============================================================================
// 用例 2/3: /pnr
// ============================================================================

test("/pnr 无参: review + 无 URL 通知", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	pi.commands.get("pnr").handler(undefined, makeCtx(scratch, [], notified));

	await waitFor(() => existsSync(stubLog));
	const log = readFileSync(stubLog, "utf8");
	assertStubLog(log, `cwd=${scratch}`, "arg=review");
	ok(
		notified.some((n) => n.msg === "Opening code review in browser..." && n.type === "info"),
		"应发 info 通知",
	);
});

test("/pnr 带 URL: review + URL 参数", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	const url = "https://github.com/o/r/pull/1";
	pi.commands.get("pnr").handler(url, makeCtx(scratch, [], notified));

	await waitFor(() => existsSync(stubLog));
	const log = readFileSync(stubLog, "utf8");
	assertStubLog(log, "arg=review", `arg=${url}`);
	ok(
		notified.some((n) => n.msg === `Opening code review for ${url}...` && n.type === "info"),
		"应发带 URL 的 info 通知",
	);
});

// ============================================================================
// 用例 4/5/6: /pna
// ============================================================================

test("/pna: annotate + 目标通知", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	pi.commands.get("pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() => existsSync(stubLog));
	const log = readFileSync(stubLog, "utf8");
	assertStubLog(log, "arg=annotate", "arg=docs.md");
	ok(
		notified.some((n) => n.msg === "Opening annotation UI for docs.md..." && n.type === "info"),
		"应发 info 通知",
	);
});

test("/pna @a.md 归一化为 a.md", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	pi.commands.get("pna").handler("@a.md", makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), "arg=a.md");
});

test('/pna "b.md" 归一化为 b.md', async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	pi.commands.get("pna").handler('"b.md"', makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), "arg=b.md");
});

test("/pna 'c.md' 归一化为 c.md", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	pi.commands.get("pna").handler("'c.md'", makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), "arg=c.md");
});

test("/pna ~/d.md 展开为 HOME/d.md", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	pi.commands.get("pna").handler("~/d.md", makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), `arg=${join(process.env.HOME, "d.md")}`);
});

test("/pna ~ 展开为 HOME 本身", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	pi.commands.get("pna").handler("~", makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), `arg=${process.env.HOME}`);
});

test("/pna 空参: Usage 错误且不 spawn", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	pi.commands.get("pna").handler("", makeCtx(scratch, [], notified));
	await new Promise((r) => setTimeout(r, 150));

	equal(existsSync(stubLog), false, "不应 spawn CLI");
	ok(
		notified.some(
			(n) => n.msg === "Usage: /pna <file.md | folder/ | https://...>" && n.type === "error",
		),
		"应发 Usage 错误通知",
	);
});

// ============================================================================
// 用例 7/8/9: /pnl
// ============================================================================

test("/pnl: 临时文件生命周期 + annotate 绝对路径", async () => {
	const { scratch, stubLog } = setupScratch();
	process.env.PLANNO_STUB_SLEEP = "0.5"; // 拉长 stub 存活期，便于观察文件先存在后消失
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	const entries = [msg("assistant", [{ type: "text", text: "last reply" }])];
	pi.commands.get("pnl").handler(undefined, makeCtx(scratch, entries, notified));

	// 1) 临时文件先出现且内容恰为提取文本
	let tmpPath = "";
	await waitFor(() => {
		const files = lastFiles(scratch);
		if (files.length === 0) return false;
		tmpPath = join(scratch, files[0]);
		return readFileSync(tmpPath, "utf8") === "last reply";
	});
	// 2) stub 以绝对路径 annotate 该文件
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), "arg=annotate", `arg=${tmpPath}`);
	ok(
		notified.some((n) => n.msg === "Opening annotation UI for last message..." && n.type === "info"),
		"应发 info 通知",
	);
	// 3) stub 退出后文件被清理删除
	await waitFor(() => !existsSync(tmpPath));
	ok(!existsSync(tmpPath), "临时文件应被清理");
});

test("/pnl string content 直接写入", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_SLEEP = "0.3";
	const pi = makePi();
	simplePlannotator(pi);
	pi.commands.get("pnl").handler(undefined, makeCtx(scratch, [msg("assistant", "plain string")], []));
	await waitFor(() => lastFiles(scratch).length > 0);
	equal(readFileSync(join(scratch, lastFiles(scratch)[0]), "utf8"), "plain string");
});

test("/pnl 数组 content 按行拼接", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_SLEEP = "0.3";
	const pi = makePi();
	simplePlannotator(pi);
	pi.commands.get("pnl").handler(
		undefined,
		makeCtx(scratch, [msg("assistant", ["part1", "part2"])], []),
	);
	await waitFor(() => lastFiles(scratch).length > 0);
	equal(readFileSync(join(scratch, lastFiles(scratch)[0]), "utf8"), "part1\npart2");
});

test("/pnl 对象 {text} content", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_SLEEP = "0.3";
	const pi = makePi();
	simplePlannotator(pi);
	pi.commands.get("pnl").handler(
		undefined,
		makeCtx(scratch, [msg("assistant", { text: "obj text" })], []),
	);
	await waitFor(() => lastFiles(scratch).length > 0);
	equal(readFileSync(join(scratch, lastFiles(scratch)[0]), "utf8"), "obj text");
});

test("/pnl 跳过 user 与空 assistant，取最后非空", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_SLEEP = "0.3";
	const pi = makePi();
	simplePlannotator(pi);
	const entries = [msg("user", "hi"), msg("assistant", "  "), msg("assistant", "real")];
	pi.commands.get("pnl").handler(undefined, makeCtx(scratch, entries, []));
	await waitFor(() => lastFiles(scratch).length > 0);
	equal(readFileSync(join(scratch, lastFiles(scratch)[0]), "utf8"), "real");
});

test("/pnl 无 getBranch 时走 getEntries 兜底", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_SLEEP = "0.3";
	const pi = makePi();
	simplePlannotator(pi);
	const entries = [msg("user", "x"), msg("assistant", "from-fallback")];
	pi.commands.get("pnl").handler(undefined, makeCtxNoBranch(scratch, entries, []));
	await waitFor(() => lastFiles(scratch).length > 0);
	equal(readFileSync(join(scratch, lastFiles(scratch)[0]), "utf8"), "from-fallback");
});

test("/pnl 无 assistant 消息: 错误通知且无副作用", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	const entries = [msg("user", "only user")];
	pi.commands.get("pnl").handler(undefined, makeCtx(scratch, entries, notified));
	await new Promise((r) => setTimeout(r, 150));

	equal(existsSync(stubLog), false, "不应 spawn CLI");
	equal(lastFiles(scratch).length, 0, "不应产生临时文件");
	ok(
		notified.some((n) => n.msg === "No assistant message found in session." && n.type === "error"),
		"应发错误通知",
	);
});

// ============================================================================
// 用例 10/11/12/13: 反馈回路与失败路径
// ============================================================================

test("stdout 反馈 -> sendUserMessage(followUp)", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDOUT = "请修复 X";
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	pi.commands.get("pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() => pi.sent.length > 0);
	deepStrictEqual(pi.sent[0], { content: "请修复 X", opts: { deliverAs: "followUp" } });
	ok(!notified.some((n) => n.type === "error"), "不应有错误通知");
});

test("无反馈 -> closed (no feedback) 通知，不调 sendUserMessage", async () => {
	const { scratch } = setupScratch();
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	pi.commands.get("pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() => notified.some((n) => n.msg === "Annotation closed (no feedback)."));
	ok(
		notified.some((n) => n.msg === "Annotation closed (no feedback)." && n.type === "info"),
		"应为 info 通知",
	);
	equal(pi.sent.length, 0, "不应发用户消息");
});

test("CLI 报错: stderr 优先", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDERR = "boom";
	process.env.PLANNO_STUB_EXIT = "3";
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	pi.commands.get("pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() => notified.some((n) => n.msg === "Annotation failed: boom"));
	ok(
		notified.some((n) => n.msg === "Annotation failed: boom" && n.type === "error"),
		"应为 error 通知",
	);
	equal(pi.sent.length, 0, "不应发用户消息");
});

test("CLI 报错: stderr 为空时回退 exit code", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_EXIT = "3";
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	pi.commands.get("pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() => notified.some((n) => n.msg === "Annotation failed: exit code 3"));
});

test("二进制缺失 -> PATH 安装提示，不发用户消息", async () => {
	const { scratch } = setupScratch();
	const emptyBin = join(scratch, "nobin");
	mkdirSync(emptyBin);
	process.env.PATH = emptyBin; // 注入 env 的 PATH 指向空目录 -> spawn "not found"
	const pi = makePi();
	simplePlannotator(pi);
	const notified: { msg: string; type: string }[] = [];
	pi.commands.get("pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() =>
		notified.some((n) => n.type === "error" && n.msg.includes("plannotator not found on PATH")),
	);
	const errMsg = notified.find((n) => n.type === "error")!.msg;
	ok(errMsg.includes("curl -fsSL https://plannotator.ai/install.sh | bash"), "应含安装指引");
	equal(pi.sent.length, 0, "不应发用户消息");
});
