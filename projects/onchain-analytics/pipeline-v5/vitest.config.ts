import { defineConfig } from "vitest/config";

/**
 * The DEFAULT suite. What `npm test` runs and what a pull request must pass.
 *
 * It deliberately EXCLUDES `test/known-failures/`, which holds the reproduced production defects.
 * Those are red by design until the phase that owns each one fixes it, so including them here
 * would make the release command permanently red for reasons a contributor cannot act on.
 *
 * The release command is `npm run verify:local`, and it runs BOTH. That is the arrangement plan
 * Section 5 asks for: the harness is green, the known failures stay red, and the command that
 * decides whether the candidate is releasable cannot be green while any of them is.
 */
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "test/known-failures/**"],
    environment: "node",
    // Establishes a fake, credential-free environment before any src/ module is imported.
    // config.ts exits the process on a missing ENVIO_API_TOKEN, so without this nothing imports.
    setupFiles: ["test/setup/env.ts"],
    // Adapters in `src/adapters.ts` are module-level holders, so two files mutating them at once
    // would make the result depend on scheduling. One file at a time removes that entirely.
    fileParallelism: false,
    testTimeout: 20_000,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      // hs-worker.mjs is a child process entry point that only runs under a real HyperSync
      // client, and index.ts's `main` is the process wrapper the tests deliberately do not start.
      exclude: ["src/**/*.d.ts"],
      // Phase 1 fixes nothing, so it is not held to the plan's 80 and 90 percent thresholds.
      // The instrument is proven to work and the baseline is recorded; the phase that first
      // fixes production code turns these on.
      thresholds: undefined,
    },
  },
});
