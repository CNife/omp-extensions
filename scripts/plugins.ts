/** 插件目录的共同读取逻辑：check.ts 与 smoke.ts 都从 plugins/ 现读清单，不缓存。 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const PLUGINS_DIR = join(ROOT, "plugins");

export interface PluginManifest {
  name?: string;
  version?: string;
  omp?: { extensions?: string[]; skills?: string[] };
}

export interface Plugin {
  name: string;
  dir: string;
  manifest: PluginManifest;
  extensionEntries: string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** 有 package.json 的插件目录（无 package.json 的残留目录另行告警）。 */
export function plugins(): Plugin[] {
  const found: Plugin[] = [];
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(PLUGINS_DIR, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const dir = join(PLUGINS_DIR, entry.name);
    const manifest = readJson<PluginManifest>(manifestPath);
    found.push({ name: entry.name, dir, manifest, extensionEntries: manifest.omp?.extensions ?? [] });
  }
  return found;
}

/** plugins/ 下的所有目录名（含没有 package.json 的残留目录）。 */
export function pluginDirNames(): string[] {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
