import { defineConfig } from "vitest/config"

/**
 * Keep the test suite scoped to the real project source.
 *
 * Without this, vitest's default inclusion pattern (every test file
 * under the working tree) also scans nested .worktrees/ directories
 * when running from the main checkout, which duplicates every test file
 * — the suite runs twice with shared mocks and filesystem state,
 * producing flaky double-failures. Including only the project's own
 * src tree behaves identically in every working directory (main
 * checkout, worktree, CI alike).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
})