import { defineConfig } from "vitest/config";

/**
 * The KNOWN-FAILURES suite. Every reproduced production defect, as an executable test.
 *
 * EVERY TEST IN HERE IS EXPECTED TO FAIL, and that is the point. Each one names the finding it
 * reproduces, the source line that causes it and the phase that owns the fix. None of them is
 * skipped, none is marked `todo`, and none is wrapped in an expectation that inverts it, because
 * a suite that passes while the defect is present proves nothing.
 *
 * A test leaves this suite when the phase that owns it makes it pass, at which point it moves to
 * `test/unit` or `test/integration` and travels with the fix. Until then the release command sees
 * this suite fail and refuses to call the candidate releasable.
 */
export default defineConfig({
  test: {
    include: ["test/known-failures/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    environment: "node",
    setupFiles: ["test/setup/env.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    reporters: ["default"],
  },
});
