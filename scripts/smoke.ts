#!/usr/bin/env bun
/**
 * 本地冒烟：把每个扩展插件的入口用 `omp --no-extensions -e <entry>` 真加载一次。
 *
 * 判定（退出码不可信：加载失败时 omp 仍返回 0，见 docs/adr/0005-extension-smoke-load.md）：
 *   - stdout 出现 rpc ready
 *   - stderr 不含 "Failed to load extension"
 *   - 入口源码里 registerCommand("<字面名>") 的命令名都出现在 available_commands_update 中
 *
 * 需要 PATH 上有 omp；仅技能插件没有可加载的入口，跳过。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { plugins, ROOT } from "./plugins.ts";

const LOAD_FAILURE = "Failed to load extension";
const TIMEOUT_MS = 60_000;

interface LoadResult {
  ok: boolean;
  reason?: string;
}

async function smokeEntry(entryPath: string): Promise<LoadResult> {
  const proc = Bun.spawn(["omp", "--no-extensions", "-e", entryPath, "--mode", "rpc", "--no-ui"], {
    cwd: ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer));

  if (exitCode !== 0) return { ok: false, reason: `omp 退出码 ${exitCode}` };
  if (!stdout.includes('"type":"ready"')) return { ok: false, reason: "stdout 没有 rpc ready" };
  if (stderr.includes(LOAD_FAILURE)) {
    return { ok: false, reason: stderr.split("\n").find((line) => line.includes(LOAD_FAILURE)) ?? LOAD_FAILURE };
  }

  const source = readFileSync(entryPath, "utf8");
  const missing = [...source.matchAll(/registerCommand\(\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((command) => !stdout.includes(`"name":"${command}"`));
  if (missing.length > 0) {
    return { ok: false, reason: `命令未注册：${missing.join(", ")}` };
  }
  return { ok: true };
}

const failures: string[] = [];
let checked = 0;

for (const plugin of plugins()) {
  if (plugin.extensionEntries.length === 0) {
    console.log(`跳过 plugins/${plugin.name}（仅技能插件，无扩展入口）`);
    continue;
  }
  for (const entry of plugin.extensionEntries) {
    const entryPath = resolve(join(plugin.dir, entry));
    const label = `plugins/${plugin.name} ${entry}`;
    if (!existsSync(entryPath)) {
      failures.push(`${label}: 入口文件不存在`);
      console.error(`失败 ${label}: 入口文件不存在`);
      continue;
    }
    const started = Bun.nanoseconds();
    const result = await smokeEntry(entryPath);
    const elapsed = ((Bun.nanoseconds() - started) / 1e6).toFixed(0);
    checked++;
    if (result.ok) {
      console.log(`通过 ${label}（${elapsed}ms）`);
    } else {
      failures.push(`${label}: ${result.reason}`);
      console.error(`失败 ${label}: ${result.reason}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`\n冒烟未通过（${failures.length} 项）。`);
  process.exit(1);
}
console.log(`\n冒烟通过（${checked} 个入口）。`);
