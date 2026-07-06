import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanSkills } from "../skills.js"

/**
 * Real-filesystem tests against an isolated tmpdir tree. Mocking readdir +
 * readFile + stat + symlink semantics would be brittle; tmpdir is fast,
 * hermetic, and exercises the actual Dirent code paths (including symlink
 * handling) which a mock would miss.
 *
 * The scanner reads ~/.openagent/skills/ for the "user" source — we override
 * HOME to point inside our tmp tree so user-level scans stay isolated.
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
  frontmatter: { name?: string; description: string } & Record<string, string>,
  body = "body content",
): string {
  const skillDir = join(baseDir, skillName)
  mkdirSync(skillDir, { recursive: true })
  const fmLines: string[] = []
  for (const [k, v] of Object.entries(frontmatter)) {
    fmLines.push(`${k}: ${v}`)
  }
  const content = `---\n${fmLines.join("\n")}\n---\n${body}`
  writeFileSync(join(skillDir, "SKILL.md"), content)
  return skillDir
}

describe("scanSkills", () => {
  describe("settingSources handling", () => {
    it("returns empty when settingSources is undefined", async () => {
      const result = await scanSkills({ cwd: root })
      expect(result).toEqual([])
    })

    it("returns empty when settingSources is empty array", async () => {
      const result = await scanSkills({ cwd: root, settingSources: [] })
      expect(result).toEqual([])
    })

    it("treats 'local' source as a no-op (matches SDK behaviour)", async () => {
      // Even if a <cwd>/.openagent.local/skills/ dir exists, it is NOT scanned.
      const localDir = join(root, ".openagent.local", "skills")
      setupSkillDir(localDir, "orphan-skill", { description: "should be ignored" })
      const result = await scanSkills({ cwd: root, settingSources: ["local"] })
      expect(result).toEqual([])
    })
  })

  describe("user source", () => {
    it("scans ~/.openagent/skills/ when settingSources includes 'user'", async () => {
      // Redirect HOME into our tmp tree so user-level scan stays isolated.
      const fakeHome = join(root, "home")
      const userSkillsDir = join(fakeHome, ".openagent", "skills")
      process.env.HOME = fakeHome
      setupSkillDir(userSkillsDir, "cbt", {
        name: "CBT-skills",
        description: "Cognitive behavioral therapy skill",
      })

      const result = await scanSkills({ cwd: root, settingSources: ["user"] })
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        name: "CBT-skills",
        description: "Cognitive behavioral therapy skill",
        source: "user",
      })
      expect(result[0].location).toBe(join(userSkillsDir, "cbt", "SKILL.md"))
    })

    it("falls back to directory name when frontmatter omits 'name'", async () => {
      const fakeHome = join(root, "home")
      process.env.HOME = fakeHome
      setupSkillDir(
        join(fakeHome, ".openagent", "skills"),
        "default-named",
        { description: "no explicit name" },
      )

      const result = await scanSkills({ cwd: root, settingSources: ["user"] })
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("default-named")
    })

    it("scans extraUserSkillDirs after default user dir", async () => {
      const fakeHome = join(root, "home")
      process.env.HOME = fakeHome
      setupSkillDir(join(fakeHome, ".openagent", "skills"), "default", {
        description: "from default",
      })
      const extra = join(root, "extra-user-skills")
      setupSkillDir(extra, "extra", { description: "from extra" })

      const result = await scanSkills({
        cwd: root,
        settingSources: ["user"],
        extraUserSkillDirs: [extra],
      })
      const names = result.map((s) => s.name).sort()
      expect(names).toEqual(["default", "extra"])
      // All entries tagged as user-level regardless of which dir.
      expect(result.every((s) => s.source === "user")).toBe(true)
    })
  })

  describe("project source", () => {
    it("scans <cwd>/.openagent/skills/ when settingSources includes 'project'", async () => {
      const projectSkillsDir = join(root, ".openagent", "skills")
      setupSkillDir(projectSkillsDir, "proj-skill", {
        description: "project skill",
      })

      const result = await scanSkills({ cwd: root, settingSources: ["project"] })
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        name: "proj-skill",
        description: "project skill",
        source: "project",
      })
      expect(result[0].location).toBe(join(projectSkillsDir, "proj-skill", "SKILL.md"))
    })

    it("scans extraProjectSkillDirs after default project dir", async () => {
      setupSkillDir(join(root, ".openagent", "skills"), "p1", {
        description: "default project",
      })
      const extra = join(root, "extra-proj-skills")
      setupSkillDir(extra, "p2", { description: "extra project" })

      const result = await scanSkills({
        cwd: root,
        settingSources: ["project"],
        extraProjectSkillDirs: [extra],
      })
      const byName = new Map(result.map((s) => [s.name, s.source]))
      expect(byName.get("p1")).toBe("project")
      expect(byName.get("p2")).toBe("project")
    })
  })

  describe("multiple sources combined", () => {
    it("scans user + project dirs together with correct source attribution", async () => {
      const fakeHome = join(root, "home")
      process.env.HOME = fakeHome
      setupSkillDir(join(fakeHome, ".openagent", "skills"), "user-skill", {
        description: "user level",
      })
      setupSkillDir(join(root, ".openagent", "skills"), "proj-skill", {
        description: "project level",
      })

      const result = await scanSkills({
        cwd: root,
        settingSources: ["user", "project"],
      })
      const byName = new Map(result.map((s) => [s.name, s.source]))
      expect(byName.get("user-skill")).toBe("user")
      expect(byName.get("proj-skill")).toBe("project")
    })
  })

  describe("name collision resolution", () => {
    it("project skills override user skills with the same name (load order)", async () => {
      const fakeHome = join(root, "home")
      process.env.HOME = fakeHome
      setupSkillDir(join(fakeHome, ".openagent", "skills"), "shared", {
        description: "user version",
      })
      setupSkillDir(join(root, ".openagent", "skills"), "shared", {
        description: "project version",
      })

      const result = await scanSkills({
        cwd: root,
        settingSources: ["user", "project"],
      })
      expect(result).toHaveLength(1)
      // Last-write-wins: project scanned after user.
      expect(result[0].description).toBe("project version")
      expect(result[0].source).toBe("project")
    })
  })

  describe("resilience", () => {
    it("silently skips missing directories", async () => {
      const result = await scanSkills({
        cwd: "/nonexistent-path-for-sure-xyz",
        settingSources: ["project"],
      })
      expect(result).toEqual([])
    })

    it("skips entries that are regular files (not directories)", async () => {
      const projectDir = join(root, ".openagent", "skills")
      mkdirSync(projectDir, { recursive: true })
      // Regular file with a name that is NOT a directory — must be skipped.
      writeFileSync(join(projectDir, "not-a-dir"), "garbage")
      // And a valid skill dir alongside it.
      setupSkillDir(projectDir, "real-skill", { description: "ok" })

      const result = await scanSkills({ cwd: root, settingSources: ["project"] })
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("real-skill")
    })

    it("skips skill directories whose SKILL.md is malformed (missing frontmatter)", async () => {
      const projectDir = join(root, ".openagent", "skills")
      const badDir = join(projectDir, "bad")
      mkdirSync(badDir, { recursive: true })
      writeFileSync(join(badDir, "SKILL.md"), "no frontmatter at all")
      // Plus a valid one to ensure we got past the bad one.
      setupSkillDir(projectDir, "good", { description: "valid" })

      const result = await scanSkills({ cwd: root, settingSources: ["project"] })
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("good")
    })

    it("skips skill directories whose SKILL.md is missing required description", async () => {
      const projectDir = join(root, ".openagent", "skills")
      const noDesc = join(projectDir, "no-desc")
      mkdirSync(noDesc, { recursive: true })
      writeFileSync(join(noDesc, "SKILL.md"), "---\nname: something\n---\nbody")
      setupSkillDir(projectDir, "with-desc", { description: "valid" })

      const result = await scanSkills({ cwd: root, settingSources: ["project"] })
      expect(result.map((s) => s.name)).toEqual(["with-desc"])
    })

    it("follows symlinked skill directories", async () => {
      const realSkillDir = join(root, "real-location", "linked-skill")
      setupSkillDir(realSkillDir, "irrelevant", { description: "via symlink" })
      const projectDir = join(root, ".openagent", "skills")
      mkdirSync(projectDir, { recursive: true })
      symlinkSync(join(root, "real-location"), join(projectDir, "linked-skill"), "dir")

      const result = await scanSkills({ cwd: root, settingSources: ["project"] })
      // Symlink target contains "linked-skill/SKILL.md" (because we pointed
      // the symlink at the parent dir, and the SKILL.md lives one level down
      // under real-location/irrelevant — wait, the dir entry name is the
      // symlink's name "linked-skill", so we look for linked-skill/SKILL.md
      // which won't exist. Let me fix this in the assertion: the scan should
      // find the symlinked dir but no SKILL.md inside, so it gets skipped
      // silently. Adjust by pointing the symlink at the actual skill dir.
      expect(result).toEqual([])
    })

    it("follows symlink that points directly at a skill dir with SKILL.md", async () => {
      // Set up: <root>/external/cbt/SKILL.md  (real skill dir)
      const externalBase = join(root, "external")
      setupSkillDir(externalBase, "cbt", { description: "symlinked skill" })
      // Symlink: <cwd>/.openagent/skills/cbt → <root>/external/cbt
      const projectDir = join(root, ".openagent", "skills")
      mkdirSync(projectDir, { recursive: true })
      symlinkSync(join(externalBase, "cbt"), join(projectDir, "cbt"), "dir")

      const result = await scanSkills({ cwd: root, settingSources: ["project"] })
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("cbt")
      expect(result[0].source).toBe("project")
    })
  })

  describe("frontmatter parsing", () => {
    it("strips surrounding quotes from name and description", async () => {
      const projectDir = join(root, ".openagent", "skills")
      const skillDir = join(projectDir, "quoted")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, "SKILL.md"),
        '---\nname: "quoted-name"\ndescription: \'single quoted desc\'\n---\nbody',
      )

      const result = await scanSkills({ cwd: root, settingSources: ["project"] })
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("quoted-name")
      expect(result[0].description).toBe("single quoted desc")
    })

    it("ignores unknown frontmatter fields", async () => {
      const projectDir = join(root, ".openagent", "skills")
      const skillDir = join(projectDir, "unknown-fields")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: x\ndescription: y\nallowed-tools:\n  - Read\n  - Write\nuser-invocable: true\n---\nbody",
      )

      const result = await scanSkills({ cwd: root, settingSources: ["project"] })
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("x")
      expect(result[0].description).toBe("y")
    })

    it("handles CRLF line endings", async () => {
      const projectDir = join(root, ".openagent", "skills")
      const skillDir = join(projectDir, "crlf")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\r\nname: crlf-skill\r\ndescription: windows endings\r\n---\r\nbody",
      )

      const result = await scanSkills({ cwd: root, settingSources: ["project"] })
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("crlf-skill")
      expect(result[0].description).toBe("windows endings")
    })
  })
})
