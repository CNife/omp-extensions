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

export function pluginDirNames(): string[] {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
