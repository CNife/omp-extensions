/**
 * plannotator-cli 三斜杠命令行为测试。
 *
 * 用 stub CLI（test/fixtures/plannotator，环境契约见 stub 头注释）替换真实
 * plannotator 二进制，验证：
 *   /pnr 参数构造与通知、/pna 路径归一化与空参、/pnl 消息选择器与 annotate-last --stdin 内容、
 *   spawn 环境强制项（BROWSER=none PLANNOTATOR_BROWSER=none PLANNOTATOR_AI=disabled）、
 *   stdout 反馈 -> sendUserMessage 直接发送（无 deliverAs）、json 完整即投递（不等 exited）、
 *   超时兜底、无反馈 / CLI 报错通知。
 * 断言文案与 extensions/index.ts 逐字一致。
 *
 * 运行：cd plugins/plannotator-cli && bun test
 *
 * 机制说明：Bun.spawn 不带 env 选项时使用进程启动时的环境快照（运行期改
 * process.env 对子进程不可见）。因此这里包装 Bun.spawn，合并注入当前 process.env
 * 与插件显式 env，使逐测试的 PLANNO_STUB_* 与 PATH 前缀能送达子进程（扩展源码不改）。
 */

import { deepStrictEqual, equal, ok, strictEqual } from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import plannotatorCli, { resolveFeedbackTimeoutMs, type CommandCtx, type PiLike } from "../extensions/index.ts";

// ── Bun.spawn 包装：合并当前 process.env 与插件显式 env ──────────────────
const realSpawn = Bun.spawn.bind(Bun);
Bun.spawn = ((cmd: string[], opts: Record<string, unknown> = {}) =>
	realSpawn(cmd, {
		...opts,
		env: { ...process.env, ...(opts.env as Record<string, string> | undefined) },
	})) as typeof Bun.spawn;

// ============================================================================
// Fixtures
// ============================================================================

interface TestPi extends PiLike {
	commands: Map<
		string,
		{ description: string; handler: (args: string | undefined, ctx: CommandCtx) => void }
	>;
	sent: { content: string; opts: unknown }[];
}

function makePi(): TestPi {
	const commands = new Map<
		string,
		{ description: string; handler: (args: string | undefined, ctx: CommandCtx) => void }
	>();
	const sent: { content: string; opts: unknown }[] = [];
	return {
		commands,
		sent,
		registerCommand(name, opts) {
			commands.set(name, opts);
		},
		sendUserMessage(content, opts) {
			sent.push({ content, opts });
		},
	};
}

type Notice = { msg: string; type: "info" | "error" };

/** 选择器调用记录与回传值控制（/pnl 消息选择器的接缝）。 */
interface SelectCall {
	title: string;
	options: { label: string; description?: string }[];
	dialogOptions: { initialIndex?: number } | undefined;
}

interface Ui {
	hasUI: boolean;
	selects: SelectCall[];
	/** 回传被选中项的 label；默认选第一项（= 回车，即最新一条）。 */
	pick: (call: SelectCall) => string | undefined;
}

function makeUi(hasUI = true): Ui {
	return {
		hasUI,
		selects: [],
		pick: (call) => call.options[0]?.label,
	};
}

/** 取注册的命令，未注册即测试错误（Map.get 可空，此处为 fixture 内不变量）。 */
function command(pi: TestPi, name: string) {
	const cmd = pi.commands.get(name);
	if (!cmd) throw new Error(`command not registered: ${name}`);
	return cmd;
}

function makeCtx(
	cwd: string,
	entries: unknown[],
	notified: Notice[],
	ui: Ui = makeUi(),
): CommandCtx {
	return {
		cwd,
		hasUI: ui.hasUI,
		ui: {
			notify: (msg: string, type: "info" | "error") => notified.push({ msg, type }),
			select: async (title, options, dialogOptions) => {
				const call: SelectCall = { title, options, dialogOptions };
				ui.selects.push(call);
				return ui.pick(call);
			},
		},
		sessionManager: { getBranch: () => entries },
	};
}

/** 无 getBranch 时走 getEntries 兜底分支的 ctx */
function makeCtxNoBranch(
	cwd: string,
	entries: unknown[],
	notified: Notice[],
): CommandCtx {
	return {
		cwd,
		hasUI: true,
		ui: {
			notify: (msg: string, type: "info" | "error") => notified.push({ msg, type }),
			select: async () => undefined,
		},
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
		// 轮询真实时钟：等待的是子进程副作用（stub 日志/文件/投递），
		// 进程在真实时间运行，无法用 fake timer 驱动。
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, intervalMs);
		await promise;
	}
	throw new Error(`waitFor 超时 (${timeoutMs}ms)`);
}

/** 负向断言窗口：等待一段真实时间，证明"未发生"（无副作用断言）。 */
async function expectNothingHappens(ms = 150) {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	await promise;
}

// bun 的 os.tmpdir() 每次重读 TMPDIR（不缓存），故所有 scratch 挂在同一个
// 扁平基目录下，避免上一个测试设置的 TMPDIR 导致 mkdtemp 嵌套。
let suiteBase: string;
function setupScratch() {
	suiteBase ??= mkdtempSync(join(tmpdir(), "pncli-suite-"));
	const scratch = mkdtempSync(join(suiteBase, "t-"));
	const stubLog = join(scratch, "stub.log");
	process.env.TMPDIR = scratch;
	process.env.HOME = join(scratch, "home");
	Bun.env.HOME = process.env.HOME;
	// PATH 前缀让子进程（经包装注入的 env）解析到 fixtures 里的 stub。
	process.env.PATH = `${join(import.meta.dir, "fixtures")}:${process.env.PATH}`;
	process.env.PLANNO_STUB_LOG = stubLog;
	delete process.env.PLANNO_STUB_STDIN_FILE;
	delete process.env.PLANNO_STUB_STDOUT;
	delete process.env.PLANNO_STUB_STDERR;
	delete process.env.PLANNO_STUB_EXIT;
	delete process.env.PLANNO_STUB_SLEEP;
	delete process.env.PLANNO_STUB_HANG;
	delete process.env.PLANNOTATOR_FEEDBACK_TIMEOUT_MS;
	delete process.env.PLANNOTATOR_AI;
	return { scratch, stubLog };
}

function stdinFile(scratch: string) {
	return join(scratch, "stdin.txt");
}

function assertStubLog(log: string, ...fragments: string[]) {
	for (const f of fragments) ok(log.includes(f), `stub.log 应包含 ${f}`);
}

// ============================================================================
// 用例 1: 工厂注册
// ============================================================================

test("注册: 恰好 pnr/pna/pnl 三个命令，description 与源码一致", () => {
	const pi = makePi();
	plannotatorCli(pi);
	deepStrictEqual([...pi.commands.keys()], ["pnr", "pna", "pnl"]);
	strictEqual(
		command(pi, "pnr").description,
		"Open Plannotator code review for local git changes or a PR/MR URL",
	);
	strictEqual(
		command(pi, "pna").description,
		"Open Plannotator annotation UI for a markdown file, folder, or URL",
	);
	strictEqual(
		command(pi, "pnl").description,
		"Annotate a recent assistant message in Plannotator",
	);
});

// ============================================================================
// 用例 2/3: /pnr
// ============================================================================

test("/pnr 无参: review + 无 URL 通知 + spawn env 强制项", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	command(pi, "pnr").handler(undefined, makeCtx(scratch, [], notified));

	await waitFor(() => existsSync(stubLog));
	const log = readFileSync(stubLog, "utf8");
	assertStubLog(log, `cwd=${scratch}`, "arg=review");
	// #44 研究强制项：抑制浏览器启动路径 + 默认禁用 AI 探针
	assertStubLog(log, "env BROWSER=none", "env PLANNOTATOR_BROWSER=none", "env PLANNOTATOR_AI=disabled");
	ok(
		notified.some((n) => n.msg === "Opening code review in browser..." && n.type === "info"),
		"应发 info 通知",
	);
});

test("/pnr 带 URL: review + URL 参数", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	const url = "https://github.com/o/r/pull/1";
	command(pi, "pnr").handler(url, makeCtx(scratch, [], notified));

	await waitFor(() => existsSync(stubLog));
	const log = readFileSync(stubLog, "utf8");
	assertStubLog(log, "arg=review", `arg=${url}`);
	ok(
		notified.some((n) => n.msg === `Opening code review for ${url}...` && n.type === "info"),
		"应发带 URL 的 info 通知",
	);
});

// ============================================================================
// 用例 4-9: /pna
// ============================================================================

test("/pna: annotate + --json + 目标通知", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	command(pi, "pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() => existsSync(stubLog));
	const log = readFileSync(stubLog, "utf8");
	assertStubLog(log, "arg=annotate", "arg=docs.md", "arg=--json");
	ok(
		notified.some((n) => n.msg === "Opening annotation UI for docs.md..." && n.type === "info"),
		"应发 info 通知",
	);
});

test("/pna @a.md 归一化为 a.md", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	plannotatorCli(pi);
	command(pi, "pna").handler("@a.md", makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), "arg=a.md");
});

test('/pna "b.md" 归一化为 b.md', async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	plannotatorCli(pi);
	command(pi, "pna").handler('"b.md"', makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), "arg=b.md");
});

test("/pna 'c.md' 归一化为 c.md", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	plannotatorCli(pi);
	command(pi, "pna").handler("'c.md'", makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), "arg=c.md");
});

test("/pna ~/d.md 展开为 HOME/d.md", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	plannotatorCli(pi);
	command(pi, "pna").handler("~/d.md", makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), `arg=${join(process.env.HOME!, "d.md")}`);
});

test("/pna ~ 展开为 HOME 本身", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	plannotatorCli(pi);
	command(pi, "pna").handler("~", makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), `arg=${process.env.HOME!}`);
});

test("/pna 空参: Usage 错误且不 spawn", async () => {
	const { scratch, stubLog } = setupScratch();
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	command(pi, "pna").handler("", makeCtx(scratch, [], notified));
	await expectNothingHappens();

	equal(existsSync(stubLog), false, "不应 spawn CLI");
	ok(
		notified.some(
			(n) => n.msg === "Usage: /pna <file.md | folder/ | https://...>" && n.type === "error",
		),
		"应发 Usage 错误通知",
	);
});

test("/pna 用户显式设置 PLANNOTATOR_AI 时尊重用户值", async () => {
	const { scratch, stubLog } = setupScratch();
	process.env.PLANNOTATOR_AI = "auto";
	const pi = makePi();
	plannotatorCli(pi);
	command(pi, "pna").handler("docs.md", makeCtx(scratch, [], []));
	await waitFor(() => existsSync(stubLog));
	assertStubLog(readFileSync(stubLog, "utf8"), "env PLANNOTATOR_AI=auto");
});

// ============================================================================
// 用例 10-16: /pnl
// ============================================================================

test("/pnl: annotate-last --stdin --json + stdin 内容为提取文本", async () => {
	const { scratch, stubLog } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	const entries = [msg("assistant", [{ type: "text", text: "last reply" }])];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, notified));

	await waitFor(() => existsSync(stubLog));
	const log = readFileSync(stubLog, "utf8");
	assertStubLog(log, "arg=annotate-last", "arg=--stdin", "arg=--json");
	ok(
		notified.some((n) => n.msg === "Opening annotation UI for last message..." && n.type === "info"),
		"应发 info 通知",
	);
	// 无临时文件：消息内容直接经 stdin 传入
	await waitFor(() => existsSync(stdinFile(scratch)));
	equal(readFileSync(stdinFile(scratch), "utf8"), "last reply");
});

test("/pnl string content 直接写入 stdin", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const pi = makePi();
	plannotatorCli(pi);
	command(pi, "pnl").handler(
		undefined,
		makeCtx(scratch, [msg("assistant", "plain string")], []),
	);
	await waitFor(() => existsSync(stdinFile(scratch)));
	equal(readFileSync(stdinFile(scratch), "utf8"), "plain string");
});

test("/pnl 数组 content 按行拼接", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const pi = makePi();
	plannotatorCli(pi);
	command(pi, "pnl").handler(
		undefined,
		makeCtx(scratch, [msg("assistant", ["part1", "part2"])], []),
	);
	await waitFor(() => existsSync(stdinFile(scratch)));
	equal(readFileSync(stdinFile(scratch), "utf8"), "part1\npart2");
});

test("/pnl 对象 {text} content", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const pi = makePi();
	plannotatorCli(pi);
	command(pi, "pnl").handler(
		undefined,
		makeCtx(scratch, [msg("assistant", { text: "obj text" })], []),
	);
	await waitFor(() => existsSync(stdinFile(scratch)));
	equal(readFileSync(stdinFile(scratch), "utf8"), "obj text");
});

test("/pnl 跳过 user 与空 assistant，取最后非空", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const pi = makePi();
	plannotatorCli(pi);
	const entries = [msg("user", "hi"), msg("assistant", "  "), msg("assistant", "real")];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, []));
	await waitFor(() => existsSync(stdinFile(scratch)));
	equal(readFileSync(stdinFile(scratch), "utf8"), "real");
});

test("/pnl 无 getBranch 时走 getEntries 兜底", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const pi = makePi();
	plannotatorCli(pi);
	const entries = [msg("user", "x"), msg("assistant", "from-fallback")];
	command(pi, "pnl").handler(undefined, makeCtxNoBranch(scratch, entries, []));
	await waitFor(() => existsSync(stdinFile(scratch)));
	equal(readFileSync(stdinFile(scratch), "utf8"), "from-fallback");
});

test("/pnl 无 assistant 消息: 错误通知且无副作用", async () => {
	const { scratch, stubLog } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const ui = makeUi();
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	const entries = [msg("user", "only user")];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, notified, ui));
	await expectNothingHappens();

	equal(existsSync(stubLog), false, "不应 spawn CLI");
	equal(existsSync(stdinFile(scratch)), false, "不应产生 stdin 文件");
	equal(ui.selects.length, 0, "零条可选消息不应弹选择器");
	ok(
		notified.some((n) => n.msg === "No assistant message found in session." && n.type === "error"),
		"应发错误通知",
	);
});

// ── /pnl 消息选择器（#82）────────────────────────────────────────────────

test("/pnl 多条消息: 选项倒序 + label 摘要 + 字符数 + initialIndex 0", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const ui = makeUi();
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	const entries = [
		msg("user", "用户提问"),
		msg("assistant", "# 设计说明\n第二行"),
		msg("assistant", "短回复"),
	];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, notified, ui));

	await waitFor(() => ui.selects.length === 1);
	const call = ui.selects[0];
	equal(call.title, "Select an assistant message to annotate");
	deepStrictEqual(call.dialogOptions, { initialIndex: 0 });
	deepStrictEqual(call.options, [
		{ label: "倒数第 1 条 · 短回复", description: "3 字符" },
		{ label: "倒数第 2 条 · 设计说明", description: "10 字符" },
	]);

	// 默认光标在最新一条：回车（pick 默认回传 options[0]）即旧行为
	await waitFor(() => existsSync(stdinFile(scratch)));
	equal(readFileSync(stdinFile(scratch), "utf8"), "短回复");
	ok(
		notified.some((n) => n.msg === "Opening annotation UI for last message..." && n.type === "info"),
		"选最新一条时通知与旧行为逐字一致",
	);
});

test("/pnl 最多 25 条: 只列最近的 25 条，更早的不出现", async () => {
	const { scratch } = setupScratch();
	const ui = makeUi();
	ui.pick = () => undefined; // 只看选项，取消即可
	const pi = makePi();
	plannotatorCli(pi);
	const entries = [
		msg("assistant", "oldest"),
		...Array.from({ length: 30 }, (_, i) => msg("assistant", `m${i + 1}`)),
	];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, [], ui));

	await waitFor(() => ui.selects.length === 1);
	const options = ui.selects[0].options;
	equal(options.length, 25);
	equal(options[0].label, "倒数第 1 条 · m30");
	equal(options[24].label, "倒数第 25 条 · m6");
	ok(!options.some((o) => o.label.includes("oldest")), "第 26 条起不应出现在列表里");
});

test("/pnl 摘要: 剥离 markdown 噪声并截断到 40 字符", async () => {
	const { scratch } = setupScratch();
	const ui = makeUi();
	ui.pick = () => undefined;
	const pi = makePi();
	plannotatorCli(pi);
	const entries = [
		msg("assistant", "普通"),
		msg("assistant", "## **加粗标题** 与 `code`\n正文"),
		msg("assistant", `# ${"长".repeat(60)}`),
		msg("assistant", "x".repeat(41)),
	];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, [], ui));

	await waitFor(() => ui.selects.length === 1);
	deepStrictEqual(
		ui.selects[0].options.map((o) => o.label),
		[
			`倒数第 1 条 · ${"x".repeat(40)}…`,
			`倒数第 2 条 · ${"长".repeat(40)}…`,
			"倒数第 3 条 · 加粗标题 与 code",
			"倒数第 4 条 · 普通",
		],
	);
});

test("/pnl 摘要雷同: label 靠序号前缀保持唯一", async () => {
	const { scratch } = setupScratch();
	const ui = makeUi();
	ui.pick = () => undefined;
	const pi = makePi();
	plannotatorCli(pi);
	const entries = [msg("assistant", "同样的文本"), msg("assistant", "同样的文本")];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, [], ui));

	await waitFor(() => ui.selects.length === 1);
	const labels = ui.selects[0].options.map((o) => o.label);
	deepStrictEqual(labels, ["倒数第 1 条 · 同样的文本", "倒数第 2 条 · 同样的文本"]);
	equal(new Set(labels).size, labels.length, "label 必须唯一（宿主只回传 label）");
});

test("/pnl 摘要: 词边界外的下划线是标识符不是强调，波浪号是路径不是删除线", async () => {
	const { scratch } = setupScratch();
	const ui = makeUi();
	ui.pick = () => undefined;
	const pi = makePi();
	plannotatorCli(pi);
	const entries = [
		msg("assistant", "~/x 与 _两者_ 都在"),
		msg("assistant", "改 api_key 与 max_retries__x"),
		msg("assistant", "# `a_b` 与 *强调* 混排"),
	];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, [], ui));

	await waitFor(() => ui.selects.length === 1);
	deepStrictEqual(
		ui.selects[0].options.map((o) => o.label),
		[
			"倒数第 1 条 · a_b 与 强调 混排",
			"倒数第 2 条 · 改 api_key 与 max_retries__x",
			"倒数第 3 条 · ~/x 与 两者 都在",
		],
	);
});

test("/pnl 摘要截断按码点: emoji 不被切开成乱码", async () => {
	const { scratch } = setupScratch();
	const ui = makeUi();
	ui.pick = () => undefined;
	const pi = makePi();
	plannotatorCli(pi);
	// 39 个 ASCII + emoji（代理对，UTF-16 下占 2 码元）+ 尾部：按码点截断到 40 时
	// 必须整颗 emoji 保留，UTF-16 slice(0, 40) 会切出半个代理对。
	const emojiLine = `${"x".repeat(39)}🎯尾部不该出现`;
	const entries = [msg("assistant", "另一条"), msg("assistant", emojiLine)];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, [], ui));

	await waitFor(() => ui.selects.length === 1);
	const options = ui.selects[0].options;
	equal(options[0].label, `倒数第 1 条 · ${"x".repeat(39)}🎯…`);
	ok(!options[0].label.includes("�"), "不应出现截断产生的替代字符");
	equal(options[0].description, "46 字符", "字符数按码点计（39 + emoji + 6）");
});

test("/pnl 列表只含非空助手消息（排除 user 与空 assistant）", async () => {
	const { scratch } = setupScratch();
	const ui = makeUi();
	ui.pick = () => undefined;
	const pi = makePi();
	plannotatorCli(pi);
	const entries = [
		msg("user", "用户输入"),
		msg("assistant", "   \n  "),
		msg("assistant", "第一个回复"),
		msg("assistant", ""),
		msg("user", "再问一句"),
		msg("assistant", "第二个回复"),
	];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, [], ui));

	await waitFor(() => ui.selects.length === 1);
	deepStrictEqual(
		ui.selects[0].options.map((o) => o.label),
		["倒数第 1 条 · 第二个回复", "倒数第 2 条 · 第一个回复"],
	);
});

test("/pnl 选中倒数第 3 条: stdin 为该条文本 + 前缀带序号 + 通知带序号", async () => {
	const { scratch, stubLog } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	process.env.PLANNO_STUB_STDOUT = '{"decision":"annotated","feedback":"改这里"}';
	const ui = makeUi();
	ui.pick = (call) => call.options[2]?.label;
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	const entries = [
		msg("assistant", "第一条（最旧）"),
		msg("assistant", "第二条"),
		msg("assistant", "第三条（最新）"),
	];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, notified, ui));

	await waitFor(() => existsSync(stdinFile(scratch)));
	equal(readFileSync(stdinFile(scratch), "utf8"), "第一条（最旧）");
	assertStubLog(readFileSync(stubLog, "utf8"), "arg=annotate-last", "arg=--stdin", "arg=--json");
	ok(
		notified.some(
			(n) => n.msg === "Opening annotation UI for assistant message 3 back..." && n.type === "info",
		),
		"非最新一条的通知应带序号",
	);

	// 反馈前缀：N > 1 时指明序号，仍带"无需查找文件"的说明
	await waitFor(() => pi.sent.length > 0);
	ok(
		pi.sent[0].content.startsWith(
			"这是对倒数第 3 条助手消息的标注反馈，请直接处理，无需查找文件。",
		),
		"应带带序号的 framing 前缀",
	);
	ok(pi.sent[0].content.endsWith("改这里"), "前缀后应跟反馈正文");
});

test("/pnl Esc 取消: 不 spawn、不投递、无通知", async () => {
	const { scratch, stubLog } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const ui = makeUi();
	ui.pick = () => undefined; // Esc
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	const entries = [msg("assistant", "旧"), msg("assistant", "新")];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, notified, ui));

	await waitFor(() => ui.selects.length === 1);
	await expectNothingHappens();

	equal(existsSync(stubLog), false, "不应 spawn CLI");
	equal(existsSync(stdinFile(scratch)), false, "不应产生 stdin 文件");
	equal(pi.sent.length, 0, "不应投递");
	equal(notified.length, 0, "取消应静默");
});

test("/pnl 仅一条可选消息: 跳过选择器直接标注最后一条", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const ui = makeUi();
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	const entries = [msg("user", "问"), msg("assistant", "唯一回复")];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, notified, ui));

	await waitFor(() => existsSync(stdinFile(scratch)));
	equal(readFileSync(stdinFile(scratch), "utf8"), "唯一回复");
	equal(ui.selects.length, 0, "只有一条可选消息时不应弹选择器");
	ok(
		notified.some((n) => n.msg === "Opening annotation UI for last message..." && n.type === "info"),
		"应发与旧行为逐字一致的 info 通知",
	);
});

test("/pnl 无 UI 的宿主（hasUI=false）: 报错且不 spawn、不弹选择器", async () => {
	const { scratch, stubLog } = setupScratch();
	process.env.PLANNO_STUB_STDIN_FILE = stdinFile(scratch);
	const ui = makeUi(false);
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	const entries = [msg("assistant", "旧"), msg("assistant", "新")];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, notified, ui));
	await expectNothingHappens();

	equal(existsSync(stubLog), false, "不应 spawn CLI");
	equal(ui.selects.length, 0, "无 UI 时不应调用 select");
	equal(pi.sent.length, 0, "不应投递");
	ok(
		notified.some(
			(n) =>
				n.msg === "/pnl requires an interactive terminal (no UI available in this session)." &&
				n.type === "error",
		),
		"应发无 UI 错误通知",
	);
});

// ============================================================================
// 用例 17-24: 反馈回路与失败路径
// ============================================================================

test("stdout 反馈 -> sendUserMessage 直接发送（省略 deliverAs，空闲即触发回合）", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDOUT = "请修复 X";
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	command(pi, "pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() => pi.sent.length > 0);
	// 不带 deliverAs：若带 "followUp"，omp 只入队不启动回合，反馈会静默滞留到
	// 下一条显式输入（实测缺陷）；省略后空闲路径直接 prompt() 触发回合。
	deepStrictEqual(pi.sent[0], { content: "请修复 X", opts: undefined });
	ok(!notified.some((n) => n.type === "error"), "不应有错误通知");
});

test("/pnl 反馈投递: 前缀说明这是对上一条助手消息的反馈", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDOUT = "请修复 X";
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	const entries = [msg("assistant", "last reply")];
	command(pi, "pnl").handler(undefined, makeCtx(scratch, entries, notified));

	await waitFor(() => pi.sent.length > 0);
	// 反馈必须带 framing 前缀：明确告诉 AI 这是对它上一条消息的标注反馈，
	// 而非让 AI 对着一个不存在的文件猜"文件在哪"。
	ok(
		pi.sent[0].content.startsWith(
			"这是对你上一条助手消息的标注反馈，请直接处理，无需查找文件。",
		),
		"应带 framing 前缀",
	);
	ok(pi.sent[0].content.endsWith("请修复 X"), "前缀后应跟反馈正文");
});

test("json 完整即投递: stdout 有完整 JSON 但进程挂起时不等 exited", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDOUT = '{"decision":"annotated","feedback":"json 完整即投递"}';
	process.env.PLANNO_STUB_HANG = "1"; // 输出 JSON 后挂起（关闭期挂起模拟）
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	command(pi, "pna").handler("docs.md", makeCtx(scratch, [], notified));

	// 不等 exited：JSON 一完整反馈立即投递
	await waitFor(() => pi.sent.length > 0, 2000);
	deepStrictEqual(pi.sent[0], { content: "json 完整即投递", opts: undefined });
	ok(!notified.some((n) => n.type === "error"), "不应有错误通知");
});

test("挂起时非 JSON stdout 走超时兜底投递", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_STDOUT = "部分反馈文本"; // 非 JSON（/pnr 纯文本场景）
	process.env.PLANNO_STUB_HANG = "1";
	process.env.PLANNOTATOR_FEEDBACK_TIMEOUT_MS = "200";
	const pi = makePi();
	plannotatorCli(pi);
	command(pi, "pnr").handler(undefined, makeCtx(scratch, [], []));

	// timeout 兜底：stdout 已有内容（关闭期挂起场景），kill 后仍投递
	await waitFor(() => pi.sent.length > 0, 3000);
	deepStrictEqual(pi.sent[0], { content: "部分反馈文本", opts: undefined });
});

test("超时无输出: error 通知提示重试", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_HANG = "1"; // 无 stdout 挂起
	process.env.PLANNOTATOR_FEEDBACK_TIMEOUT_MS = "200";
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	command(pi, "pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() => notified.some((n) => n.type === "error"), 3000);
	ok(
		notified.some(
			(n) =>
				n.msg ===
					"Annotation timed out waiting for feedback (plannotator may have hung). Please retry." &&
				n.type === "error",
		),
		"应发超时错误通知",
	);
	equal(pi.sent.length, 0, "无反馈不应投递");
});

test("CLI 非零退出且无 stdout: failed 通知（含 stderr）", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_EXIT = "1";
	process.env.PLANNO_STUB_STDERR = "boom";
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	command(pi, "pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() => notified.some((n) => n.type === "error"), 3000);
	ok(
		notified.some((n) => n.msg === "Annotation failed: boom" && n.type === "error"),
		"应发 failed 错误通知（含 stderr）",
	);
	equal(pi.sent.length, 0, "无反馈不应投递");
});

test("CLI 非零退出且无 stdout 无 stderr: failed 通知（exit code）", async () => {
	const { scratch } = setupScratch();
	process.env.PLANNO_STUB_EXIT = "3";
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	command(pi, "pna").handler("docs.md", makeCtx(scratch, [], notified));

	await waitFor(() => notified.some((n) => n.type === "error"), 3000);
	ok(
		notified.some((n) => n.msg === "Annotation failed: exit code 3" && n.type === "error"),
		"应发 failed 错误通知（exit code）",
	);
});

test("正常退出无反馈: closed (no feedback) info 通知", async () => {
	const { scratch } = setupScratch();
	const pi = makePi();
	plannotatorCli(pi);
	const notified: Notice[] = [];
	command(pi, "pna").handler("docs.md", makeCtx(scratch, [], notified));

	// Opening 通知也是 info，需精确匹配 closed 消息
	await waitFor(
		() => notified.some((n) => n.msg === "Annotation closed (no feedback)."),
		3000,
	);
	ok(
		notified.some((n) => n.msg === "Annotation closed (no feedback)." && n.type === "info"),
		"应发 closed 通知",
	);
	equal(pi.sent.length, 0, "无反馈不应投递");
});

// ── resolveFeedbackTimeoutMs: 默认值与 env 解析（回归保护：防 120s 默认值再现）──

/** 临时设置环境变量，测试后恢复原值（含未设状态）。 */
function withEnv(name: string, value: string | undefined, fn: () => void): void {
	const saved = process.env[name];
	try {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		fn();
	} finally {
		if (saved !== undefined) process.env[name] = saved;
		else delete process.env[name];
	}
}

test("resolveFeedbackTimeoutMs: 未设 env 回退默认 30min", () => {
	withEnv("PLANNOTATOR_FEEDBACK_TIMEOUT_MS", undefined, () => {
		equal(resolveFeedbackTimeoutMs(), 30 * 60 * 1000);
	});
});

test("resolveFeedbackTimeoutMs: 合法 env 值透传", () => {
	withEnv("PLANNOTATOR_FEEDBACK_TIMEOUT_MS", "45000", () => {
		equal(resolveFeedbackTimeoutMs(), 45000);
	});
});

test("resolveFeedbackTimeoutMs: 非法 env（非数字 / 空白）回退默认", () => {
	for (const bad of ["abc", "", "   "]) {
		withEnv("PLANNOTATOR_FEEDBACK_TIMEOUT_MS", bad, () => {
			equal(resolveFeedbackTimeoutMs(), 30 * 60 * 1000, `非法值 ${JSON.stringify(bad)} 应回退默认`);
		});
	}
});

test("resolveFeedbackTimeoutMs: 0 / 负数 / NaN / Infinity 回退默认", () => {
	for (const bad of ["0", "-5", "NaN", "Infinity"]) {
		withEnv("PLANNOTATOR_FEEDBACK_TIMEOUT_MS", bad, () => {
			equal(resolveFeedbackTimeoutMs(), 30 * 60 * 1000, `非法值 ${JSON.stringify(bad)} 应回退默认`);
		});
	}
});