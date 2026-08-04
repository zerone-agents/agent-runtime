/**
 * Filesystem skill scanner.
 *
 * Thin wrapper around the SDK's `loadSkillsFromFilesystem` — runtime does NOT
 * implement its own scanning logic. This is intentional: the SDK owns the
 * directory conventions (~/.agents/skills/, <cwd>/.agents/skills/, recursive
 * glob, frontmatter parsing, variable substitution), and any divergence here
 * would cause the runtime's per-agent view to disagree with what the agent
 * actually loads at run time.
 *
 * Used by the registry to populate the `availableSkills` field of the agent
 * detail endpoint, giving multi-agent deployments a per-agent view that the
 * SDK's process-global registry cannot provide (the SDK's registry is polluted
 * by whichever agent happens to be created first).
 */

import {
  loadSkillsFromFilesystem,
  SkillRegistry,
  type SettingSource,
} from "@zerone-agent/agent-sdk"

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
  settingSources?: Array<"user" | "project">
  extraUserSkillDirs?: string[]
  extraProjectSkillDirs?: string[]
}

/**
 * Scan filesystem for SKILL.md files via the SDK's loader.
 * Returns one SkillSummary per unique skill name (collisions resolved by the
 * SDK's load order — last write wins).
 */
export async function scanSkills(opts: ScanOptions): Promise<SkillSummary[]> {
  if (!opts.settingSources || opts.settingSources.length === 0) return []

  const registry = new SkillRegistry()
  const result = await loadSkillsFromFilesystem(
    opts.cwd,
    opts.settingSources as SettingSource[],
    {
      extraUserSkillDirs: opts.extraUserSkillDirs,
      extraProjectSkillDirs: opts.extraProjectSkillDirs,
    },
    registry,
  )
  if (result.errors.length > 0) {
    console.error(`[skill-scan] ${result.errors.length} error(s):`, result.errors)
  }

  return registry
    .getAll()
    .filter((s) => s.source === "user" || s.source === "project")
    .map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source as "user" | "project",
      location: s.location ?? "",
    }))
}
