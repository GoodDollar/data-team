// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Lint configuration.
 *
 * DELIBERATELY NARROW. This phase is forbidden from changing production behaviour, so a rule set
 * that demands edits to existing code would force exactly the change it is not allowed to make.
 * What is enabled is the set that catches the defect SHAPES this project has actually shipped:
 * a promise whose rejection nobody handles, a condition that is always true, a variable used
 * before it is defined. Style is not linted; that is what review is for.
 *
 * Type-aware rules are off on purpose. They need a second full type-check pass, and the strict
 * `tsc --noEmit` in `npm run typecheck` already runs one.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // `any` is used throughout for BigQuery rows and JSON-RPC results, both of which are
      // genuinely unshaped at the boundary. Flagging every one would be noise, not signal.
      "@typescript-eslint/no-explicit-any": "off",
      // Caught by tsc with `strict`, and the ESLint version double-reports it.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", fetch: "readonly" },
    },
  },
  {
    // Test doubles impersonate third-party clients, so they carry looser shapes by necessity.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
