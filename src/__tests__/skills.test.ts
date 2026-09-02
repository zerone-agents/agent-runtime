import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanSkills, materializeSkills, toSummaries } from "../skills.js"

/**
 * Smoke tests only.
 *
 * Directory conventions, recursive glob, frontmatter parsing, symlink handling
 * and resilience are all covered by the SDK's own test suite. Here we only
 * verify that runtime correctly delegates to the SDK and projects fields into
 * SkillSummary.
 *
 * The SDK reads ~/.agents/skills/ for the "user" source — we override HOME to
 * keep user-level scans isolated from the real user home.
 */

let root: string
let savedHome: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-test-"))
  savedHome = process.env.HOME
})

afterEach(() => {
  if (savedHome !== undefined) process.env.HOME = savedHome
  else delete process.env.HOME
  rmSync(root, { recursive: true, force: true })
})

function setupSkillDir(
  baseDir: string,
  skillName: string,
  frontmatter: { name?: string; description: string; whenToUse?: string },
  body = "body content",
): string {
  const skillDir = join(baseDir, skillName)
  mkdirSync(skillDir, { recursive: true })
  const fmLines: string[] = []
  if (frontmatter.name) fmLines.push(`name: ${frontmatter.name}`)
  fmLines.push(`description: ${frontmatter.description}`)
  // SDK's frontmatter contract (skills/yaml.ts) reads kebab-case keys.
  if (frontmatter.whenToUse) fmLines.push(`when-to-use: ${frontmatter.whenToUse}`)
  writeFileSync(join(skillDir, "SKILL.md"), `---\n${fmLines.join("\n")}\n---\n${body}`)
  return skillDir
}

describe("scanSkills (delegates to SDK loadSkillsFromFilesystem)", () => {
  it("returns empty when settingSources is undefined", async () => {
    const result = await scanSkills({ cwd: root })
    expect(result).toEqual([])
  })

  it("returns empty when settingSources is empty array", async () => {
    const result = await scanSkills({ cwd: root, settingSources: [] })
    expect(result).toEqual([])
  })

  it("scans <cwd>/.agents/skills/ for 'project' source and projects fields", async () => {
    const projectSkillsDir = join(root, ".agents", "skills")
    setupSkillDir(projectSkillsDir, "demo", { description: "demo skill" })

    const result = await scanSkills({ cwd: root, settingSources: ["project"] })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      name: "demo",
      description: "demo skill",
      source: "project",
    })
    expect(result[0].location).toBe(join(projectSkillsDir, "demo", "SKILL.md"))
  })

  it("scans ~/.agents/skills/ for 'user' source", async () => {
    const fakeHome = join(root, "home")
    const userSkillsDir = join(fakeHome, ".agents", "skills")
    process.env.HOME = fakeHome
    setupSkillDir(userSkillsDir, "cbt", {
      name: "CBT",
      description: "user-level skill",
    })

    const result = await scanSkills({ cwd: root, settingSources: ["user"] })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      name: "CBT",
      description: "user-level skill",
      source: "user",
    })
  })
})

describe("materializeSkills (#47: full SkillDefinition[] per agent)", () => {
  it("returns full SkillDefinitions with frontmatter fields", async () => {
    const projectSkillsDir = join(root, ".agents", "skills")
    setupSkillDir(projectSkillsDir, "demo", {
      description: "Demo skill",
      whenToUse: "Use when demoing",
    })

    const defs = await materializeSkills({ cwd: root, settingSources: ["project"] })
    expect(defs.length).toBeGreaterThan(0)
    const demo = defs.find((d) => d.name === "demo")
    expect(demo?.description).toBe("Demo skill")
    expect(demo?.whenToUse).toBe("Use when demoing") // 完整定义，非摘要
    expect(demo?.source).toBe("project")
  })

  it("derives summaries from full definitions via toSummaries", async () => {
    const projectSkillsDir = join(root, ".agents", "skills")
    setupSkillDir(projectSkillsDir, "demo", { description: "Demo skill" })

    const defs = await materializeSkills({ cwd: root, settingSources: ["project"] })
    const summaries = toSummaries(defs)
    expect(summaries.find((s) => s.name === "demo")).toMatchObject({
      name: "demo",
      description: "Demo skill",
      source: "project",
    })
  })

  it("returns [] when settingSources empty", async () => {
    expect(await materializeSkills({ cwd: "/tmp", settingSources: [] })).toEqual([])
  })
})
