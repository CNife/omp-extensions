#!/usr/bin/env node

// Sync extensions/ and skills/ into ~/.omp/agent/ by per-entry symlink.
//
// extensions/*.ts  -> ~/.omp/agent/extensions/<name>
// skills/<sub>/    -> ~/.omp/agent/skills/<sub>   (directories with SKILL.md)
//
// Never whole-tree replace - local-only files (herdr, dcg-guard) stay put.
// Existing non-symlink targets fail closed (protect local-only files).

import {
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OMP_DIR = join(homedir(), ".omp", "agent");

/**
 * Plan sync actions from the repo's extensions/ and skills/ directories.
 *
 * @param {string} repoRoot
 * @param {string} ompDir  - target ~/.omp/agent
 * @returns {Array<{name: string, type: string, action: string, source?: string, target?: string, reason?: string}>}
 */
export function planSync(repoRoot, ompDir) {
  const plan = [];

  // --- extensions/*.ts ---
  const extDir = join(repoRoot, "extensions");
  if (existsSync(extDir)) {
    for (const entry of readdirSync(extDir, { withFileTypes: true })) {
      const name = entry.name;
      if (name.startsWith(".")) continue;
      const source = join(extDir, name);
      const isFile =
        entry.isFile() ||
        (entry.isSymbolicLink() && statSync(source).isFile());
      if (!isFile || !name.endsWith(".ts")) {
        plan.push({ name: `extensions/${name}`, type: "file", action: "skip", source, reason: "non-.ts" });
        continue;
      }
      plan.push({
        name: `extensions/${name}`,
        type: "extension",
        action: "link",
        source,
        target: join(ompDir, "extensions", name),
      });
    }
  }

  // --- skills/<sub>/ (directories with SKILL.md) ---
  const skillsDir = join(repoRoot, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      const name = entry.name;
      if (name.startsWith(".")) continue;
      const source = join(skillsDir, name);
      const isDir =
        entry.isDirectory() ||
        (entry.isSymbolicLink() && statSync(source).isDirectory());
      if (!isDir || !existsSync(join(source, "SKILL.md"))) {
        plan.push({ name: `skills/${name}`, type: "skill", action: "skip", source, reason: "no SKILL.md" });
        continue;
      }
      plan.push({
        name: `skills/${name}`,
        type: "skill",
        action: "link",
        source,
        target: join(ompDir, "skills", name),
      });
    }
  }

  return plan.sort((a, b) => a.name.localeCompare(b.name));
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isBrokenSymlink(path) {
  try {
    lstatSync(path);
    return !existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Create or refresh a symlink. Fails on non-symlink conflicts.
 */
export function applyLink(item, { dryRun = false } = {}) {
  const { source, target, name } = item;
  ensureDir(dirname(target));

  if (existsSync(target) || isBrokenSymlink(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      const current = resolve(dirname(target), readlinkSync(target));
      if (current === resolve(source)) {
        return { name, action: "link", status: "unchanged", target };
      }
      if (dryRun) {
        return { name, action: "link", status: "would-replace-symlink", from: current, target };
      }
      renameSync(target, `${target}.pre-sync.bak`);
    } else {
      throw new Error(
        `Refusing to overwrite non-symlink ${target}. ` +
          `Move or remove the local-only file, then re-run sync.`,
      );
    }
  }

  if (dryRun) {
    return { name, action: "link", status: "would-create", target };
  }

  symlinkSync(source, target);
  return { name, action: "link", status: "created", target };
}

function parseArgs(argv) {
  const opts = { dryRun: false, ompDir: DEFAULT_OMP_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--omp-dir") opts.ompDir = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/sync.mjs [options]

Sync extensions/ and skills/ into ~/.omp/agent/ (per-entry symlink).

Options:
  --dry-run          Plan only; do not mutate filesystem
  --omp-dir <path>   Override OMP agent dir (default: ~/.omp/agent)
  -h, --help         Show help
`);
}

/**
 * @param {{ompDir?: string, dryRun?: boolean}} opts
 */
export function runSync({ ompDir = DEFAULT_OMP_DIR, dryRun = false } = {}) {
  const plan = planSync(REPO_ROOT, ompDir);
  const results = [];

  if (!dryRun) {
    ensureDir(join(ompDir, "extensions"));
    ensureDir(join(ompDir, "skills"));
  }

  for (const item of plan) {
    if (item.action === "skip") {
      results.push({ name: item.name, action: "skip", reason: item.reason });
      continue;
    }
    if (item.action === "link") {
      results.push(applyLink(item, { dryRun }));
    }
  }

  return { plan, results, dryRun };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  const out = runSync(opts);
  console.log(JSON.stringify(out, null, 2));
  if (out.dryRun) {
    console.error("(dry-run: no changes written)");
  }
}

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirect) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
