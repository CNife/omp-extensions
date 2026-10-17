#!/usr/bin/env bun
/**
 * 机械检查：marketplace 清单一致性 + 技能 frontmatter + 载荷变更必须递增版本。
 *
 * 用法：
 *   bun scripts/check.ts                 只做清单与技能检查
 *   bun scripts/check.ts --base <ref>    额外比对 <ref>...HEAD 的载荷变更（PR / CI）
 *   bun scripts/check.ts --staged        额外比对暂存内容与 HEAD 的载荷变更（pre-commit）
 *
 * 「载荷」= plugins/<name>/ 下任何被 git 跟踪的文件，即安装副本会分发的全部内容
 * （见 GLOSSARY.md）。载荷变更后必须让 package.json 与 marketplace.json 的
 * version 同步严格递增，否则 `omp plugin upgrade` 检测不到更新。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { plugins, pluginDirNames, ROOT } from "./plugins.ts";

const MARKETPLACE_PATH = join(ROOT, ".omp-plugin/marketplace.json");

interface MarketplacePlugin {
  name: string;
  source: string;
  version: string;
}

const errors: string[] = [];
const warnings: string[] = [];

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function checkManifests(): void {
  const marketplace = readJson<{ plugins: MarketplacePlugin[] }>(MARKETPLACE_PATH);
  const registered = new Set<string>();

  for (const entry of marketplace.plugins) {
    const manifestPath = join(resolve(ROOT, entry.source), "package.json");
    if (!existsSync(manifestPath)) {
      errors.push(`清单条目 ${entry.name} 指向的目录没有 package.json：${entry.source}`);
      continue;
    }
    registered.add(entry.name);
    const version = readJson<{ version?: string }>(manifestPath).version;
    if (version !== entry.version) {
      errors.push(
        `${entry.name}: package.json 的 version ${version ?? "(缺失)"} 与 marketplace.json 的 ${entry.version} 不一致`,
      );
    }
  }

  const known = new Set(plugins().map((plugin) => plugin.name));
  for (const name of pluginDirNames()) {
    if (!known.has(name)) {
      warnings.push(`残留目录（无 package.json）：plugins/${name} —— 用 trash 清理，或补上清单条目`);
    } else if (!registered.has(name)) {
      errors.push(`未注册的插件目录：plugins/${name} 有 package.json 却不在 .omp-plugin/marketplace.json`);
    }
  }
}

/** 技能检查：SKILL.md 存在、frontmatter 的 name 等于目录名、description 非空。 */
function checkSkills(): void {
  for (const plugin of plugins()) {
    const skillsDir = join(plugin.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(skillsDir, entry.name, "SKILL.md");
      const label = `plugins/${plugin.name}/skills/${entry.name}`;
      if (!existsSync(skillPath)) {
        errors.push(`${label}: 缺少 SKILL.md`);
        continue;
      }
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(skillPath, "utf8"));
      if (frontmatter === null) {
        errors.push(`${label}: SKILL.md 缺少 frontmatter`);
        continue;
      }
      const name = /^name:[ \t]*(.+)$/m.exec(frontmatter[1])?.[1].trim();
      const description = /^description:[ \t]*([\s\S]*?)(?=\n[a-zA-Z-]+:|$)/m.exec(frontmatter[1])?.[1].trim();
      if (name !== entry.name) {
        errors.push(`${label}: frontmatter name ${name ?? "(缺失)"} 与目录名不一致`);
      }
      if (description === undefined || description === "") {
        errors.push(`${label}: frontmatter description 为空`);
      }
    }
  }
}

/** 逐段数值比较 semver（不能按字符串比：0.10.0 应大于 0.9.0）。 */
function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** 载荷变更的插件必须严格递增 version；比对基准由 --base / --staged 给出。 */
function checkVersions(base: string, staged: boolean): void {
  const changed = git([
    "diff",
    ...(staged ? ["--cached"] : [`${base}...HEAD`]),
    "--name-only",
    "--no-renames",
    "--",
    "plugins",
  ])
    .split("\n")
    .filter((line) => line !== "");

  const manifestPathOf = (name: string) => `plugins/${name}/package.json`;
  const versionAt = (ref: string): string | undefined => {
    try {
      return git(["show", ref]).match(/"version"[ \t]*:[ \t]*"([^"]+)"/)?.[1];
    } catch {
      return undefined; // 该 ref 下没有这个文件（新增插件）
    }
  };
  const parseVersion = (version: string, label: string): [number, number, number] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (match === null) {
      errors.push(`${label}: 版本号无法解析：${version}`);
      return undefined;
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  for (const name of new Set(changed.map((path) => path.split("/")[1]))) {
    const baseVersion = versionAt(`${staged ? "HEAD" : base}:${manifestPathOf(name)}`);
    if (baseVersion === undefined) continue; // 新增插件：清单一致性已覆盖
    const headVersion = staged
      ? versionAt(`:${manifestPathOf(name)}`)
      : readJson<{ version?: string }>(join(ROOT, manifestPathOf(name))).version;
    if (headVersion === undefined) {
      errors.push(`${name}: 载荷变更但读不到 version`);
      continue;
    }
    const before = parseVersion(baseVersion, name);
    const after = parseVersion(headVersion, name);
    if (before === undefined || after === undefined) continue;
    const delta = compareVersion(after, before);
    if (delta === 0) {
      errors.push(`${name}: 载荷变更但 version 未递增（仍为 ${headVersion}），omp plugin upgrade 检测不到更新`);
    } else if (delta < 0) {
      errors.push(`${name}: 载荷变更但 version 回退（${baseVersion} → ${headVersion}）`);
    }
  }
}

const args = process.argv.slice(2);
const staged = args.includes("--staged");
const baseIndex = args.indexOf("--base");
const base = baseIndex === -1 ? undefined : args[baseIndex + 1];
if (baseIndex !== -1 && base === undefined) throw new Error("--base 需要一个 git ref 参数");
if (base !== undefined && staged) throw new Error("--base 与 --staged 互斥");

checkManifests();
checkSkills();
if (base !== undefined || staged) {
  checkVersions(base ?? "HEAD", staged);
}

for (const message of warnings) {
  console.log(`警告: ${message}`);
}
if (errors.length > 0) {
  for (const message of errors) {
    console.error(`错误: ${message}`);
  }
  console.error(`\n机械检查未通过（${errors.length} 项）。`);
  process.exit(1);
}
console.log(`机械检查通过${warnings.length > 0 ? `（${warnings.length} 条警告）` : ""}。`);
