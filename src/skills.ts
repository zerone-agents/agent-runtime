/**
 * Filesystem skill scanner.
 *
 * Walks the same directories the SDK's `loadSkillsFromFilesystem` does, but
 * read-only — returns metadata about each discovered SKILL.md without
 * touching the SDK's global skill registry. This gives the runtime a per-agent
 * view of available skills, which the SDK's global registry cannot provide in
 * multi-agent deployments.
 *
 * Directory conventions (must match SDK):
 *   - `settingSources: ["user"]`    → ~/.openagent/skills/ + extraUserSkillDirs
 *   - `settingSources: ["project"]` → <cwd>/.openagent/skills/ + extraProjectSkillDirs
 *   - `settingSources: ["local"]`   → SDK type allows but loader is a no-op; we mirror.
 *
 * Load order: later entries override earlier ones on name collisions (same as
 * SDK registry semantics).
 */

import { readdir, readFile } from "node:fs/promises"
import { existsSync, statSync, type Dirent } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface SkillSummary {
  name: string
  description: string
  /** Which setting-source level this skill was discovered at. */
  source: "user" | "project"
  /** Absolute path to the SKILL.md file. */
  location: string
}

export interface ScanOptions {
  cwd: string
  settingSources?: Array<"user" | "project" | "local">
  extraUserSkillDirs?: string[]
  extraProjectSkillDirs?: string[]
}

/**
 * Scan filesystem for SKILL.md files based on the agent's skill config.
 * Returns one SkillSummary per unique skill name (collisions resolved by
 * "last write wins" in scan order).
 */
export async function scanSkills(opts: ScanOptions): Promise<SkillSummary[]> {
  const sources = opts.settingSources ?? []
  if (sources.length === 0) return []

  const collected: SkillSummary[] = []

  // User-level first (~/.openagent/skills/ + extras) — matches SDK order.
  if (sources.includes("user")) {
    const userDir = join(homedir(), ".openagent", "skills")
    collected.push(...(await scanSkillsDir(userDir, "user")))
    for (const dir of opts.extraUserSkillDirs ?? []) {
      collected.push(...(await scanSkillsDir(dir, "user")))
    }
  }

  // Project-level (<cwd>/.openagent/skills/ + extras).
  if (sources.includes("project")) {
    const projectDir = join(opts.cwd, ".openagent", "skills")
    collected.push(...(await scanSkillsDir(projectDir, "project")))
    for (const dir of opts.extraProjectSkillDirs ?? []) {
      collected.push(...(await scanSkillsDir(dir, "project")))
    }
  }

  // "local" is a defined SettingSource in SDK types but the SDK loader does
  // not implement it. We mirror that: no scan for "local".

  // Dedupe by name — later entries override earlier (matches SDK registry).
  const byName = new Map<string, SkillSummary>()
  for (const skill of collected) {
    byName.set(skill.name, skill)
  }
  return Array.from(byName.values())
}

async function scanSkillsDir(
  dir: string,
  source: "user" | "project",
): Promise<SkillSummary[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err: any) {
    // Silently skip missing/unreadable dirs (matches SDK behaviour).
    if (err.code === "ENOENT") return []
    if (err.code === "EACCES") return []
    throw err
  }

  const results: SkillSummary[] = []
  for (const entry of entries) {
    if (!isDirOrSymlinkToDir(join(dir, entry.name), entry)) continue
    const skillPath = join(dir, entry.name, "SKILL.md")
    try {
      const summary = await parseSkillFile(skillPath, dir, entry.name, source)
      results.push(summary)
    } catch {
      // Skip malformed SKILL.md silently — matches SDK's "collect errors, continue".
    }
  }
  return results
}

function isDirOrSymlinkToDir(p: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink()) {
    try {
      return existsSync(p) && statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  return false
}

/**
 * Parse a SKILL.md file's YAML frontmatter. Only extracts the fields we need
 * (name + description). Mirrors SDK's lightweight YAML parser for these two
 * fields; ignores arrays/booleans/etc. which SDK supports for other fields.
 */
async function parseSkillFile(
  skillPath: string,
  baseDir: string,
  dirName: string,
  source: "user" | "project",
): Promise<SkillSummary> {
  const content = await readFile(skillPath, "utf-8")
  const normalized = content.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "")
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) {
    throw new Error(`Invalid SKILL.md format: missing frontmatter in ${skillPath}`)
  }

  const fm = match[1]
  const description = extractYamlScalar(fm, "description")
  if (!description) {
    throw new Error(`SKILL.md must have a description field: ${skillPath}`)
  }

  const explicitName = extractYamlScalar(fm, "name")
  const name = explicitName ?? dirName

  return {
    name,
    description,
    source,
    location: skillPath,
  }
}

/**
 * Extract a single-line scalar value from YAML frontmatter.
 * Strips surrounding quotes if present. Returns undefined if the key is
 * missing or the value is empty (which in YAML signals an array start).
 */
function extractYamlScalar(yaml: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:[ \\t]*(.+?)$`, "m")
  const m = yaml.match(re)
  if (!m) return undefined
  const raw = m[1].trim()
  if (raw === "") return undefined
  // Strip surrounding single/double quotes.
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1)
  }
  return raw
}
