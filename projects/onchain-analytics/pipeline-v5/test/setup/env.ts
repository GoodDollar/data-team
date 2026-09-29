/**
 * env.ts -- the test environment, established before any `src/` module is imported.
 *
 * WHY THIS FILE EXISTS. `config.ts` runs `requireEnv("ENVIO_API_TOKEN")` at module scope and calls
 * `process.exit(2)` when it is absent, so importing any module that transitively reaches config
 * kills the test runner before a single assertion runs. That is a fail-fast the pipeline should
 * keep: a scheduled run with no token should die immediately rather than half-ingest. So the
 * environment is supplied here rather than the check being softened in production code.
 *
 * WHY THE VALUES ARE OBVIOUSLY FAKE, AND CHECKED. Phase 1 is bound to consume zero cloud
 * resources and use zero credentials. A test suite that silently picked up a developer's real
 * token or a real GCP project from the ambient environment would violate that without anyone
 * noticing, so this file OVERWRITES those variables unconditionally and then asserts the values
 * in force are the fake ones. If a real credential is present in the environment, this file
 * removes its reach rather than inheriting it.
 *
 * `dotenv` is also neutralised: `config.ts` calls `loadDotenv()` at import, which would read a
 * real `.env` sitting beside the package. Pointing DOTENV_CONFIG_PATH at a file that does not
 * exist makes that call a no-op.
 */

const FAKE = {
  ENVIO_API_TOKEN: "test-token-not-a-credential",
  GCP_PROJECT_ID: "test-project-no-such-project",
  DATASET_ID: "test_dataset_no_such_dataset",
  SLACK_WEBHOOK_URL: "",
  LOG_FILE: "",
  // Pacing to zero. These exist to be polite to real endpoints; no test reaches one, and the
  // real defaults would add minutes of sleep to a suite that makes no network call.
  RPC_PAUSE_MS: "0",
  HS_CHUNK_PAUSE_MS: "0",
  BQ_RETRIES: "1",
  HYPERSYNC_RETRIES: "1",
} as const;

process.env.DOTENV_CONFIG_PATH = "test/setup/.env.absent-on-purpose";

for (const [key, value] of Object.entries(FAKE)) {
  process.env[key] = value;
}

// Credentials that would let something reach Google Cloud by accident. Removed, not overwritten,
// because an empty string is a value the client libraries will still try to use.
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]) {
  delete process.env[key];
}

if (process.env.ENVIO_API_TOKEN !== FAKE.ENVIO_API_TOKEN) {
  throw new Error("TEST_ENV_NOT_ISOLATED: the fake environment did not take effect");
}

/**
 * No test reaches the network. This is the control that says so rather than the comment.
 *
 * `globalThis.fetch` is replaced with one that throws. Every JSON-RPC call in this pipeline goes
 * through `adapters.getRpcTransport()`, whose real implementation is this function, so a test that
 * forgets to install the wire recorder fails loudly and immediately instead of quietly contacting
 * a public endpoint. The Slack notifier uses `fetch` directly and is caught by the same guard.
 *
 * THE HONEST LIMIT OF THIS GUARD. It covers `fetch` only. The BigQuery client library has its own
 * HTTP stack, and the HyperSync client is a native module driven in a child process, so neither is
 * blocked here. Both are covered instead by construction: no test issues a query against a real
 * BigQuery client, and no test installs a real reader.
 */
const BLOCKED_FETCH = (input: unknown): never => {
  const target = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
  throw new Error(
    `TEST_NETWORK_BLOCKED: a test attempted a real network request to ${target}. ` +
    `Install a wire recorder with setRpcTransport() or a reader with setReaderOverride(). ` +
    `Nothing in this suite is allowed to contact a live endpoint.`
  );
};

globalThis.fetch = BLOCKED_FETCH as unknown as typeof fetch;
