import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { FileFinderApi, InitOptions, Result } from "@ff-labs/fff-node";

export const SCAN_TIMEOUT_MS = 15_000;

/** OMP can run either under node or bun, we resolve correct SDK version at runtime */
export type FileFinderStatic = {
  create(options: InitOptions): Result<FileFinderApi>;
};

let sdkPromise: Promise<{ FileFinder: FileFinderStatic }> | null = null;

function detectRuntime(): "bun" | "node" {
  const g = globalThis as Record<string, unknown>;
  if (g !== null && typeof g === "object" && "Bun" in g && typeof g.Bun !== "undefined") return "bun";
  if (typeof process !== "undefined" && process !== null && typeof process === "object" && "versions" in process) {
    const versionsRaw = (process as Record<string, unknown>).versions;
    if (versionsRaw !== null && typeof versionsRaw === "object" && "bun" in (versionsRaw as Record<string, unknown>)) {
      const bunVer = (versionsRaw as Record<string, unknown>).bun;
      if (typeof bunVer === "string" && bunVer.length > 0) return "bun";
    }
  }
  return "node";
}

function getPluginRoot(): string {
  // import.meta.dir is Bun-specific; platform cannot be known at build time
  try {
    const meta = import.meta as unknown as { dir?: string; url?: string };
    if (typeof meta.dir === "string" && meta.dir.length > 0) return path.resolve(meta.dir, "..");
    if (typeof meta.url === "string") return path.resolve(path.dirname(new URL(meta.url).pathname), "..");
  } catch {}
  // jiti exposes __dirname as global property
  try {
    const g = globalThis as Record<string, unknown>;
    if ("__dirname" in g && typeof g.__dirname === "string" && g.__dirname.length > 0) return path.resolve(g.__dirname, "..");
  } catch {}
  try {
    // Direct __dirname reference for CJS shims (jiti)
    const d: unknown = typeof __dirname !== "undefined" ? __dirname : undefined;
    if (typeof d === "string" && d.length > 0) return path.resolve(d, "..");
  } catch {}
  return process.cwd();
}

async function ensureDepsInstalled(): Promise<void> {
  const pluginRoot = getPluginRoot();
  // Fast-path: already installed
  try {
    const marker = path.join(pluginRoot, "node_modules", "@ff-labs", "fff-bun", "package.json");
    if (fs.existsSync(marker)) return;
    const marker2 = path.join(pluginRoot, "node_modules", "@ff-labs", "fff-node", "package.json");
    if (fs.existsSync(marker2)) return;
  } catch {}
  const pkgPath = path.join(pluginRoot, "package.json");
  try {
    if (!fs.existsSync(pkgPath)) return;
  } catch {
    return;
  }
  try {
    // Bun.spawn is only available when OMP runs on Bun; use unchecked cast with reason: Bun type not in lib dom
    const bunGlobal = (globalThis as Record<string, unknown>).Bun as unknown as
      | { spawn: (cmd: string[], opts: unknown) => { exited: Promise<number> } }
      | undefined;
    if (bunGlobal?.spawn) {
      const proc = bunGlobal.spawn(["bun", "install", "--ignore-scripts"], {
        cwd: pluginRoot,
        stdout: "pipe",
        stderr: "pipe",
      } as unknown as Record<string, unknown>);
      await proc.exited;
      return;
    }
  } catch {}
  try {
    spawnSync("bun", ["install", "--ignore-scripts"], { cwd: pluginRoot, stdio: "ignore", timeout: 30_000 });
  } catch {}
}

export function loadSdk(): Promise<{ FileFinder: FileFinderStatic }> {
  if (sdkPromise) return sdkPromise;

  // OMP reloads extension modules with jiti moduleCache:false, so this module
  // is re-executed on every /reload. Re-importing the fff-bun module graph
  // (which top-level awaits a `type: "file"` import of the native .so) hangs
  // forever inside the Bun-compiled binary. Cache the first import on
  // globalThis so reloads reuse the resolved module instead of re-importing.
  const g = globalThis as Record<string, unknown>;
  if (g.__fffSdkPromiseGlobal) {
    sdkPromise = g.__fffSdkPromiseGlobal as Promise<{ FileFinder: FileFinderStatic }>;
    return sdkPromise;
  }

  // Runtime selects bun vs node native binding; static import cannot know which at build time
  const pkg = detectRuntime() === "bun" ? "@ff-labs/fff-bun" : "@ff-labs/fff-node";
  // Dynamic import required: platform-specific native module that may not exist in current runtime
  const firstImport = import(pkg) as Promise<{ FileFinder: FileFinderStatic }>;
  const p: Promise<{ FileFinder: FileFinderStatic }> = firstImport.catch(async (err: unknown) => {
    const msg =
      err !== null && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string"
        ? (err as { message: string }).message
        : String(err);
    const isMissing = msg.includes("Cannot find package") || msg.includes("Cannot find module") || msg.includes("Cannot resolve");
    if (!isMissing) throw err;
    await ensureDepsInstalled();
    // Retry after install – same runtime-selected specifier
    return import(pkg) as Promise<{ FileFinder: FileFinderStatic }>;
  });
  sdkPromise = p;
  (globalThis as Record<string, unknown>).__fffSdkPromiseGlobal = p;
  return p;
}
